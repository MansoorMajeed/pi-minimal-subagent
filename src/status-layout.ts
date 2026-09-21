import { sanitizeTerminalText, type ActivityState, type ChildActivity, type UsageSummary } from "./activity.ts";

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
	if (usage.totalTokens > 0) parts.push(`${usage.totalTokens.toLocaleString()} tok`);
	if (usage.cost > 0) parts.push(`$${usage.cost.toFixed(4)}`);
	return parts.length ? `[${parts.join(" · ")}]` : "";
}

function formatDuration(milliseconds: number): string {
	let seconds = Math.max(0, Math.floor(milliseconds / 1000));
	const hours = Math.floor(seconds / 3600);
	seconds %= 3600;
	const minutes = Math.floor(seconds / 60);
	seconds %= 60;
	const parts: string[] = [];
	if (hours > 0) parts.push(`${hours}h`);
	if (minutes > 0 || hours > 0) parts.push(`${minutes}m`);
	parts.push(`${seconds}s`);
	return parts.join(" ");
}

function formatTurns(activity: ChildActivity): string {
	const turns = activity.usage.turns;
	return activity.maxTurns === undefined
		? `${turns} turn${turns === 1 ? "" : "s"}`
		: `${turns}/${activity.maxTurns} turns`;
}

export function activityTimingText(activity: ChildActivity, now = Date.now()): string {
	if (activity.state === "queued") return "Queued";
	if (activity.startedAt === undefined) return `Not started · ${formatTurns(activity)}`;
	if (activity.endedAt === undefined) {
		const timeout = activity.deadlineAt === undefined ? "" : ` · timeout in ${formatDuration(activity.deadlineAt - now)}`;
		return `Elapsed ${formatDuration(now - activity.startedAt)}${timeout} · ${formatTurns(activity)}`;
	}
	return `Elapsed ${formatDuration(activity.endedAt - activity.startedAt)} · ${formatTurns(activity)}`;
}

export function buildStatusRows(activities: ChildActivity[], now = Date.now()): StatusRow[] {
	const rows: StatusRow[] = [];
	for (const activity of activities) {
		rows.push({
			kind: "header",
			agent: activity.agent,
			model: activity.model,
			state: activity.state,
			usage: formatUsage(activity.usage),
		});
		rows.push({ kind: "detail", text: `Goal: ${singleLineStatusText(activity.goal)}`, historical: false });
		rows.push({ kind: "detail", text: activityTimingText(activity, now), historical: false });
		rows.push({
			kind: "detail",
			text: `Reported: ${activity.reported ? singleLineStatusText(activity.reported) : "no update yet"}`,
			historical: false,
		});

		const recent = activity.recent.slice(-2).map(singleLineStatusText);
		for (let i = recent.length; i < 2; i++) rows.push({ kind: "detail", text: "", historical: true });
		for (const text of recent) rows.push({ kind: "detail", text, historical: true });
	}
	return rows;
}
