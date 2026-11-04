import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalText, type ChildActivity } from "./activity.ts";
import type { JobSnapshot } from "./jobs.ts";
import { SubagentStatusComponent } from "./status-render.ts";
import { buildStatusRows, formatDuration, singleLineStatusText } from "./status-layout.ts";

const WIDGET_ID = "minimal-subagent-background";
const RPC_MAX_CARDS = 4;
const RPC_MAX_LINE_CHARS = 160;

interface WidgetUI {
	setWidget(id: string, content: undefined | ((tui: any, theme: any) => Component), options?: { placement?: "aboveEditor" | "belowEditor" }): void;
}

class BackgroundStatusComponent implements Component {
	private getJobs: () => JobSnapshot[];
	private theme: any;

	constructor(getJobs: () => JobSnapshot[], theme: any) {
		this.getJobs = getJobs;
		this.theme = theme;
	}

	render(width: number): string[] {
		const available = Math.max(1, width);
		const jobs = this.getJobs();
		const all = jobs.flatMap((job) => job.activities.map((activity) => ({ job, activity })));
		const running = all.filter(({ activity }) => activity.state === "running");
		const queued = all.filter(({ activity }) => activity.state === "queued");
		const shown = (running.length > 0 ? running : queued).slice(0, 2);
		const header = `Background · ${running.length} run · ${queued.length} queued`;
		const lines = [truncateToWidth(this.theme.fg("dim", header), available, "…")];
		let previousJobId: string | undefined;
		for (const { job, activity } of shown) {
			if (job.id !== previousJobId) {
				const id = sanitizeTerminalText(job.id).replace(/\s+/g, " ");
				lines.push(truncateToWidth(this.theme.fg("dim", `Job ${id}`), available, "…"));
				previousJobId = job.id;
			}
			lines.push(...new SubagentStatusComponent(buildStatusRows([activity]), undefined, this.theme).render(available));
		}
		return lines;
	}

	invalidate(): void {}
}

export class BackgroundUI {
	private jobs: JobSnapshot[] = [];
	private mounted = false;
	private disposed = false;
	private tui: any;
	private clock?: ReturnType<typeof setInterval>;
	private ui: WidgetUI;

	constructor(ui: WidgetUI) {
		this.ui = ui;
	}

	update(jobs: JobSnapshot[]): void {
		if (this.disposed) return;
		this.jobs = jobs.filter((job) => job.background && job.state !== "terminal");
		if (this.jobs.length === 0) {
			this.unmount();
			return;
		}
		if (!this.mounted) {
			this.mounted = true;
			this.ui.setWidget(WIDGET_ID, (tui, theme) => {
				this.tui = tui;
				return new BackgroundStatusComponent(() => this.jobs, theme);
			}, { placement: "aboveEditor" });
			this.clock = setInterval(() => this.tui?.requestRender(), 1_000);
			this.clock.unref?.();
		} else {
			this.tui?.requestRender();
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unmount();
	}

	private unmount(): void {
		if (this.clock) {
			clearInterval(this.clock);
			this.clock = undefined;
		}
		this.tui = undefined;
		if (this.mounted) {
			this.mounted = false;
			this.ui.setWidget(WIDGET_ID, undefined);
		}
	}
}

function clipLine(line: string): string {
	const characters = [...line];
	return characters.length <= RPC_MAX_LINE_CHARS ? line : `${characters.slice(0, RPC_MAX_LINE_CHARS - 1).join("")}…`;
}

function isActive(job: JobSnapshot): boolean {
	return job.background && job.state !== "terminal" && job.activities.length > 0;
}

// Activity entries that report state rather than what the child acted on.
const STATUS_ENTRY = /^(?:queued|started|thinking|writing response|done)$|^\S+ (?:finished|failed)$/;

/** The latest tool step a child started, such as `bash go test ./...`. */
function lastStep(recent: string[]): string | undefined {
	for (let i = recent.length - 1; i >= 0; i--) {
		const entry = singleLineStatusText(recent[i]);
		if (entry && !STATUS_ENTRY.test(entry)) return entry;
	}
	return undefined;
}

function compactCard(activity: ChildActivity, now: number): string[] {
	const goal = singleLineStatusText(activity.goal);
	if (activity.state === "queued") return [`○ ${goal} · queued`];
	const elapsed = activity.startedAt === undefined ? "" : ` · ${formatDuration(now - activity.startedAt)}`;
	const lines = [`● ${goal}${elapsed}`];
	const reported = activity.reported ? singleLineStatusText(activity.reported) : "";
	if (reported) lines.push(`  ${reported}`);
	const step = lastStep(activity.recent);
	if (step) lines.push(`  ↳ ${step}`);
	return lines;
}

/**
 * Compact plain-text status for clients without the TUI, such as chat apps
 * on a phone: overall counts, then up to four running children (or queued
 * ones when none run), each as its goal and elapsed time, its latest reported
 * progress, and its latest tool step. Empty when nothing is active.
 */
export function rpcStatusLines(jobs: JobSnapshot[], now = Date.now()): string[] {
	const all = jobs
		.filter(isActive)
		.flatMap((job) => job.activities);
	if (all.length === 0) return [];
	const running = all.filter((activity) => activity.state === "running");
	const queued = all.filter((activity) => activity.state === "queued");
	const pool = running.length > 0 ? running : queued;
	const counts = [running.length ? `${running.length} running` : "", queued.length ? `${queued.length} queued` : ""].filter(Boolean);
	const lines = [`Background · ${counts.join(" · ") || "finishing"}`];
	for (const activity of pool.slice(0, RPC_MAX_CARDS)) lines.push(...compactCard(activity, now));
	const hidden = pool.length - RPC_MAX_CARDS;
	if (hidden > 0) lines.push(`+${hidden} more ${running.length > 0 ? "running" : "queued"}`);
	return lines.map(clipLine);
}

interface LinesUI {
	setWidget(id: string, content: string[] | undefined): void;
}

export interface RpcStatusOptions {
	/** Minimum time between published updates. */
	intervalMs?: number;
	/** Republish while work is active, so elapsed time advances during silence. */
	refreshMs?: number;
}

/**
 * Publishes background status as string-array widget updates, which pi's RPC
 * mode forwards to its client as `setWidget` requests. Job changes arrive per
 * child event, so `changed()` only schedules: at most one update per interval,
 * rendered from a fresh snapshot. The widget is cleared as soon as nothing is active.
 */
export class RpcStatusWidget {
	private ui: LinesUI;
	private getJobs: () => JobSnapshot[];
	private intervalMs: number;
	private refreshMs: number;
	private lastPublished = 0;
	private pending?: ReturnType<typeof setTimeout>;
	private refresh?: ReturnType<typeof setInterval>;
	private mounted = false;
	private disposed = false;

	constructor(ui: LinesUI, getJobs: () => JobSnapshot[], options: RpcStatusOptions = {}) {
		this.ui = ui;
		this.getJobs = getJobs;
		this.intervalMs = options.intervalMs ?? 1_000;
		this.refreshMs = options.refreshMs ?? 5_000;
	}

	changed(): void {
		if (this.disposed) return;
		if (this.mounted && !this.getJobs().some(isActive)) {
			// Clear at once, so the status ends before any completion turn starts.
			if (this.pending) clearTimeout(this.pending);
			this.pending = undefined;
			this.publish();
			return;
		}
		if (this.pending) return;
		const wait = this.lastPublished + this.intervalMs - Date.now();
		if (wait <= 0) {
			this.publish();
			return;
		}
		this.pending = setTimeout(() => {
			this.pending = undefined;
			this.publish();
		}, wait);
		this.pending.unref?.();
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (this.pending) clearTimeout(this.pending);
		this.pending = undefined;
		this.unmount();
	}

	private publish(): void {
		if (this.disposed) return;
		this.lastPublished = Date.now();
		const lines = rpcStatusLines(this.getJobs());
		if (lines.length === 0) {
			this.unmount();
			return;
		}
		this.mounted = true;
		this.send(lines);
		if (!this.refresh) {
			this.refresh = setInterval(() => this.changed(), this.refreshMs);
			this.refresh.unref?.();
		}
	}

	private unmount(): void {
		if (this.refresh) clearInterval(this.refresh);
		this.refresh = undefined;
		if (this.mounted) {
			this.mounted = false;
			this.send(undefined);
		}
	}

	/** Runs inside the job registry's listeners; a failing UI must not break job settlement. */
	private send(lines: string[] | undefined): void {
		try {
			this.ui.setWidget(WIDGET_ID, lines);
		} catch {
			// Status is best effort; the next update tries again.
		}
	}
}
