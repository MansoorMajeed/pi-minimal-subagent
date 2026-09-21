/**
 * pi-minimal-subagent — one tool that fans out N child `pi` agents in parallel,
 * streams compact activity inline and returns aggregated results.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, getAgentDir, truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { createActivity, displayGoal, sanitizeTerminalText, type ChildActivity } from "./activity.ts";
import { discoverAgents, type AgentConfig } from "./agents.ts";
import { isMinimalSubagentChild } from "./child-boundary.ts";
import { JobRegistry, type JobHandle } from "./jobs.ts";
import { loadModelGuide, searchModels } from "./model-guidance.ts";
import { summarize } from "./result-summary.ts";
import type { SubagentResult } from "./spawn.ts";
import { buildStatusRows, singleLineStatusText, type StatusHeaderRow, type StatusRow } from "./status-layout.ts";

const MAX_TASKS = 8;

const ToolParams = Type.Object({
	action: Type.Optional(
		Type.String({ description: "'list': agents and model guidance. 'models': search available models with query. Omit to run tasks." }),
	),
	query: Type.Optional(Type.String({ description: "Required for 'models': name or provider/model ID substring (e.g. 'luna'); at most 50 matches.", minLength: 1 })),
	async: Type.Optional(Type.Boolean({ description: "TUI only: background execution. Defaults true in TUI and false elsewhere; false always blocks." })),
	id: Type.Optional(Type.String({ description: "Exact background job ID for status or cancel." })),
	tasks: Type.Optional(
		Type.Array(
			Type.Object({
				agent: Type.String({ description: "Agent name (e.g. scout, reviewer, planner, oracle, worker)" }),
				task: Type.String({ description: "Concrete instruction for this subagent" }),
				label: Type.Optional(Type.String({ description: "Concise display goal (e.g. 'Implement refresh-token rotation')" })),
				model: Type.Optional(Type.String({ description: "Override model (e.g. 'anthropic/claude-sonnet-4')" })),
			}),
			{ description: "One entry per subagent. Multiple entries run concurrently.", minItems: 1, maxItems: MAX_TASKS },
		),
	),
});

function slug(s: string): string {
	return s.replace(/[^\w.-]/g, "_").slice(0, 40);
}

interface SubagentDetails {
	runDir: string;
	jobId?: string;
	state?: string;
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
		const model = row.model ? theme.fg("dim", ` model: ${singleLineStatusText(row.model)}`) : "";
		const usage = row.usage ? theme.fg("dim", ` ${row.usage}`) : "";
		return `${statusIcon(row, theme)} ${theme.fg("toolTitle", theme.bold(singleLineStatusText(row.agent)))} ${theme.fg(stateColor, state)}${model}${usage}`;
	}
	if (!row.text) return "";
	const displayText = singleLineStatusText(row.text);
	const text = row.historical ? `↳ ${displayText}` : displayText;
	return `  ${theme.fg(row.historical ? "dim" : "muted", text)}`;
}

export class SubagentStatusComponent implements Component {
	private rows: StatusRow[];
	private output: string | undefined;
	private theme: any;

	constructor(rows: StatusRow[], output: string | undefined, theme: any) {
		this.rows = rows;
		this.output = output;
		this.theme = theme;
	}

	render(width: number): string[] {
		const available = Math.max(1, width);
		const lines = this.rows.map((row) => truncateToWidth(renderStatusRow(row, this.theme), available, "…"));
		if (!this.output) return lines;
		const output = new Text(this.theme.fg("toolOutput", sanitizeTerminalText(this.output)), 0, 0).render(available);
		return [...lines, "", ...output];
	}

	invalidate(): void {}
}

function boundedText(text: string): string {
	const notice = "\nOutput truncated to fit 50KB/2000 lines.";
	const bounded = truncateHead(text, { maxBytes: DEFAULT_MAX_BYTES - Buffer.byteLength(notice), maxLines: DEFAULT_MAX_LINES - 1 });
	return bounded.content + (bounded.truncated ? notice : "");
}

function jobStatusText(snapshot: ReturnType<JobHandle["snapshot"]>): string {
	const header = `Job ${snapshot.id} — ${snapshot.state}`;
	if (snapshot.results) return `${header}\n${summarize(snapshot.results)}`;
	const lines = snapshot.activities.map((activity, index) => {
		const progress = activity.reported ?? activity.current;
		return `[${index + 1}] ${activity.agent} — ${activity.state} — ${activity.goal}${progress ? ` — ${progress}` : ""}`;
	});
	return [header, ...lines, `Artifacts: ${snapshot.runDir}`].join("\n");
}

function expandedTaskText(activities: ChildActivity[], completedOutput?: string): string {
	const tasks = activities
		.map((activity, index) => `Task [${index + 1}] ${singleLineStatusText(activity.agent)}\n${sanitizeTerminalText(activity.task)}`)
		.join("\n\n");
	return completedOutput ? `${tasks}\n\nCompleted output\n${completedOutput}` : tasks;
}

export default function minimalSubagentExtension(pi: ExtensionAPI) {
	if (isMinimalSubagentChild()) return;

	let jobs = new JobRegistry();
	let generation = 0;
	let runtimeAlive = false;
	let sessionId: string | undefined;
	let completionSubmitted = new Set<string>();
	let deliveryErrors = new Map<string, string>();

	pi.on("session_start", (_event, ctx) => {
		jobs = new JobRegistry();
		generation++;
		runtimeAlive = true;
		sessionId = ctx.sessionManager.getSessionId();
		completionSubmitted = new Set();
		deliveryErrors = new Map();
	});
	const confirmReplacement = async (_event: unknown, ctx: any) => {
		const count = jobs.listActiveBackground().length;
		if (count === 0 || !ctx.hasUI && ctx.mode !== "tui") return;
		const confirmed = await ctx.ui.confirm(
			"Stop background subagents?",
			`Switching will stop ${count} background job${count === 1 ? "" : "s"}; file edits are not undone. Continue?`,
		);
		if (!confirmed) return { cancel: true as const };
	};
	pi.on("session_before_switch", confirmReplacement);
	pi.on("session_before_fork", confirmReplacement);
	pi.on("session_shutdown", async () => {
		runtimeAlive = false;
		await jobs.dispose();
	});
	pi.registerCommand("subagent-cancel", {
		description: "Cancel one background subagent job by exact ID",
		handler: async (args: string, ctx: any) => {
			const id = args.trim();
			if (!id) {
				ctx.ui.notify("Usage: /subagent-cancel <id>", "error");
				return;
			}
			try {
				await jobs.cancel(id);
				ctx.ui.notify(`Subagent job ${id} cancelled; file edits are not undone.`, "info");
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			}
		},
	});
	pi.registerMessageRenderer("minimal-subagent-complete", (message: any, { expanded }: any, theme: any) => {
		const details = message.details as SubagentDetails | undefined;
		const id = details?.jobId ?? "unknown";
		if (!expanded || !details?.activities?.length) {
			return new Text(`${theme.fg("success", "✓")} ${theme.fg("toolTitle", theme.bold(`subagent ${id}`))} ${theme.fg("dim", details?.state ?? "complete")}`, 0, 0);
		}
		return new SubagentStatusComponent(buildStatusRows(details.activities), summarize(details.results ?? []), theme);
	});

	pi.registerTool({
		name: "subagent",
		label: "Subagent",
		description:
			"Fan out one or more focused child agents. In TUI sessions work runs in the background by default; use async:false to block. " +
			"Each task names an agent and a concrete instruction; multiple tasks run concurrently. " +
			"Children cannot see the parent conversation, so make every task self-contained. " +
			"Set a per-task `model` to use a faster/cheaper model for lighter work (e.g. a small model for recon, a stronger one for review). " +
			"Background completion arrives automatically: continue independent work, or briefly acknowledge and yield without polling. " +
			"For dependent work, wait for that completion and bake its result into the next self-contained call. Use status/cancel with an exact job ID. " +
			"Avoid overlapping file writers. Explicit blocking calls stream compact live activity in the tool result. " +
			"Use { action: 'list' } for agents and model-selection guidance before picking. " +
			"Resolve model IDs with { action: 'models', query: 'name' }; searches are bounded to 50 matches and 50KB.",
		parameters: ToolParams,

		async execute(_id, params, signal, onUpdate, ctx) {
			const allowedActions = new Set(["list", "models", "status", "cancel"]);
			if (params.action && !allowedActions.has(params.action)) throw new Error(`Unsupported subagent action: ${params.action}`);
			if (params.action && (params.tasks !== undefined || params.async !== undefined)) {
				throw new Error(`subagent action '${params.action}' cannot be combined with launch inputs.`);
			}
			if (!params.action && (params.id !== undefined || params.query !== undefined)) {
				throw new Error("subagent launch cannot be combined with control inputs.");
			}
			if (params.action === "status") {
				if (params.query !== undefined) throw new Error("subagent action 'status' does not accept query.");
				if (params.id) {
					const snapshot = jobs.get(params.id);
					if (!snapshot) throw new Error(`Unknown subagent job id: ${params.id}`);
					const deliveryError = deliveryErrors.get(params.id);
					const text = jobStatusText(snapshot) + (deliveryError ? `\nCompletion delivery failed: ${deliveryError}` : "");
					return {
						content: [{ type: "text" as const, text: boundedText(text) }],
						details: { runDir: snapshot.runDir, jobId: snapshot.id, state: snapshot.state, activities: snapshot.activities, results: snapshot.results } satisfies SubagentDetails,
					};
				}
				const active = jobs.listActiveBackground();
				const text = active.length ? active.map(jobStatusText).join("\n\n") : "No active background subagent jobs.";
				return { content: [{ type: "text" as const, text: boundedText(text) }] };
			}
			if (params.action === "cancel") {
				if (params.query !== undefined) throw new Error("subagent action 'cancel' does not accept query.");
				if (!params.id) throw new Error("subagent action 'cancel' requires an exact id.");
				const results = await jobs.cancel(params.id);
				const snapshot = jobs.get(params.id)!;
				return {
					content: [{ type: "text" as const, text: `Cancelled subagent job ${params.id}; file edits are not undone.\n${summarize(results)}` }],
					details: { runDir: snapshot.runDir, jobId: snapshot.id, state: snapshot.state, activities: snapshot.activities, results } satisfies SubagentDetails,
				};
			}
			if (params.action === "models") {
				if (params.id !== undefined) throw new Error("subagent action 'models' does not accept id.");
				if (!params.query?.trim()) throw new Error("subagent action 'models' requires a nonblank query (e.g. 'luna').");
				const { matches, total } = searchModels(ctx.modelRegistry.getAvailable(), params.query);
				const lines = matches.map((model) => `- ${model.provider}/${model.id} — ${model.name}`);
				const text = total
					? `Available model matches (registry, not a live quota/access check):\n${lines.join("\n")}`
					: "No available models match this query.";
				const truncationNotice = "\nOutput truncated to fit 50KB/2000 lines. Narrow your query.";
				const matchNotice = total > matches.length ? `\nShowing ${matches.length} of ${total} matches. Narrow your query.` : "";
				const bounded = truncateHead(text, {
					maxBytes: DEFAULT_MAX_BYTES - Math.max(Buffer.byteLength(truncationNotice), Buffer.byteLength(matchNotice)),
					maxLines: DEFAULT_MAX_LINES - 1,
				});
				const notice = bounded.truncated ? truncationNotice : matchNotice;
				return { content: [{ type: "text" as const, text: bounded.content + notice }] };
			}

			const agents = discoverAgents(ctx.cwd);

			if (params.action === "list") {
				if (params.id !== undefined || params.query !== undefined) throw new Error("subagent action 'list' does not accept id or query.");
				const lines = [...agents.values()]
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((a) => `- ${a.name} (${a.source})${a.model ? ` [${a.model}]` : ""} — ${a.description || "no description"}`);
				const agentsText = lines.length ? `Available agents:\n${lines.join("\n")}` : "No agents found.";
				const guide = loadModelGuide(getAgentDir());
				const text = `${agentsText}\n\nModel guidance (${guide.filePath}):\n${guide.text || "(empty override; no model guidance)"}`;
				if (truncateHead(text).truncated) throw new Error(`Agent list/model guidance is too large (50KB/2000 lines). Shorten ${guide.filePath} or agent descriptions.`);
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
			const background = params.async ?? ctx.mode === "tui";
			if (params.async === true && ctx.mode !== "tui") {
				throw new Error("Background subagents require TUI mode; use synchronous execution with async:false or omit async outside the TUI.");
			}
			if (background && signal?.aborted) throw new Error("Subagent launch was aborted before background job acceptance.");

			const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
			const runDir = path.join(os.tmpdir(), "pi-minsub", runId);
			fs.mkdirSync(runDir, { recursive: true });

			const planned = tasks.map((t, i) => {
				const cfg = agents.get(t.agent) as AgentConfig;
				const label = `${i + 1}-${slug(t.agent)}`;
				const logPath = path.join(runDir, `${label}.jsonl`);
				const model = t.model ?? cfg.model;
				fs.writeFileSync(logPath, "");
				const goal = displayGoal(t.label, t.task);
				return {
					task: t,
					cfg,
					label,
					logPath,
					model,
					goal,
					activity: createActivity(t.agent, model, { task: t.task, goal, maxTurns: cfg.maxTurns }),
				};
			});

			const handle: JobHandle = jobs.submit({
				id: runId,
				runDir,
				background,
				children: planned.map((p) => ({
					activity: p.activity,
					options: {
						task: p.task.task,
						label: p.task.agent,
						goal: p.goal,
						logPath: p.logPath,
						model: p.model,
						thinking: p.cfg.thinking,
						tools: p.cfg.tools,
						extensions: p.cfg.extensions,
						inheritProjectContext: p.cfg.inheritProjectContext,
						maxTurns: p.cfg.maxTurns,
						systemPrompt: p.cfg.systemPrompt,
						systemPromptMode: p.cfg.systemPromptMode,
						cwd: ctx.cwd,
						timeoutMs: p.cfg.timeoutMs,
					},
				})),
			});
			if (background) {
				const acceptedJobs = jobs;
				const acceptedGeneration = generation;
				const acceptedSessionId = sessionId;
				const submitted = completionSubmitted;
				const errors = deliveryErrors;
				void handle.completion.then((results) => {
					const snapshot = handle.snapshot();
					if (
						!runtimeAlive || jobs !== acceptedJobs || generation !== acceptedGeneration ||
						sessionId !== acceptedSessionId || snapshot.cancelRequested || submitted.has(runId)
					) return;
					submitted.add(runId);
					const goals = snapshot.activities.map((activity, index) => `[${index + 1}] ${activity.agent}: ${activity.goal}`).join("\n");
					try {
						pi.sendMessage(
							{
								customType: "minimal-subagent-complete",
								content: `Background subagent job ${runId} completed.\nOriginal goals:\n${goals}\n\n${summarize(results)}`,
								display: true,
								details: { runDir, jobId: runId, state: snapshot.state, activities: snapshot.activities, results } satisfies SubagentDetails,
							},
							{ deliverAs: "followUp", triggerTurn: true },
						);
					} catch (error) {
						errors.set(runId, error instanceof Error ? error.message : String(error));
					}
				});
				const snapshot = handle.snapshot();
				const goals = snapshot.activities.map((activity, index) => `[${index + 1}] ${activity.agent}: ${activity.goal}`).join("\n");
				return {
					content: [{ type: "text" as const, text: `Subagent job ${runId} accepted and continues in the background. Completion arrives automatically; do not poll.\n${goals}\nArtifacts: ${runDir}` }],
					details: { runDir, jobId: runId, state: snapshot.state, activities: snapshot.activities } satisfies SubagentDetails,
				};
			}
			let lastUpdateAt = 0;
			let updateTimer: ReturnType<typeof setTimeout> | undefined;
			const update = () => {
				lastUpdateAt = Date.now();
				updateTimer = undefined;
				const snapshot = handle.snapshot();
				const done = snapshot.activities.filter((activity) => !["queued", "running"].includes(activity.state)).length;
				onUpdate?.({
					content: [{ type: "text" as const, text: `Subagents: ${done}/${planned.length} complete` }],
					details: { runDir, activities: snapshot.activities } satisfies SubagentDetails,
				});
			};
			const scheduleUpdate = () => {
				const delay = Math.max(0, 150 - (Date.now() - lastUpdateAt));
				if (delay === 0) update();
				else if (!updateTimer) updateTimer = setTimeout(update, delay);
			};
			const unsubscribe = jobs.subscribe(scheduleUpdate);
			const onAbort = () => { void jobs.cancel(runId); };
			if (signal?.aborted) onAbort();
			else signal?.addEventListener("abort", onAbort, { once: true });
			update();
			const clockTimer = setInterval(scheduleUpdate, 1_000);
			clockTimer.unref?.();

			let results: SubagentResult[];
			try {
				results = await handle.completion;
			} finally {
				unsubscribe();
				signal?.removeEventListener("abort", onAbort);
				clearInterval(clockTimer);
				if (updateTimer) clearTimeout(updateTimer);
			}

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
			if (expanded) {
				const completedOutput = isPartial
					? undefined
					: result.content?.find((item: any) => item.type === "text")?.text;
				output = expandedTaskText(details.activities, completedOutput);
			}
			return new SubagentStatusComponent(buildStatusRows(details.activities), output, theme);
		},
	});
}
