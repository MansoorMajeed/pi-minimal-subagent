/**
 * pi-minimal-subagent — one tool that fans out N child `pi` agents in parallel,
 * streams compact activity inline and returns aggregated results.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createActivity, type ChildActivity } from "./activity.ts";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { isMinimalSubagentChild } from "./child-boundary.ts";
import { runSubagent, type SubagentResult } from "./spawn.ts";

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
		const status = r.ok ? "ok" : r.timedOut ? "TIMED OUT" : r.turnLimitExceeded ? "TURN LIMIT" : "FAILED";
		parts.push(`### [${i + 1}] ${r.agent} — ${status}`);
		if (r.inlineAnswer) parts.push(r.inlineAnswer);
		else if (r.error) parts.push(`(no answer: ${r.error})`);
		parts.push(`\n_log: ${r.logPath}_`);
		parts.push("");
	}
	return parts.join("\n").trim();
}

interface SubagentDetails {
	runDir: string;
	activities: ChildActivity[];
	results?: SubagentResult[];
}

export default function minimalSubagentExtension(pi: ExtensionAPI) {
	if (isMinimalSubagentChild()) return;

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Fan out one or more focused child agents in parallel and get their results back. " +
			"Each task names an agent and a concrete instruction; multiple tasks run concurrently. " +
			"Set a per-task `model` to use a faster/cheaper model for lighter work (e.g. a small model for recon, a stronger one for review). " +
			"Sequential work = call this tool again with the previous result baked into the next task. " +
			"Each child streams compact live activity in the tool result. " +
			"Use { action: 'list' } to see available agents (incl. custom ones) before picking.",
		parameters: ToolParams,

		async execute(_id, params, signal, onUpdate, ctx) {
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
				fs.writeFileSync(logPath, "");
				return { task: t, cfg, label, logPath, activity: createActivity(t.agent) };
			});

			let lastUpdateAt = 0;
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			const update = () => {
				lastUpdateAt = Date.now();
				updateTimer = undefined;
				const done = planned.filter((item) => item.activity.state === "done" || !["queued", "running"].includes(item.activity.state)).length;
				onUpdate?.({
					content: [{ type: "text" as const, text: `Subagents: ${done}/${planned.length} complete` }],
					details: {
						runDir,
						activities: planned.map((item) => ({ ...item.activity, recent: [...item.activity.recent], usage: { ...item.activity.usage } })),
					} satisfies SubagentDetails,
				});
			};
			const scheduleUpdate = () => {
				const delay = Math.max(0, 150 - (Date.now() - lastUpdateAt));
				if (delay === 0) update();
				else if (!updateTimer) updateTimer = setTimeout(update, delay);
			};
			update();

			const results = await runPool(planned, MAX_CONCURRENCY, (p) =>
				runSubagent({
					task: p.task.task,
					label: p.task.agent,
					logPath: p.logPath,
					model: p.task.model ?? p.cfg.model,
					thinking: p.cfg.thinking,
					tools: p.cfg.tools,
					extensions: p.cfg.extensions,
					inheritProjectContext: p.cfg.inheritProjectContext,
					maxTurns: p.cfg.maxTurns,
					systemPrompt: p.cfg.systemPrompt,
					systemPromptMode: p.cfg.systemPromptMode,
					cwd: ctx.cwd,
					timeoutMs: DEFAULT_TIMEOUT_MS,
					signal,
					onActivity: (activity) => {
						p.activity = activity;
						scheduleUpdate();
					},
				}),
			);
			if (updateTimer) clearTimeout(updateTimer);

			return {
				content: [{ type: "text" as const, text: summarize(results) }],
				details: { runDir, activities: results.map((result) => result.activity), results } satisfies SubagentDetails,
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

		renderResult(result: any, { expanded, isPartial }: any, theme: any) {
			const details = result.details as SubagentDetails | undefined;
			if (!details?.activities?.length) {
				const text = result.content?.find((item: any) => item.type === "text")?.text ?? "(no output)";
				return new Text(text, 0, 0);
			}

			const lines: string[] = [];
			for (const activity of details.activities) {
				const failed = !["queued", "running", "done"].includes(activity.state);
				const icon = activity.state === "done"
					? theme.fg("success", "✓")
					: failed
						? theme.fg("error", "✗")
						: activity.state === "queued"
							? theme.fg("dim", "○")
							: theme.fg("accent", "●");
				const stats: string[] = [];
				if (activity.usage.turns > 0) stats.push(`${activity.usage.turns} turn${activity.usage.turns === 1 ? "" : "s"}`);
				if (activity.usage.totalTokens > 0) stats.push(`${activity.usage.totalTokens.toLocaleString()} tok`);
				if (activity.usage.cost > 0) stats.push(`$${activity.usage.cost.toFixed(4)}`);
				const usage = stats.length ? theme.fg("dim", ` [${stats.join(" · ")}]`) : "";
				lines.push(`${icon} ${theme.fg("toolTitle", theme.bold(activity.agent))} ${theme.fg("muted", activity.current)}${usage}`);
				if (expanded) {
					for (const item of activity.recent) lines.push(`  ${theme.fg("dim", `↳ ${item}`)}`);
				}
			}

			if (expanded && !isPartial) {
				const output = result.content?.find((item: any) => item.type === "text")?.text;
				if (output) lines.push("", theme.fg("toolOutput", output));
			}
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
