/**
 * Spawn a single headless child `pi` agent and capture its result.
 *
 * The child runs in `--mode json`, which streams JSONL events to stdout. We tee
 * that stream to a per-run log file (so a `tail -f | format` observer pane can
 * show live progress) and, on exit, parse the final `agent_end` event to recover
 * the child's last assistant message as the answer.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface SubagentRunOptions {
	task: string;
	/** Display + filename label (the agent name). */
	label: string;
	/** Path to the JSONL log file to tee stdout into. */
	logPath: string;
	model?: string;
	/** Builtin tool allowlist passed to `--tools`. */
	tools?: string[];
	/** System prompt body; written to a temp file and passed to pi. */
	systemPrompt?: string;
	/** "append" (default) keeps pi's base prompt; "replace" swaps it out. */
	systemPromptMode?: "append" | "replace";
	cwd: string;
	timeoutMs: number;
}

export interface SubagentResult {
	agent: string;
	ok: boolean;
	answer: string;
	exitCode: number | null;
	logPath: string;
	timedOut: boolean;
	error?: string;
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
	const args = ["--print", "--mode", "json", "--no-session"];
	if (opts.model) args.push("--model", opts.model);
	if (opts.tools?.length) args.push("--tools", opts.tools.join(","));

	let promptFile: string | undefined;
	if (opts.systemPrompt?.trim()) {
		promptFile = path.join(os.tmpdir(), `pi-minsub-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
		fs.writeFileSync(promptFile, opts.systemPrompt, { mode: 0o600 });
		args.push(opts.systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt", promptFile);
	}
	args.push(`Task: ${opts.task}`);

	fs.mkdirSync(path.dirname(opts.logPath), { recursive: true });
	const logStream = fs.createWriteStream(opts.logPath, { flags: "w" });

	return await new Promise<SubagentResult>((resolve) => {
		let captured = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const child = spawn("pi", args, {
			cwd: opts.cwd,
			env: process.env,
			stdio: ["ignore", "pipe", "pipe"],
		});

		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGTERM");
			setTimeout(() => child.kill("SIGKILL"), 3000).unref();
		}, opts.timeoutMs);

		child.stdout.on("data", (chunk: Buffer) => {
			const s = chunk.toString("utf-8");
			captured += s;
			logStream.write(s);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf-8");
		});

		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			logStream.end();
			if (promptFile) fs.rmSync(promptFile, { force: true });
			const answer = extractFinalAnswer(captured);
			const ok = !timedOut && exitCode === 0 && answer.length > 0;
			resolve({
				agent: opts.label,
				ok,
				answer,
				exitCode,
				logPath: opts.logPath,
				timedOut,
				error: ok ? undefined : timedOut ? "timed out" : answer ? undefined : stderr.trim() || "no answer produced",
			});
		};

		child.on("error", (err) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			logStream.end();
			if (promptFile) fs.rmSync(promptFile, { force: true });
			resolve({
				agent: opts.label,
				ok: false,
				answer: "",
				exitCode: null,
				logPath: opts.logPath,
				timedOut,
				error: `failed to spawn pi: ${err.message}`,
			});
		});

		child.on("close", (code) => finish(code));
	});
}
