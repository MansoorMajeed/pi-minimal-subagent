#!/usr/bin/env node
/**
 * Follow a child agent's JSONL log and render it live, then auto-close.
 * Usage:  node format-events.mjs <log.jsonl> <label> [closeDelaySec]
 *
 * Self-tails the file (polling) rather than reading a `tail -F` pipe, so the
 * process can exit cleanly once the agent is done — which lets zellij's
 * --close-on-exit (and tmux's default) close the pane automatically.
 * Closes when it sees an `agent_end` event OR a sibling `<log>.done` marker.
 */

import * as fs from "node:fs";

const logPath = process.argv[2];
const label = process.argv[3] ?? "subagent";
const closeDelaySec = Number(process.argv[4] ?? "4");
const doneMarker = `${logPath}.done`;

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const cyan = (s) => `\x1b[36m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;

process.stdout.write(bold(cyan(`▌ ${label}\n`)));

function oneLine(s, max = 120) {
	const t = String(s).replace(/\s+/g, " ").trim();
	return t.length > max ? t.slice(0, max) + "…" : t;
}

let sawAgentEnd = false;

function handle(evt) {
	switch (evt.type) {
		case "message_update": {
			const e = evt.assistantMessageEvent;
			if (e?.type === "text_delta" && typeof e.delta === "string") process.stdout.write(e.delta);
			else if (e?.type === "text_end") process.stdout.write("\n");
			else if (e?.type === "toolcall_end" && e.toolCall) {
				const args = e.toolCall.arguments ? oneLine(JSON.stringify(e.toolCall.arguments), 100) : "";
				process.stdout.write(dim(`\n  🔧 ${e.toolCall.name} ${args}\n`));
			}
			break;
		}
		case "tool_execution_end": {
			const content = evt.result?.content;
			const txt = (Array.isArray(content) ? content.find((c) => c.type === "text")?.text : "") ?? "";
			const tag = evt.isError ? red("  ↳ error: ") : dim("  ↳ ");
			process.stdout.write(tag + dim(oneLine(txt)) + "\n");
			break;
		}
		case "turn_end":
			process.stdout.write(dim("  ─── turn ───\n"));
			break;
		case "agent_end":
			process.stdout.write(green("\n══ done ══\n"));
			sawAgentEnd = true;
			break;
	}
}

let buf = "";
let offset = 0;

function drain() {
	let size;
	try {
		size = fs.statSync(logPath).size;
	} catch {
		return;
	}
	if (size > offset) {
		const fd = fs.openSync(logPath, "r");
		try {
			const len = size - offset;
			const chunk = Buffer.alloc(len);
			fs.readSync(fd, chunk, 0, len, offset);
			offset = size;
			buf += chunk.toString("utf-8");
		} finally {
			fs.closeSync(fd);
		}
		let nl;
		while ((nl = buf.indexOf("\n")) !== -1) {
			const line = buf.slice(0, nl);
			buf = buf.slice(nl + 1);
			if (!line.trim()) continue;
			try {
				handle(JSON.parse(line));
			} catch {
				/* ignore partial / non-json */
			}
		}
	}
}

function close() {
	drain(); // flush any remaining tail
	process.stdout.write(dim(`\n(closing in ${closeDelaySec}s — Ctrl+C to keep)\n`));
	setTimeout(() => process.exit(0), closeDelaySec * 1000);
}

const poll = setInterval(() => {
	drain();
	if (sawAgentEnd || fs.existsSync(doneMarker)) {
		clearInterval(poll);
		close();
	}
}, 150);
