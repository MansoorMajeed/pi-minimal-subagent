/**
 * pi-minimal-subagent — one tool that fans out N child `pi` agents in parallel,
 * streams compact activity inline and returns aggregated results.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createActivity, sanitizeTerminalText, type ChildActivity } from "./activity.ts";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { isMinimalSubagentChild } from "./child-boundary.ts";
import { runSubagent, type SubagentResult } from "./spawn.ts";
import { buildStatusRows, type StatusHeaderRow, type StatusRow } from "./status-layout.ts";

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

function statusIcon(row: StatusHeaderRow, theme: any): string {
	if (row.state === "done") return theme.fg("success", "✓");
	if (row.state === "queued") return theme.fg("dim", "○");
	if (row.state === "running") return theme.fg("accent", "●");
	return theme.fg("error", "✗");
}

function renderStatusRow(row: StatusRow, theme: any): string {
	if (row.kind === "header") {
		const state = row.state.replaceAll("_", " ");
		const stateColor = row.state === "done" ? "success" : row.state === "running" ? "accent" : row.state === "queued" ? "dim" : "error";
		const usage = row.usage ? theme.fg("dim", ` ${row.usage}`) : "";
		return `${statusIcon(row, theme)} ${theme.fg("toolTitle", theme.bold(sanitizeTerminalText(row.agent)))} ${theme.fg(stateColor, state)}${usage}`;
	}
	if (!row.text) return "";
	const text = row.historical ? `↳ ${sanitizeTerminalText(row.text)}` : sanitizeTerminalText(row.text);
	return `  ${theme.fg(row.historical ? "dim" : "muted", text)}`;
}

class SubagentStatusComponent implements Component {
	constructor(
		private rows: StatusRow[],
		private output: string | undefined,
		private theme: any,
	) {}

	render(width: number): string[] {
		const available = Math.max(1, width);
		const lines = this.rows.map((row) => truncateToWidth(renderStatusRow(row, this.theme), available, "…"));
		if (!this.output) return lines;
		const output = new Text(this.theme.fg("toolOutput", sanitizeTerminalText(this.output)), 0, 0).render(available);
		return [...lines, "", ...output];
	}

	invalidate(): void {}
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
				return new Text(`${theme.fg("toolTitle", theme.bold("subagent "))}${sanitizeTerminalText(args.action)}`, 0, 0);
			}
			const n = args?.tasks?.length ?? 0;
			const names = (args?.tasks ?? []).map((t: any) => sanitizeTerminalText(t.agent)).join(", ");
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
				return new Text(sanitizeTerminalText(text), 0, 0);
			}

			let output: string | undefined;
			if (expanded && !isPartial) {
				output = result.content?.find((item: any) => item.type === "text")?.text;
			}
			return new SubagentStatusComponent(buildStatusRows(details.activities, expanded), output, theme);
		},
	});
}
