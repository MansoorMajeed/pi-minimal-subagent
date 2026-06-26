/**
 * pi-minimal-subagent — one tool that fans out N child `pi` agents in parallel,
 * shows each live in a zellij split (optional), and returns aggregated results.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { runSubagent, type SubagentResult } from "./spawn.ts";
import { launchObserver } from "./observe.ts";

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_TASKS = 8;
const MAX_CONCURRENCY = 4;

const ToolParams = Type.Object({
	action: Type.Optional(
		Type.String({ description: "Set to 'list' to enumerate available agents (name, description, source) instead of running tasks." }),
	),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				agent: Type.String({ description: "Agent name (e.g. scout, reviewer, planner, oracle, worker)" }),
				task: Type.String({ description: "Concrete instruction for this subagent" }),
				model: Type.Optional(Type.String({ description: "Override model (e.g. 'anthropic/claude-sonnet-4')" })),
			}),
			{ description: "One entry per subagent. Multiple entries run concurrently.", minItems: 1, maxItems: MAX_TASKS },
		),
	),
	observe: Type.Optional(
		Type.Boolean({ description: "Show each subagent live in a zellij/tmux split. Default: true when a multiplexer is detected." }),
	),
});

function slug(s: string): string {
	return s.replace(/[^\w.-]/g, "_").slice(0, 40);
}

/** Run `fn` over items with bounded concurrency, preserving result order. */
async function runPool<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const worker = async () => {
		while (true) {
			const i = next++;
			if (i >= items.length) return;
			results[i] = await fn(items[i], i);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results;
}

function summarize(results: SubagentResult[]): string {
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const status = r.ok ? "ok" : r.timedOut ? "TIMED OUT" : "FAILED";
		parts.push(`### [${i + 1}] ${r.agent} — ${status}`);
		if (r.answer) parts.push(r.answer);
		else if (r.error) parts.push(`(no answer: ${r.error})`);
		parts.push(`\n_log: ${r.logPath}_`);
		parts.push("");
	}
	return parts.join("\n").trim();
}

export default function minimalSubagentExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Fan out one or more focused child agents in parallel and get their results back. " +
			"Each task names an agent and a concrete instruction; multiple tasks run concurrently. " +
			"Set a per-task `model` to use a faster/cheaper model for lighter work (e.g. a small model for recon, a stronger one for review). " +
			"Sequential work = call this tool again with the previous result baked into the next task. " +
			"With a zellij/tmux multiplexer, each subagent streams live in its own pane (observe). " +
			"Use { action: 'list' } to see available agents (incl. custom ones) before picking.",
		parameters: ToolParams,

		async execute(_id, params, signal, _onUpdate, ctx) {
			const agents = discoverAgents(ctx.cwd);

			if (params.action === "list") {
				const lines = [...agents.values()]
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((a) => `- ${a.name} (${a.source})${a.model ? ` [${a.model}]` : ""} — ${a.description || "no description"}`);
				const text = lines.length ? `Available agents:\n${lines.join("\n")}` : "No agents found.";
				return { content: [{ type: "text" as const, text }] };
			}

			const tasks = params.tasks ?? [];
			if (tasks.length === 0) {
				return { content: [{ type: "text" as const, text: "subagent requires `tasks` (or action: 'list' to see agents)." }] };
			}

			const unknown = tasks.map((t) => t.agent).filter((a) => !agents.has(a));
			if (unknown.length > 0) {
				const available = [...agents.keys()].sort().join(", ") || "(none)";
				return {
					content: [{ type: "text" as const, text: `Unknown agent(s): ${[...new Set(unknown)].join(", ")}.\nAvailable: ${available}` }],
				};
			}

			const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
			const runDir = path.join(os.tmpdir(), "pi-minsub", runId);
			fs.mkdirSync(runDir, { recursive: true });

			const planned = tasks.map((t, i) => {
				const cfg = agents.get(t.agent) as AgentConfig;
				const label = `${i + 1}-${slug(t.agent)}`;
				const logPath = path.join(runDir, `${label}.jsonl`);
				fs.writeFileSync(logPath, ""); // pre-create so the observer has a file to follow
				return { task: t, cfg, label, logPath };
			});

			const observe = params.observe ?? true;
			let observerNote = "";
			if (observe) {
				const obs = launchObserver(
					planned.map((p) => ({ label: p.task.agent, logPath: p.logPath })),
				);
				observerNote = obs.launched
					? `\n(observing ${planned.length} subagent(s) in a ${obs.mux} split)`
					: `\n(no multiplexer detected — watch with: tail -F ${runDir}/*.jsonl)`;
			}

			const results = await runPool(planned, MAX_CONCURRENCY, (p) =>
				runSubagent({
					task: p.task.task,
					label: p.task.agent,
					logPath: p.logPath,
					model: p.task.model ?? p.cfg.model,
					thinking: p.cfg.thinking,
					tools: p.cfg.tools,
					systemPrompt: p.cfg.systemPrompt,
					systemPromptMode: p.cfg.systemPromptMode,
					cwd: ctx.cwd,
					timeoutMs: DEFAULT_TIMEOUT_MS,
					signal,
				}).then((r) => {
					// Signal the observer pane to auto-close (covers failure/timeout
					// cases where the child emits no terminal `agent_end` event).
					try {
						fs.writeFileSync(`${p.logPath}.done`, "");
					} catch {
						/* observer marker is best-effort */
					}
					return r;
				}),
			);

			return {
				content: [{ type: "text" as const, text: summarize(results) + observerNote }],
				details: { runDir, results },
			};
		},

		renderCall(args: any, theme: any) {
			if (args?.action) {
				return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${args.action}`, 0, 0);
			}
			const n = args?.tasks?.length ?? 0;
			const names = (args?.tasks ?? []).map((t: any) => t.agent).join(", ");
			return new Text(
				`${theme.fg("toolTitle", theme.bold("subagent "))}${theme.fg("accent", `×${n}`)}${names ? ` (${names})` : ""}`,
				0,
				0,
			);
		},
	});
}
