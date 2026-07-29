import { MAX_RECENT_ACTIVITY, sanitizeTerminalText, type ActivityState, type ChildActivity, type UsageSummary } from "./activity.ts";

export interface StatusHeaderRow {
	kind: "header";
	agent: string;
	model?: string;
	state: ActivityState;
	usage: string;
}

export interface StatusDetailRow {
	kind: "detail";
	text: string;
	historical: boolean;
}

export type StatusRow = StatusHeaderRow | StatusDetailRow;

export function singleLineStatusText(value: unknown): string {
	return sanitizeTerminalText(value).replace(/\s+/g, " ").trim();
}

function formatUsage(usage: UsageSummary): string {
	const parts: string[] = [];
	if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.totalTokens > 0) parts.push(`${usage.totalTokens.toLocaleString()} tok`);
	if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.length ? `[${parts.join(" · ")}]` : "";
}

export function buildStatusRows(activities: ChildActivity[]): StatusRow[] {
	const rows: StatusRow[] = [];
	for (const activity of activities) {
		rows.push({
			kind: "header",
			agent: activity.agent,
			model: activity.model,
			state: activity.state,
			usage: formatUsage(activity.usage),
		});

		const recent = activity.recent.slice(-MAX_RECENT_ACTIVITY);
		for (let i = recent.length; i < MAX_RECENT_ACTIVITY; i++) rows.push({ kind: "detail", text: "", historical: true });
		for (const text of recent) rows.push({ kind: "detail", text, historical: true });
	}
	return rows;
}
