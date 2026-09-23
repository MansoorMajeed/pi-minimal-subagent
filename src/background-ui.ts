import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { sanitizeTerminalText } from "./activity.ts";
import type { JobSnapshot } from "./jobs.ts";
import { SubagentStatusComponent } from "./status-render.ts";
import { buildStatusRows } from "./status-layout.ts";

const WIDGET_ID = "minimal-subagent-background";

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
