/**
 * Live observer: open a split with one pane per subagent, each following its
 * JSONL log through the formatter (which auto-closes the pane a few seconds
 * after the agent finishes). zellij is primary (right column + N stacked panes);
 * tmux is a best-effort bonus. No multiplexer → caller falls back to a tail hint.
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const FORMATTER = path.join(path.dirname(fileURLToPath(import.meta.url)), "format-events.mjs");
const CLOSE_DELAY_SEC = 4;

export interface ObserverPane {
	label: string;
	logPath: string;
}

export interface ObserverResult {
	launched: boolean;
	mux?: "zellij" | "tmux";
}

function detectMux(): "zellij" | "tmux" | null {
	if (process.env.ZELLIJ_SESSION_NAME) return "zellij";
	if (process.env.TMUX) return "tmux";
	return null;
}

/** argv the pane runs: render the log and auto-close when the agent finishes. */
function formatterArgv(pane: ObserverPane): string[] {
	return [process.execPath, FORMATTER, pane.logPath, pane.label, String(CLOSE_DELAY_SEC)];
}

function zellij(args: string[]): void {
	execFileSync("zellij", args, { stdio: ["ignore", "ignore", "ignore"], timeout: 5000 });
}

function launchZellij(panes: ObserverPane[]): boolean {
	try {
		// First pane carves the right column; the rest stack downward inside it.
		// --close-on-exit lets the pane vanish when the formatter exits.
		zellij(["action", "new-pane", "--direction", "right", "--close-on-exit", "--", ...formatterArgv(panes[0])]);
		for (let i = 1; i < panes.length; i++) {
			zellij(["action", "new-pane", "--direction", "down", "--close-on-exit", "--", ...formatterArgv(panes[i])]);
		}
		// Return focus to the original (pi) pane on the left.
		zellij(["action", "move-focus", "left"]);
		return true;
	} catch {
		return false;
	}
}

function sh(s: string): string {
	return `'${s.replace(/'/g, "'\\''")}'`;
}

function tmuxCapture(args: string[]): string {
	return execFileSync("tmux", args, { stdio: ["ignore", "pipe", "ignore"], timeout: 5000, encoding: "utf-8" }).trim();
}

function launchTmux(panes: ObserverPane[]): boolean {
	// tmux panes close when their command exits (remain-on-exit is off by default).
	try {
		const cmd = (p: ObserverPane) => formatterArgv(p).map(sh).join(" ");
		// `-d` keeps focus on the pi pane, so capture each new pane id (`-P -F`) and
		// target it for the next split — otherwise every split carves the pi pane.
		let target = tmuxCapture(["split-window", "-h", "-d", "-P", "-F", "#{pane_id}", cmd(panes[0])]);
		for (let i = 1; i < panes.length; i++) {
			target = tmuxCapture(["split-window", "-v", "-d", "-t", target, "-P", "-F", "#{pane_id}", cmd(panes[i])]);
		}
		return true;
	} catch {
		return false;
	}
}

export function launchObserver(panes: ObserverPane[]): ObserverResult {
	if (panes.length === 0) return { launched: false };
	const mux = detectMux();
	if (mux === "zellij") return { launched: launchZellij(panes), mux };
	if (mux === "tmux") return { launched: launchTmux(panes), mux };
	return { launched: false };
}
