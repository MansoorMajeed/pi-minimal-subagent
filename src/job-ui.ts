import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, SelectList, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./activity.ts";
import { type JobSnapshot, type JobRegistry } from "./jobs.ts";
import { summarize } from "./result-summary.ts";
import { activityTimingText, buildStatusRows, completionOutcome, singleLineStatusText } from "./status-layout.ts";

function line(text: string, width: number): string {
	return truncateToWidth(sanitizeTerminalText(text), Math.max(1, width), "…");
}

function detailsLines(job: JobSnapshot): string[] {
	const lines = [`Job ${job.id}`, `State: ${job.state}`, `Artifacts: ${job.runDir}`];
	for (const [index, activity] of job.activities.entries()) {
		lines.push("", `Task ${index + 1}: ${activity.agent}${activity.model ? ` · ${activity.model}` : ""}`);
		lines.push(`Goal: ${activity.goal}`, activityTimingText(activity));
		const cards = buildStatusRows([activity]);
		for (const card of cards) {
			if (card.kind === "header") {
				if (card.usage) lines.push(`Usage: ${card.usage}`);
			} else if (card.text.startsWith("Reported:") || card.historical && card.text) lines.push(card.text);
		}
		if (job.state !== "terminal") {
			lines.push("Full task:", ...activity.task.split("\n"));
			const paths = job.paths?.[index];
			if (paths) lines.push(`Log: ${paths.logPath}`);
			if (paths?.sessionPath) lines.push(`Session: ${paths.sessionPath}`);
		}
	}
	const completed = job.results ?? job.completedResults;
	if (completed?.length) {
		lines.push("", "Results:");
		for (const result of completed) {
			const outcome = completionOutcome(result);
			lines.push(`${result.agent}: ${outcome.label}${outcome.detail ? ` · ${outcome.detail}` : ""}`);
			if (result.outputPath) lines.push(`Output: ${result.outputPath}`);
			if (result.sessionPath) lines.push(`Session: ${result.sessionPath}`);
		}
		lines.push(...summarize(completed).split("\n"));
	}
	return lines.flatMap((text) => sanitizeTerminalText(text).split("\n"));
}

async function customView<T>(
	ctx: ExtensionCommandContext,
	signal: AbortSignal,
	create: (tui: Parameters<Parameters<typeof ctx.ui.custom>[0]>[0], finish: (value: T) => void) => { render(width: number): string[]; handleInput(data: string): void; invalidate(): void; dispose(): void },
	cancelValue: T,
): Promise<T> {
	return await ctx.ui.custom<T>((tui, _theme, _keys, done) => {
		let completed = false;
		const finish = (value: T) => {
			if (completed) return;
			completed = true;
			signal.removeEventListener("abort", onAbort);
			done(value);
		};
		const onAbort = () => finish(cancelValue);
		const view = create(tui, finish);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) onAbort();
		return {
			render: (width: number) => completed || signal.aborted ? [] : view.render(width),
			invalidate: () => { if (!completed && !signal.aborted) view.invalidate(); },
			handleInput: (data: string) => { if (!completed && !signal.aborted) view.handleInput(data); },
			dispose: () => { signal.removeEventListener("abort", onAbort); view.dispose(); },
		};
	});
}

async function pickJob(ctx: ExtensionCommandContext, jobs: JobSnapshot[], signal: AbortSignal): Promise<string | null> {
	return await customView(ctx, signal, (tui, finish) => {
		const items = jobs.map((job) => ({
			value: job.id,
			label: `${job.state} · ${job.activities.map((activity) => singleLineStatusText(activity.goal)).join("; ")}`,
		}));
		let budget = -1;
		let list: SelectList;
		const theme = {
			selectedPrefix: (text: string) => text,
			selectedText: (text: string) => text,
			description: (text: string) => text,
			scrollInfo: (text: string) => text,
			noMatch: (text: string) => text,
		};
		const resize = () => {
			const rows = Math.max(1, tui.terminal.rows);
			const next = Math.max(1, rows - (rows >= 5 ? 4 : rows >= 4 ? 3 : 2));
			if (next !== budget) {
				const previous = list?.getSelectedItem()?.value;
				list = new SelectList(items, next, theme);
				list.onSelect = (item) => finish(item.value);
				list.onCancel = () => finish(null);
				list.onSelectionChange = () => tui.requestRender();
				if (previous) list.setSelectedIndex(items.findIndex((item) => item.value === previous));
				budget = next;
			}
		};
		resize();
		return {
			render(width) {
				resize();
				const height = Math.max(1, tui.terminal.rows);
				const header = height >= 4 ? [line("Background subagent jobs", width)] : [];
				const hint = height >= 5 ? [line("↑↓ PgUp PgDn Home End · Enter · Esc", width)] : [];
				const id = line(`ID: ${list.getSelectedItem()?.value ?? ""}`, width);
				if (height === 1) return [id];
				const entries = list.render(Math.max(1, width));
				// At two or three rows there is no room for the optional scroll-indicator row.
				const visible = height < 4 ? entries.slice(0, 1) : entries;
				return [...header, ...visible.map((text) => line(text, width)), id, ...hint];
			},
			invalidate() { list.invalidate(); },
			handleInput(data) {
				resize();
				const selected = list.getSelectedItem()?.value;
				const current = items.findIndex((item) => item.value === selected);
				if (matchesKey(data, Key.home)) list.setSelectedIndex(0);
				else if (matchesKey(data, Key.end)) list.setSelectedIndex(items.length - 1);
				else if (matchesKey(data, Key.pageUp)) list.setSelectedIndex(current - budget);
				else if (matchesKey(data, Key.pageDown)) list.setSelectedIndex(current + budget);
				else list.handleInput(data);
				tui.requestRender();
			},
			dispose() {},
		};
	}, null);
}

async function showDetails(ctx: ExtensionCommandContext, job: JobSnapshot, signal: AbortSignal): Promise<void> {
	await customView(ctx, signal, (tui, finish) => {
		const content = detailsLines(job);
		let offset = 0;
		let width = Math.max(1, tui.terminal.columns);
		let wrapped = content.flatMap((text) => wrapTextWithAnsi(text, width));
		const visible = () => Math.max(1, tui.terminal.rows - (tui.terminal.rows >= 3 ? 2 : 1));
		const maxOffset = () => Math.max(0, wrapped.length - visible());
		const layout = (nextWidth: number) => {
			if (nextWidth === width) return;
			width = nextWidth;
			wrapped = content.flatMap((text) => wrapTextWithAnsi(text, width));
			offset = Math.min(offset, maxOffset());
		};
		return {
			render(width) {
				layout(Math.max(1, width));
				const height = Math.max(1, tui.terminal.rows);
				offset = Math.min(offset, maxOffset());
				const header = line(`Details snapshot · ${job.id}`, width);
				if (height === 1) return [header];
				const body = wrapped.slice(offset, offset + visible()).map((text) => line(text, width));
				return [header, ...body, ...(height >= 3 ? [line(`↑↓ PgUp PgDn Home End · Esc · ${offset + 1}/${wrapped.length}`, width)] : [])];
			},
			invalidate() {},
			handleInput(data) {
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) { finish(undefined); return; }
				if (matchesKey(data, Key.home)) offset = 0;
				else if (matchesKey(data, Key.end)) offset = maxOffset();
				else if (matchesKey(data, Key.up)) offset = Math.max(0, offset - 1);
				else if (matchesKey(data, Key.down)) offset = Math.min(maxOffset(), offset + 1);
				else if (matchesKey(data, Key.pageUp)) offset = Math.max(0, offset - visible());
				else if (matchesKey(data, Key.pageDown)) offset = Math.min(maxOffset(), offset + visible());
				tui.requestRender();
			},
			dispose() {},
		};
	}, undefined);
}

export async function showJobPicker(ctx: ExtensionCommandContext, jobs: JobRegistry, signal: AbortSignal): Promise<void> {
	if (signal.aborted) return;
	try {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("/subagents requires TUI mode", "warning");
			return;
		}
		const entries = jobs.listBackground();
		if (!entries.length) {
			ctx.ui.notify("No background jobs in this session", "info");
			return;
		}
		const id = await pickJob(ctx, entries, signal);
		if (signal.aborted || !id) return;
		const selected = jobs.get(id);
		if (!selected) { ctx.ui.notify(`Job ${id} is no longer available`, "warning"); return; }
		const action = await ctx.ui.select(`Job ${id}`, selected.state === "terminal" || selected.state === "cancelling" ? ["View details"] : ["View details", "Cancel job"], { signal });
		if (signal.aborted || !action) return;
		if (action === "View details") {
			const current = jobs.get(id);
			if (!current) { ctx.ui.notify(`Job ${id} is no longer available`, "warning"); return; }
			await showDetails(ctx, current, signal);
			if (signal.aborted) return;
			return;
		}
		if (action !== "Cancel job") return;
		const before = jobs.get(id);
		if (!before || before.state === "terminal") { ctx.ui.notify(`Job ${id} already finished`, "info"); return; }
		if (before.state === "cancelling") { ctx.ui.notify(`Job ${id} is already cancelling`, "info"); return; }
		const confirmed = await ctx.ui.confirm(`Cancel job ${id}?`, "Cancel stops the job; file edits are not undone.", { signal });
		if (signal.aborted || !confirmed) return;
		const current = jobs.get(id);
		if (!current || current.state === "terminal") { ctx.ui.notify(`Job ${id} already finished`, "info"); return; }
		if (current.state === "cancelling") { ctx.ui.notify(`Job ${id} is already cancelling`, "info"); return; }
		const cancellation = await jobs.cancel(id);
		if (signal.aborted) return;
		ctx.ui.notify(cancellation.disposition === "already-terminal" ? `Job ${id} already finished` : cancellation.disposition === "already-cancelling" ? `Job ${id} is already cancelling` : `Job ${id} cancelled. File edits are not undone.`, "info");
	} catch (error) {
		if (signal.aborted) return;
		ctx.ui.notify(`Could not manage subagent job: ${singleLineStatusText(error instanceof Error ? error.message : error)}`, "error");
	}
}
