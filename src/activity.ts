export type ActivityState = "queued" | "running" | "done" | "failed" | "timed_out" | "aborted" | "turn_limit";

export interface UsageSummary {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	turns: number;
}

export interface ChildActivity {
	agent: string;
	state: ActivityState;
	current: string;
	recent: string[];
	usage: UsageSummary;
	streamText?: string;
}

const MAX_ACTIVITY_CHARS = 100;
const MAX_RECENT = 3;

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

export function createActivity(agent: string): ChildActivity {
	return {
		agent,
		state: "queued",
		current: "queued",
		recent: ["queued"],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, turns: 0 },
	};
}

export function snapshotActivity(activity: ChildActivity): ChildActivity {
	return { ...activity, recent: [...activity.recent], usage: { ...activity.usage } };
}

function oneLine(value: unknown, max = MAX_ACTIVITY_CHARS): string {
	const text = String(value ?? "").replace(/\s+/g, " ").trim();
	if (text.length <= max) return text;
	return `${text.slice(0, max)}…`;
}

function setCurrent(activity: ChildActivity, text: string): void {
	const normalized = oneLine(text);
	if (!normalized) return;
	activity.current = normalized;
	if (activity.recent[activity.recent.length - 1] !== normalized) {
		activity.recent.push(normalized);
		if (activity.recent.length > MAX_RECENT) activity.recent.splice(0, activity.recent.length - MAX_RECENT);
	}
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
		case "message_update": {
			activity.state = "running";
			const update = event.assistantMessageEvent;
			if (update?.type === "text_delta" && typeof update.delta === "string") {
				activity.streamText = `${activity.streamText ?? ""}${update.delta}`.slice(-300);
				setCurrent(activity, activity.streamText);
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
			setCurrent(activity, event.isError ? `${event.toolName ?? "tool"} failed` : `${event.toolName ?? "tool"} finished`);
			break;
		case "message_end":
			if (event.message?.role === "assistant") {
				activity.state = "running";
				activity.streamText = "";
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
