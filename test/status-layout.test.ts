import assert from "node:assert/strict";
import test from "node:test";
import { buildStatusRows, singleLineStatusText } from "../src/status-layout.ts";
import type { ChildActivity } from "../src/activity.ts";

function activity(overrides: Partial<ChildActivity> = {}): ChildActivity {
	return {
		agent: "scout",
		model: "anthropic/claude-sonnet-4",
		task: "Inspect the authentication flow in full detail",
		goal: "Map auth flow",
		state: "running",
		current: "read src/index.ts",
		recent: ["queued", "starting", "read src/index.ts"],
		startedAt: 1_000,
		deadlineAt: 1_801_000,
		usage: {
			input: 100,
			output: 20,
			cacheRead: 1000,
			cacheWrite: 50,
			totalTokens: 1234,
			contextTokens: 1234,
			cost: 0.01234,
			turns: 2,
		},
		...overrides,
	};
}

test("running status uses the exact six-row goal, timing, report, and activity contract", () => {
	const rows = buildStatusRows([activity({ reported: "mapped middleware; inspect token refresh next" })], 193_000);

	assert.equal(rows.length, 6);
	assert.deepEqual(rows, [
		{
			kind: "header",
			agent: "scout",
			model: "anthropic/claude-sonnet-4",
			state: "running",
			usage: "[1,234 tok · $0.0123]",
		},
		{ kind: "detail", text: "Goal: Map auth flow", historical: false },
		{ kind: "detail", text: "Elapsed 3m 12s · timeout in 26m 48s · 2 turns", historical: false },
		{ kind: "detail", text: "Reported: mapped middleware; inspect token refresh next", historical: false },
		{ kind: "detail", text: "starting", historical: true },
		{ kind: "detail", text: "read src/index.ts", historical: true },
	]);
});

test("queued children show no invented runtime and no report", () => {
	const rows = buildStatusRows([
		activity({ state: "queued", startedAt: undefined, deadlineAt: undefined, recent: ["queued"], usage: { ...activity().usage, turns: 0 } }),
	], 500_000);

	assert.deepEqual(rows.slice(1), [
		{ kind: "detail", text: "Goal: Map auth flow", historical: false },
		{ kind: "detail", text: "Queued", historical: false },
		{ kind: "detail", text: "Reported: no update yet", historical: false },
		{ kind: "detail", text: "", historical: true },
		{ kind: "detail", text: "queued", historical: true },
	]);
});

test("terminal elapsed time freezes and explicit turn caps appear only when configured", () => {
	const terminal = buildStatusRows([
		activity({ state: "done", startedAt: 1_000, endedAt: 13_000, deadlineAt: 31_000, maxTurns: 80, recent: ["final", "done"] }),
	], 999_000);
	assert.deepEqual(terminal[2], { kind: "detail", text: "Elapsed 12s · 2/80 turns", historical: false });

	const uncapped = buildStatusRows([activity()], 2_000);
	assert.deepEqual(uncapped[2], { kind: "detail", text: "Elapsed 1s · timeout in 29m 59s · 2 turns", historical: false });
});

test("running timeout countdown clamps at zero", () => {
	const rows = buildStatusRows([activity({ deadlineAt: 2_000 })], 3_000);
	assert.deepEqual(rows[2], { kind: "detail", text: "Elapsed 2s · timeout in 0s · 2 turns", historical: false });
});

test("a never-launched failure does not invent elapsed time", () => {
	const rows = buildStatusRows([activity({ state: "failed", startedAt: undefined, endedAt: undefined })], 5_000);
	assert.deepEqual(rows[2], { kind: "detail", text: "Not started · 2 turns", historical: false });
});

test("activity tail pads above and keeps the latest two entries in chronological order", () => {
	const one = buildStatusRows([activity({ recent: ["read README.md"] })], 2_000);
	assert.deepEqual(one.slice(4), [
		{ kind: "detail", text: "", historical: true },
		{ kind: "detail", text: "read README.md", historical: true },
	]);

	const many = buildStatusRows([activity({ recent: ["queued", "starting", "read a.ts", "read b.ts"] })], 2_000);
	assert.deepEqual(many.slice(4), [
		{ kind: "detail", text: "read a.ts", historical: true },
		{ kind: "detail", text: "read b.ts", historical: true },
	]);
});

test("multiple children preserve order and six rows each", () => {
	const rows = buildStatusRows([
		activity({ agent: "scout" }),
		activity({ agent: "reviewer", state: "done", endedAt: 2_000, recent: ["done"] }),
	], 2_000);
	assert.equal(rows.length, 12);
	assert.deepEqual(rows.filter((row) => row.kind === "header").map((row) => row.agent), ["scout", "reviewer"]);
});

test("status display text collapses multiline and terminal-controlled values", () => {
	assert.equal(singleLineStatusText("error\n  at child\tframe\x1b[2J"), "error at child frame");
});
