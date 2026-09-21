import { stripVTControlCharacters } from "node:util";

export type ActivityState = "queued" | "running" | "done" | "failed" | "timed_out" | "aborted" | "turn_limit";

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	contextTokens: number;
	cost: number;
	turns: number;
}

export interface ChildActivity {
	agent: string;
	model?: string;
	task: string;
	goal: string;
	reported?: string;
	startedAt?: number;
	deadlineAt?: number;
	endedAt?: number;
	maxTurns?: number;
	state: ActivityState;
	current: string;
	recent: string[];
	usage: UsageSummary;
	streamText?: string;
}

export interface ActivityMetadata {
	task?: string;
	goal?: string;
	startedAt?: number;
	deadlineAt?: number;
	endedAt?: number;
	maxTurns?: number;
}

const MAX_ACTIVITY_CHARS = 100;
export const MAX_RECENT_ACTIVITY = 5;
const OSC_SEQUENCE = /(?:\u001b\]|\u009d)[\s\S]*?(?:\u0007|\u001b\\|\u009c|$)/g;
const STRING_CONTROL_SEQUENCE = /(?:\u001b[PX^_]|[\u0090\u0098\u009e\u009f])[\s\S]*?(?:\u001b\\|\u009c|$)/g;

/** Remove terminal control sequences while preserving ordinary whitespace. */
export function sanitizeTerminalText(value: unknown): string {
	return stripVTControlCharacters(String(value ?? "").replace(OSC_SEQUENCE, "").replace(STRING_CONTROL_SEQUENCE, ""))
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "");
}

export class JsonLineParser {
	private buffer = "";

	push(chunk: string): unknown[] {
		this.buffer += chunk;
		const lines = this.buffer.split("\n");
		this.buffer = lines.pop() ?? "";
		return lines.flatMap((line) => this.parse(line));
	}

	flush(): unknown[] {
		const line = this.buffer;
		this.buffer = "";
		return this.parse(line);
	}

	private parse(line: string): unknown[] {
		if (!line.trim()) return [];
		try {
			return [JSON.parse(line)];
		} catch {
			return [];
		}
	}
}

export function createActivity(agent: string, model = "default", metadata: ActivityMetadata = {}): ChildActivity {
	const task = metadata.task ?? "";
	return {
		agent,
		model,
		task,
		goal: metadata.goal ?? displayGoal(undefined, task),
		startedAt: metadata.startedAt,
		deadlineAt: metadata.deadlineAt,
		endedAt: metadata.endedAt,
		maxTurns: metadata.maxTurns,
		state: "queued",
		current: "queued",
		recent: ["queued"],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, contextTokens: 0, cost: 0, turns: 0 },
	};
}

export function snapshotActivity(activity: ChildActivity): ChildActivity {
	return { ...activity, recent: [...activity.recent], usage: { ...activity.usage } };
}

function oneLine(value: unknown, max = MAX_ACTIVITY_CHARS): string {
	const text = sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
	const characters = [...text];
	if (characters.length <= max) return text;
	return `${characters.slice(0, max).join("")}…`;
}

export function displayGoal(label: unknown, task: unknown): string {
	return oneLine(typeof label === "string" && label.trim() ? label : task);
}

function captureReportedProgress(activity: ChildActivity, message: any): void {
	if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
	const rawText = message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join("\n");
	for (const line of rawText.split(/\r?\n/)) {
		if (!line.startsWith("Progress:")) continue;
		const report = oneLine(line.slice("Progress:".length));
		if (report) activity.reported = report;
	}
}

function setCurrent(activity: ChildActivity, text: string, replaceLast = false): boolean {
	const normalized = oneLine(text);
	if (!normalized) return false;
	activity.current = normalized;
	if (replaceLast && activity.recent.length > 0) {
		activity.recent[activity.recent.length - 1] = normalized;
		return true;
	}
	if (activity.recent[activity.recent.length - 1] !== normalized) {
		activity.recent.push(normalized);
		if (activity.recent.length > MAX_RECENT_ACTIVITY) activity.recent.splice(0, activity.recent.length - MAX_RECENT_ACTIVITY);
	}
	return true;
}

function captureModel(activity: ChildActivity, message: any): void {
	if (message?.role !== "assistant") return;
	const provider = typeof message.provider === "string" ? message.provider.trim() : "";
	const model = typeof message.model === "string" ? message.model.trim() : "";
	if (provider && model) activity.model = `${provider}/${model}`;
	else if (model && !(activity.model ?? "").includes("/")) activity.model = model;
}

function messageText(message: any): string {
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((part: any) => part?.type === "text" && typeof part.text === "string")
		.map((part: any) => part.text)
		.join(" ")
		.trim();
}

function toolArgs(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const record = args as Record<string, unknown>;
	for (const key of ["path", "command", "query", "pattern", "url"]) {
		if (typeof record[key] === "string" && record[key]) return oneLine(record[key], 72);
	}
	try {
		return oneLine(JSON.stringify(args), 72);
	} catch {
		return "";
	}
}

function toolActivity(name: unknown, args: unknown): string {
	const tool = typeof name === "string" && name ? name : "tool";
	const detail = toolArgs(args);
	return detail ? `${tool} ${detail}` : tool;
}

function addUsage(activity: ChildActivity, message: any): void {
	if (message?.role !== "assistant") return;
	activity.usage.turns++;
	const usage = message.usage;
	if (!usage || typeof usage !== "object") return;
	activity.usage.input += Number(usage.input) || 0;
	activity.usage.output += Number(usage.output) || 0;
	activity.usage.cacheRead += Number(usage.cacheRead) || 0;
	activity.usage.cacheWrite += Number(usage.cacheWrite) || 0;
	activity.usage.totalTokens += Number(usage.totalTokens) || 0;
	if (Number(usage.totalTokens) > 0) activity.usage.contextTokens = Number(usage.totalTokens);
	activity.usage.cost += Number(usage.cost?.total) || 0;
}

export function applyActivityEvent(activity: ChildActivity, rawEvent: unknown): ChildActivity {
	if (!rawEvent || typeof rawEvent !== "object") return activity;
	const event = rawEvent as any;

	switch (event.type) {
		case "agent_start":
			activity.state = "running";
			setCurrent(activity, "started");
			break;
		case "turn_start":
			activity.state = "running";
			activity.streamText = "";
			setCurrent(activity, "thinking");
			break;
		case "message_start":
			captureModel(activity, event.message);
			break;
		case "message_update": {
			activity.state = "running";
			captureModel(activity, event.message);
			const update = event.assistantMessageEvent;
			if (update?.type === "text_delta" && typeof update.delta === "string") {
				const continuingStream = !!activity.streamText;
				const streamText = `${activity.streamText ?? ""}${update.delta}`.slice(-300);
				activity.streamText = setCurrent(activity, streamText, continuingStream) ? streamText : "";
			} else if (update?.type === "toolcall_end" && update.toolCall) {
				activity.streamText = "";
				setCurrent(activity, toolActivity(update.toolCall.name, update.toolCall.arguments));
			}
			break;
		}
		case "tool_execution_start":
			activity.state = "running";
			activity.streamText = "";
			setCurrent(activity, toolActivity(event.toolName, event.args));
			break;
		case "tool_execution_end":
			activity.state = "running";
			activity.streamText = "";
			setCurrent(activity, event.isError ? `${event.toolName ?? "tool"} failed` : `${event.toolName ?? "tool"} finished`);
			break;
		case "message_end":
			if (event.message?.role === "assistant") {
				activity.state = "running";
				activity.streamText = "";
				captureModel(activity, event.message);
				captureReportedProgress(activity, event.message);
				addUsage(activity, event.message);
				setCurrent(activity, messageText(event.message) || "responding");
			}
			break;
		case "agent_end":
			activity.state = "done";
			activity.streamText = "";
			setCurrent(activity, "done");
			break;
	}
	return activity;
}
