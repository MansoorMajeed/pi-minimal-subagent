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
import {
	applyActivityEvent,
	createActivity,
	JsonLineParser,
	snapshotActivity,
	type ChildActivity,
} from "./activity.ts";
import { MINIMAL_SUBAGENT_CHILD_ENV } from "./child-boundary.ts";

export interface SubagentRunOptions {
	task: string;
	/** Display + filename label (the agent name). */
	label: string;
	/** Path to the JSONL log file to tee stdout into. */
	logPath: string;
	model?: string;
	/** Thinking level (off|minimal|low|medium|high|xhigh); passed as `--thinking`. */
	thinking?: string;
	/** Builtin tool allowlist passed to `--tools`. */
	tools?: string[];
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
}

export interface SubagentResult {
	agent: string;
	ok: boolean;
	answer: string;
	exitCode: number | null;
	logPath: string;
	timedOut: boolean;
	error?: string;
	activity: ChildActivity;
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
		let settled = false;
		let streamDead = false;
		let promptFile: string | undefined;
		let logStream: fs.WriteStream | undefined;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let killTimer: ReturnType<typeof setTimeout> | undefined;
		let child: ReturnType<typeof spawn> | undefined;
		const signal = opts.signal;
		const activity = createActivity(opts.label);
		const eventParser = new JsonLineParser();

		const emitActivity = () => opts.onActivity?.(snapshotActivity(activity));
		const processEvent = (event: unknown) => {
			applyActivityEvent(activity, event);
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
			cleanup();
			const answer = extractFinalAnswer(captured);
			const ok = !timedOut && !aborted && exitCode === 0 && answer.length > 0;
			const error = ok
				? undefined
				: (errorOverride ?? (aborted ? "aborted" : timedOut ? "timed out" : answer ? undefined : stderr.trim() || "no answer produced"));
			if (!ok) {
				activity.state = aborted ? "aborted" : timedOut ? "timed_out" : "failed";
				activity.current = error ?? activity.state;
				if (activity.recent[activity.recent.length - 1] !== activity.current) activity.recent.push(activity.current);
				activity.recent = activity.recent.slice(-3);
			} else if (activity.state !== "done") {
				activity.state = "done";
				activity.current = "done";
				activity.recent = [...activity.recent.filter((item) => item !== "done"), "done"].slice(-3);
			}
			emitActivity();
			resolve({ agent: opts.label, ok, answer, exitCode, logPath: opts.logPath, timedOut, error, activity: snapshotActivity(activity) });
		};

		try {
			const args = ["--print", "--mode", "json", "--no-session"];
			if (opts.model) args.push("--model", opts.model);
			// Apply the agent's thinking level unless the model string already names one.
			const modelHasLevel = !!opts.model && /:(off|minimal|low|medium|high|xhigh)$/.test(opts.model);
			if (opts.thinking && opts.thinking !== "off" && !modelHasLevel) args.push("--thinking", opts.thinking);
			if (opts.tools?.length) args.push("--tools", opts.tools.join(","));

			if (opts.systemPrompt?.trim()) {
				promptFile = path.join(os.tmpdir(), `pi-minsub-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
				fs.writeFileSync(promptFile, opts.systemPrompt, { mode: 0o600 });
				args.push(opts.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptFile);
			}
			args.push(`Task: ${opts.task}`);

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

			child = spawn("pi", args, {
				cwd: opts.cwd,
				env: { ...process.env, [MINIMAL_SUBAGENT_CHILD_ENV]: "1" },
				stdio: ["ignore", "pipe", "pipe"],
				detached: true, // own process group so killTree can reap descendants
			});
			activity.state = "running";
			activity.current = "starting";
			activity.recent = [...activity.recent, "starting"].slice(-3);
			emitActivity();

			timer = setTimeout(() => {
				timedOut = true;
				killTree("SIGTERM");
				killTimer = setTimeout(() => killTree("SIGKILL"), 3000);
				killTimer.unref();
			}, opts.timeoutMs);

			if (signal) signal.addEventListener("abort", onAbort);

			child.stdout?.on("data", (chunk: Buffer) => {
				const s = chunk.toString("utf-8");
				captured += s;
				if (!streamDead && logStream) logStream.write(s);
				for (const event of eventParser.push(s)) processEvent(event);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderr += chunk.toString("utf-8");
			});
			child.on("error", (err) => settle(null, `failed to spawn pi: ${err.message}`));
			child.on("close", (code) => {
				for (const event of eventParser.flush()) processEvent(event);
				settle(code);
			});
		} catch (err: any) {
			settle(null, `subagent setup failed: ${err?.message ?? String(err)}`);
		}
	});
}
