import assert from "node:assert/strict";
import test from "node:test";
import { buildStatusRows } from "../src/status-layout.ts";
import type { ChildActivity } from "../src/activity.ts";

function activity(overrides: Partial<ChildActivity> = {}): ChildActivity {
	return {
		agent: "scout",
		model: "anthropic/claude-sonnet-4",
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

test("status layout always emits a header and five activity rows", () => {
	const rows = buildStatusRows([activity()]);

	assert.equal(rows.length, 6);
	assert.deepEqual(rows[0], {
		kind: "header",
		agent: "scout",
		model: "anthropic/claude-sonnet-4",
		state: "running",
		usage: "[2 turns · 1,234 tok · $0.0123]",
	});
	assert.deepEqual(rows.slice(1), [
		{ kind: "detail", text: "", historical: true },
		{ kind: "detail", text: "", historical: true },
		{ kind: "detail", text: "queued", historical: true },
		{ kind: "detail", text: "starting", historical: true },
		{ kind: "detail", text: "read src/index.ts", historical: true },
	]);
});

test("status layout pads missing history above and anchors newest activity at the bottom", () => {
	const rows = buildStatusRows([activity({ recent: ["read README.md"] })]);

	assert.equal(rows.length, 6);
	assert.equal(rows[0].kind, "header");
	assert.deepEqual(rows.slice(1), [
		{ kind: "detail", text: "", historical: true },
		{ kind: "detail", text: "", historical: true },
		{ kind: "detail", text: "", historical: true },
		{ kind: "detail", text: "", historical: true },
		{ kind: "detail", text: "read README.md", historical: true },
	]);
});

test("status layout keeps only the latest five activity entries", () => {
	const rows = buildStatusRows([
		activity({ recent: ["queued", "starting", "read a.ts", "read b.ts", "read c.ts", "read d.ts"] }),
	]);

	assert.deepEqual(rows.slice(1), [
		{ kind: "detail", text: "starting", historical: true },
		{ kind: "detail", text: "read a.ts", historical: true },
		{ kind: "detail", text: "read b.ts", historical: true },
		{ kind: "detail", text: "read c.ts", historical: true },
		{ kind: "detail", text: "read d.ts", historical: true },
	]);
});

test("multiple children preserve order and fixed row counts", () => {
	const activities = [
		activity({ agent: "scout" }),
		activity({ agent: "reviewer", state: "done", current: "done", recent: ["done"] }),
	];

	const rows = buildStatusRows(activities);
	assert.equal(rows.length, 12);
	assert.deepEqual(rows.filter((row) => row.kind === "header").map((row) => row.agent), ["scout", "reviewer"]);
});

test("absent usage does not add an empty accounting label", () => {
	const rows = buildStatusRows([
		activity({
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, contextTokens: 0, cost: 0, turns: 0 },
		}),
	]);

	assert.equal(rows[0].kind, "header");
	assert.equal(rows[0].usage, "");
});
