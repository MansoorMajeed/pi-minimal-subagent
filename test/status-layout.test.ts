import assert from "node:assert/strict";
import test from "node:test";
import { buildStatusRows } from "../src/status-layout.ts";
import type { ChildActivity } from "../src/activity.ts";

function activity(overrides: Partial<ChildActivity> = {}): ChildActivity {
	return {
		agent: "scout",
		state: "running",
		current: "read src/index.ts",
		recent: ["queued", "starting", "read src/index.ts"],
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

test("collapsed layout always emits a header and current-activity row", () => {
	const rows = buildStatusRows([activity()], false);

	assert.equal(rows.length, 2);
	assert.deepEqual(rows[0], {
		kind: "header",
		agent: "scout",
		state: "running",
		usage: "[2 turns · 1,234 tok · $0.0123]",
	});
	assert.deepEqual(rows[1], { kind: "detail", text: "read src/index.ts", historical: false });
});

test("expanded layout pads missing history above and anchors newest activity at the bottom", () => {
	const rows = buildStatusRows([activity({ recent: ["read README.md"] })], true);

	assert.equal(rows.length, 4);
	assert.equal(rows[0].kind, "header");
	assert.deepEqual(rows.slice(1), [
		{ kind: "detail", text: "", historical: true },
		{ kind: "detail", text: "", historical: true },
		{ kind: "detail", text: "read README.md", historical: true },
	]);
});

test("expanded layout keeps only the latest three activity entries", () => {
	const rows = buildStatusRows([
		activity({ recent: ["queued", "starting", "read a.ts", "read b.ts"] }),
	], true);

	assert.deepEqual(rows.slice(1), [
		{ kind: "detail", text: "starting", historical: true },
		{ kind: "detail", text: "read a.ts", historical: true },
		{ kind: "detail", text: "read b.ts", historical: true },
	]);
});

test("multiple children preserve order and fixed row counts", () => {
	const activities = [
		activity({ agent: "scout" }),
		activity({ agent: "reviewer", state: "done", current: "done", recent: ["done"] }),
	];

	const collapsed = buildStatusRows(activities, false);
	assert.equal(collapsed.length, 4);
	assert.deepEqual(collapsed.filter((row) => row.kind === "header").map((row) => row.agent), ["scout", "reviewer"]);

	const expanded = buildStatusRows(activities, true);
	assert.equal(expanded.length, 8);
	assert.deepEqual(expanded.filter((row) => row.kind === "header").map((row) => row.agent), ["scout", "reviewer"]);
});

test("absent usage does not add an empty accounting label", () => {
	const rows = buildStatusRows([
		activity({
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, contextTokens: 0, cost: 0, turns: 0 },
		}),
	], false);

	assert.equal(rows[0].kind, "header");
	assert.equal(rows[0].usage, "");
});
