/**
 * Spawn a single headless child `pi` agent and capture its result.
 *
 * The child runs in `--mode json`, which streams JSONL events to stdout. We tee
 * that stream to a per-run log file, derive compact activity updates, and parse
 * the final `agent_end` event to recover the child's last assistant message.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import {
	applyActivityEvent,
	createActivity,
	JsonLineParser,
	MAX_RECENT_ACTIVITY,
	snapshotActivity,
	type ChildActivity,
} from "./activity.ts";
import { MINIMAL_SUBAGENT_CHILD_ENV } from "./child-boundary.ts";

export const MAX_INLINE_ANSWER_BYTES = 16 * 1024;
export const MAX_INLINE_ERROR_BYTES = 4 * 1024;
const INLINE_EXCERPT_BYTES = 8 * 1024;

export interface SubagentRunOptions {
	task: string;
	/** Display + filename label (the agent name). */
	label: string;
	/** Short display goal; falls back to a preview of task. */
	goal?: string;
	/** Path to the JSONL log file to tee stdout into. */
	logPath: string;
	model?: string;
	/** Thinking level (off|minimal|low|medium|high|xhigh); passed as `--thinking`. */
	thinking?: string;
	/** Builtin tool allowlist passed to `--tools`. */
	tools?: string[];
	/** Omitted loads normal extensions; empty disables them; values are explicit paths. */
	extensions?: string[];
	/** False disables AGENTS.md and CLAUDE.md discovery in the child. */
	inheritProjectContext?: boolean;
	/** Hard completed-assistant-turn limit. */
	maxTurns?: number;
	/** System prompt body; written to a temp file and passed to pi. */
	systemPrompt?: string;
	/** "append" (default) keeps pi's base prompt; "replace" swaps it out. */
	systemPromptMode?: "append" | "replace";
	cwd: string;
	timeoutMs: number;
	/** Abort signal from the host tool call; aborting kills the child `pi`. */
	signal?: AbortSignal;
	/** Receives snapshots derived from the child's JSONL event stream. */
	onActivity?: (activity: ChildActivity) => void;
	/** Injectable clock for deterministic lifecycle tests. */
	now?: () => number;
}

export interface SubagentResult {
	agent: string;
	ok: boolean;
	answer: string;
	inlineAnswer: string;
	outputPath?: string;
	exitCode: number | null;
	logPath: string;
	timedOut: boolean;
	turnLimitExceeded: boolean;
	error?: string;
	activity: ChildActivity;
	usage: ChildActivity["usage"];
}

function truncateUtf8(text: string, maxBytes: number): string {
	let bytes = 0;
	let output = "";
	for (const character of text) {
		const size = Buffer.byteLength(character, "utf-8");
		if (bytes + size > maxBytes) break;
		bytes += size;
		output += character;
	}
	return output;
}

function boundedDiagnostic(text: string): string {
	if (Buffer.byteLength(text, "utf-8") <= MAX_INLINE_ERROR_BYTES) return text;
	const suffix = "\n[stderr truncated]";
	return `${truncateUtf8(text, MAX_INLINE_ERROR_BYTES - Buffer.byteLength(suffix, "utf-8"))}${suffix}`;
}

export function spillLargeAnswer(
	answer: string,
	outputPath: string,
	writeFile: (path: string, content: string, encoding: BufferEncoding) => void = fs.writeFileSync,
): { inlineAnswer: string; outputPath?: string } {
	if (Buffer.byteLength(answer, "utf-8") <= MAX_INLINE_ANSWER_BYTES) return { inlineAnswer: answer };
	try {
		writeFile(outputPath, answer, "utf-8");
		const excerpt = truncateUtf8(answer, INLINE_EXCERPT_BYTES);
		return {
			inlineAnswer: `${excerpt}\n\n[Output truncated; Full output saved to: ${outputPath}]`,
			outputPath,
		};
	} catch {
		return { inlineAnswer: answer };
	}
}

/** Pull the final assistant text out of a captured JSONL transcript. */
export function extractFinalAnswer(jsonl: string): string {
	const lines = jsonl.split("\n").filter((l) => l.trim().length > 0);
	// Prefer the terminal agent_end event, which carries the full message list.
	for (let i = lines.length - 1; i >= 0; i--) {
		const evt = tryParse(lines[i]);
		if (evt?.type === "agent_end" && Array.isArray(evt.messages)) {
			const text = lastAssistantText(evt.messages);
			if (text) return text;
		}
	}
	// Fallback: last turn_end assistant message.
	for (let i = lines.length - 1; i >= 0; i--) {
		const evt = tryParse(lines[i]);
		if (evt?.type === "turn_end" && evt.message) {
			const text = messageText(evt.message);
			if (text) return text;
		}
	}
	// A hard turn limit may stop the child before turn_end/agent_end.
	for (let i = lines.length - 1; i >= 0; i--) {
		const evt = tryParse(lines[i]);
		if (evt?.type === "message_end" && evt.message?.role === "assistant") {
			const text = messageText(evt.message);
			if (text) return text;
		}
	}
	return "";
}

function tryParse(line: string): any | null {
	try {
		return JSON.parse(line);
	} catch {
		return null;
	}
}

function lastAssistantText(messages: any[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (m?.role === "assistant") {
			const text = messageText(m);
			if (text) return text;
		}
	}
	return "";
}

function messageText(message: any): string {
	if (!Array.isArray(message?.content)) return "";
	return message.content
		.filter((p: any) => p?.type === "text" && typeof p.text === "string")
		.map((p: any) => p.text)
		.join("")
		.trim();
}

export async function runSubagent(opts: SubagentRunOptions): Promise<SubagentResult> {
	return await new Promise<SubagentResult>((resolve) => {
		let captured = "";
		let stderr = "";
		let timedOut = false;
		let aborted = false;
		let turnLimitExceeded = false;
		let lastCompletedAnswer = "";
		let acceptedAnswerAtLimit = "";
		let settled = false;
		let streamDead = false;
		let promptFile: string | undefined;
		let logStream: fs.WriteStream | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let child: ReturnType<typeof spawn> | undefined;
		const signal = opts.signal;
		const now = opts.now ?? Date.now;
		const activity = createActivity(opts.label, opts.model, {
			task: opts.task,
			goal: opts.goal,
			maxTurns: opts.maxTurns,
		});
		const eventParser = new JsonLineParser();
		const stdoutDecoder = new StringDecoder("utf8");
		const maxTurns = Number.isInteger(opts.maxTurns) && (opts.maxTurns ?? 0) > 0 ? opts.maxTurns : undefined;

		const emitActivity = () => opts.onActivity?.(snapshotActivity(activity));
		const processEvent = (event: unknown) => {
			if (turnLimitExceeded) return;
			if (
				event &&
				typeof event === "object" &&
				(event as { type?: unknown }).type === "turn_start" &&
				maxTurns !== undefined &&
				activity.usage.turns >= maxTurns
			) {
				turnLimitExceeded = true;
				acceptedAnswerAtLimit = lastCompletedAnswer;
				activity.state = "turn_limit";
				activity.current = `turn limit reached (${maxTurns})`;
				activity.recent = [...activity.recent, activity.current].slice(-MAX_RECENT_ACTIVITY);
				emitActivity();
				killTree("SIGTERM");
				killTimer = setTimeout(() => killTree("SIGKILL"), 3000);
				killTimer.unref();
				return;
			}
			applyActivityEvent(activity, event);
			if (
				event &&
				typeof event === "object" &&
				(event as any).type === "message_end" &&
				(event as any).message?.role === "assistant"
			) {
				const answer = messageText((event as any).message);
				if (answer) lastCompletedAnswer = answer;
			}
			emitActivity();
		};

		// Kill the child's whole process group (it is a group leader via
		// `detached: true`), so pi's own subprocesses don't linger and keep the
		// stdout pipe open. Falls back to a direct kill if the group is gone.
		const killTree = (sig: NodeJS.Signals) => {
			if (!child?.pid) return;
			try {
				process.kill(-child.pid, sig);
			} catch {
				try {
					child.kill(sig);
				} catch {
					/* already dead */
				}
			}
		};

		const onAbort = () => {
			aborted = true;
			if (child && !settled) {
				killTree("SIGTERM");
				killTimer = setTimeout(() => killTree("SIGKILL"), 3000);
				killTimer.unref();
			}
		};

		const cleanup = () => {
			if (timer) clearTimeout(timer);
			if (killTimer) clearTimeout(killTimer);
			if (signal) signal.removeEventListener("abort", onAbort);
			if (logStream) {
				try {
					logStream.end();
				} catch {
					/* already closed */
				}
			}
			if (promptFile) fs.rmSync(promptFile, { force: true });
		};

		const settle = (exitCode: number | null, errorOverride?: string) => {
			if (settled) return;
			settled = true;
			if (activity.startedAt !== undefined) activity.endedAt = now();
			if (timedOut || aborted || turnLimitExceeded) killTree("SIGKILL");
			cleanup();
			const answer = turnLimitExceeded ? acceptedAnswerAtLimit : extractFinalAnswer(captured);
			const outputFile = path.join(
				path.dirname(opts.logPath),
				`${path.basename(opts.logPath, path.extname(opts.logPath))}-output.md`,
			);
			const spilled = spillLargeAnswer(answer, outputFile);
			const ok = !timedOut && !aborted && !turnLimitExceeded && exitCode === 0 && answer.length > 0;
			const rawError = ok
				? undefined
				: (errorOverride ?? (aborted ? "aborted" : timedOut ? "timed out" : turnLimitExceeded ? `turn limit reached (${maxTurns})` : stderr.trim() || (exitCode === 0 ? "no answer produced" : exitCode === null ? "process exited without a status" : `exited with status ${exitCode}`)));
			const error = rawError ? boundedDiagnostic(rawError) : undefined;
			if (!ok) {
				activity.state = aborted ? "aborted" : timedOut ? "timed_out" : turnLimitExceeded ? "turn_limit" : "failed";
				activity.current = error ?? activity.state;
				if (activity.recent[activity.recent.length - 1] !== activity.current) activity.recent.push(activity.current);
				activity.recent = activity.recent.slice(-MAX_RECENT_ACTIVITY);
			} else if (activity.state !== "done") {
				activity.state = "done";
				activity.current = "done";
				activity.recent = [...activity.recent.filter((item) => item !== "done"), "done"].slice(-MAX_RECENT_ACTIVITY);
			}
			emitActivity();
			resolve({
				agent: opts.label,
				ok,
				answer,
				inlineAnswer: spilled.inlineAnswer,
				outputPath: spilled.outputPath,
				exitCode,
				logPath: opts.logPath,
				timedOut,
				turnLimitExceeded,
				error,
				activity: snapshotActivity(activity),
				usage: { ...activity.usage },
			});
		};

		try {
			const args = ["--print", "--mode", "json", "--no-session"];
			if (opts.model) args.push("--model", opts.model);
			// Apply the agent's thinking level unless the model string already names one.
			const modelHasLevel = !!opts.model && /:(off|minimal|low|medium|high|xhigh)$/.test(opts.model);
			if (opts.thinking && !modelHasLevel) args.push("--thinking", opts.thinking);
			if (opts.tools?.length) args.push("--tools", opts.tools.join(","));
			if (opts.extensions !== undefined) {
				args.push("--no-extensions");
				for (const extension of opts.extensions) args.push("--extension", extension);
			}
			if (opts.inheritProjectContext === false) args.push("--no-context-files");

			if (opts.systemPrompt?.trim()) {
				promptFile = path.join(os.tmpdir(), `pi-minsub-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
				fs.writeFileSync(promptFile, opts.systemPrompt, { mode: 0o600 });
				args.push(opts.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptFile);
			}
			fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
			logStream = fs.createWriteStream(opts.logPath, { flags: "w" });
			// A stream error (ENOSPC/EACCES) would otherwise emit an unhandled
			// 'error' and crash the host pi process. Degrade: stop teeing.
			logStream.on("error", () => {
				streamDead = true;
			});

			if (signal?.aborted) {
				settle(null, "aborted");
				return;
			}

			const launchAt = now();
			const deadlineAt = launchAt + opts.timeoutMs;
			const deadline = new Date(deadlineAt).toISOString();
			const turnGuidance = maxTurns === undefined ? "" : `\n- Turn cap: ${maxTurns} completed assistant turns.`;
			args.push(
				`Task: ${opts.task}\n\nRuntime limits:\n- Hard timeout: ${opts.timeoutMs} ms. Absolute UTC deadline: ${deadline}.${turnGuidance}\n- Before substantial work and at meaningful milestones, report one sparse factual line: Progress: <completed milestone; next step or blocker>.\n- If possible before the deadline, leave a concise handoff of completed work, verification, and remaining work. Finish with a normal final answer.`,
			);

			child = spawn("pi", args, {
				cwd: opts.cwd,
				env: { ...process.env, [MINIMAL_SUBAGENT_CHILD_ENV]: "1" },
				stdio: ["ignore", "pipe", "pipe"],
				detached: true, // own process group so killTree can reap descendants
			});
			activity.startedAt = launchAt;
			activity.deadlineAt = deadlineAt;
			activity.state = "running";
			activity.current = "starting";
			activity.recent = [...activity.recent, "starting"].slice(-MAX_RECENT_ACTIVITY);
			emitActivity();

			timer = setTimeout(() => {
				timedOut = true;
				killTree("SIGTERM");
				killTimer = setTimeout(() => killTree("SIGKILL"), 3000);
				killTimer.unref();
			}, opts.timeoutMs);

			if (signal) signal.addEventListener("abort", onAbort);

			const consumeStdout = (s: string) => {
				if (!s) return;
				captured += s;
				if (!streamDead && logStream) logStream.write(s);
				for (const event of eventParser.push(s)) processEvent(event);
			};
			child.stdout?.on("data", (chunk: Buffer) => consumeStdout(stdoutDecoder.write(chunk)));
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf-8");
			});
			child.on("error", (err) => settle(null, `failed to spawn pi: ${err.message}`));
			child.on("close", (code) => {
				consumeStdout(stdoutDecoder.end());
				for (const event of eventParser.flush()) processEvent(event);
				settle(code);
			});
		} catch (err: any) {
			settle(null, `subagent setup failed: ${err?.message ?? String(err)}`);
		}
	});
}
