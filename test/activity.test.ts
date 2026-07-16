import assert from "node:assert/strict";
import test from "node:test";
import { applyActivityEvent, createActivity, JsonLineParser } from "../src/activity.ts";

test("JsonLineParser preserves partial chunks and ignores malformed lines", () => {
	const parser = new JsonLineParser();
	assert.deepEqual(parser.push('{"type":"agent_start"}\n{"type":"tool_exec'), [{ type: "agent_start" }]);
	assert.deepEqual(parser.push('ution_start","toolName":"read","args":{"path":"src/index.ts"}}\nnot-json\n'), [
		{ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } },
	]);
	assert.deepEqual(parser.flush(), []);
});

test("activity reducer keeps compact current and recent child activity", () => {
	const activity = createActivity("scout");
	applyActivityEvent(activity, { type: "agent_start" });
	applyActivityEvent(activity, { type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } });
	applyActivityEvent(activity, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Mapped the implementation and found the relevant entry point." }],
			usage: { input: 10, output: 4, cacheRead: 2, cacheWrite: 1, totalTokens: 17, cost: { total: 0.01 } },
		},
	});
	applyActivityEvent(activity, { type: "agent_end" });

	assert.equal(activity.state, "done");
	assert.equal(activity.current, "done");
	assert.deepEqual(activity.recent, ["read src/index.ts", "Mapped the implementation and found the relevant entry point.", "done"]);
	assert.deepEqual(activity.usage, {
		input: 10,
		output: 4,
		cacheRead: 2,
		cacheWrite: 1,
		totalTokens: 17,
		contextTokens: 17,
		cost: 0.01,
		turns: 1,
	});
});

test("usage aggregates assistant messages but ignores repeated turn event forms", () => {
	const activity = createActivity("worker");
	const first = {
		role: "assistant",
		content: [{ type: "text", text: "first" }],
		usage: { input: 100, output: 20, cacheRead: 80, cacheWrite: 0, totalTokens: 200, cost: { total: 0.03 } },
	};
	applyActivityEvent(activity, { type: "message_end", message: first });
	applyActivityEvent(activity, { type: "turn_end", message: first });
	applyActivityEvent(activity, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "second" }],
			usage: { input: 50, output: 10, totalTokens: 60 },
		},
	});
	applyActivityEvent(activity, { type: "message_end", message: { role: "toolResult", content: [] } });

	assert.deepEqual(activity.usage, {
		input: 150,
		output: 30,
		cacheRead: 80,
		cacheWrite: 0,
		totalTokens: 260,
		contextTokens: 60,
		cost: 0.03,
		turns: 2,
	});
});

test("activity text is single-line, bounded, and deduplicated", () => {
	const activity = createActivity("reviewer");
	const long = `first\n${"x".repeat(150)}`;
	applyActivityEvent(activity, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: long } });
	const first = activity.current;
	applyActivityEvent(activity, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "" } });

	assert.equal(first.includes("\n"), false);
	assert.ok(first.length <= 101);
	assert.equal(activity.recent.filter((item) => item === first).length, 1);
});
