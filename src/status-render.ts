import { type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { sanitizeTerminalText, type ChildActivity } from "./activity.ts";
import { singleLineStatusText, type StatusHeaderRow, type StatusRow } from "./status-layout.ts";

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

export function expandedTaskText(activities: ChildActivity[], completedOutput?: string): string {
	const tasks = activities
		.map((activity, index) => `Task [${index + 1}] ${singleLineStatusText(activity.agent)}\n${sanitizeTerminalText(activity.task)}`)
		.join("\n\n");
	return completedOutput ? `${tasks}\n\nCompleted output\n${completedOutput}` : tasks;
}
