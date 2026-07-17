import type { ActivityState, ChildActivity, UsageSummary } from "./activity.ts";

export interface StatusHeaderRow {
	kind: "header";
	agent: string;
	state: ActivityState;
	usage: string;
}

export interface StatusDetailRow {
	kind: "detail";
	text: string;
	historical: boolean;
}

export type StatusRow = StatusHeaderRow | StatusDetailRow;

function formatUsage(usage: UsageSummary): string {
	const parts: string[] = [];
	if (usage.turns > 0) parts.push(`${usage.turns} turn${usage.turns === 1 ? "" : "s"}`);
	if (usage.totalTokens > 0) parts.push(`${usage.totalTokens.toLocaleString()} tok`);
	if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.length ? `[${parts.join(" · ")}]` : "";
}

export function buildStatusRows(activities: ChildActivity[], expanded: boolean): StatusRow[] {
	const rows: StatusRow[] = [];
	for (const activity of activities) {
		rows.push({
			kind: "header",
			agent: activity.agent,
			state: activity.state,
			usage: formatUsage(activity.usage),
		});

		if (!expanded) {
			rows.push({ kind: "detail", text: activity.current, historical: false });
			continue;
		}

		const recent = activity.recent.slice(-3);
		for (let i = recent.length; i < 3; i++) rows.push({ kind: "detail", text: "", historical: true });
		for (const text of recent) rows.push({ kind: "detail", text, historical: true });
	}
	return rows;
}
