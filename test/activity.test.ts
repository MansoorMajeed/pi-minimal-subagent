import assert from "node:assert/strict";
import test from "node:test";
import { applyActivityEvent, createActivity, displayGoal, JsonLineParser, sanitizeTerminalText } from "../src/activity.ts";

test("JsonLineParser preserves partial chunks and ignores malformed lines", () => {
	const parser = new JsonLineParser();
	assert.deepEqual(parser.push('{"type":"agent_start"}\n{"type":"tool_exec'), [{ type: "agent_start" }]);
	assert.deepEqual(parser.push('ution_start","toolName":"read","args":{"path":"src/index.ts"}}\nnot-json\n'), [
		{ type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } },
	]);
	assert.deepEqual(parser.flush(), []);
});

test("display goals prefer a normalized label and fall back to a clipped task preview", () => {
	assert.equal(displayGoal("  Review\n auth\tchanges  ", "ignored"), "Review auth changes");
	assert.equal(displayGoal(undefined, "  Inspect\n the auth flow  "), "Inspect the auth flow");
	assert.ok(displayGoal(undefined, "x".repeat(150)).length <= 101);
	assert.equal(displayGoal("\x1b[2JGoal", "ignored"), "Goal");
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
	assert.deepEqual(activity.recent, [
		"queued",
		"started",
		"read src/index.ts",
		"writing response",
		"done",
	]);
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

test("assistant response bodies use one stable writing activity", () => {
	const activity = createActivity("scout");
	const streamedAnswer = `streamed-${"x".repeat(200)}`;
	const finalAnswer = `final-${"y".repeat(200)}`;
	applyActivityEvent(activity, { type: "turn_start" });
	applyActivityEvent(activity, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: streamedAnswer } });
	applyActivityEvent(activity, { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: " more" } });
	applyActivityEvent(activity, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: finalAnswer }] },
	});

	assert.equal(activity.current, "writing response");
	assert.deepEqual(activity.recent, ["queued", "thinking", "writing response"]);
	assert.ok(activity.recent.every((entry) => !entry.includes("streamed-") && !entry.includes("final-")));

	for (const path of ["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts"]) {
		applyActivityEvent(activity, { type: "tool_execution_start", toolName: "read", args: { path } });
	}
	assert.deepEqual(activity.recent, ["read b.ts", "read c.ts", "read d.ts", "read e.ts", "read f.ts"]);
});

test("activity shows the configured model then captures the observed provider and model", () => {
	const configured = createActivity("worker", "anthropic/claude-sonnet-4:high");
	assert.equal(configured.model, "anthropic/claude-sonnet-4:high");

	applyActivityEvent(configured, {
		type: "message_start",
		message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4" },
	});
	assert.equal(configured.model, "anthropic/claude-sonnet-4");
	applyActivityEvent(configured, {
		type: "message_end",
		message: { role: "assistant", model: "claude-sonnet-4", content: [] },
	});
	assert.equal(configured.model, "anthropic/claude-sonnet-4");

	const fallback = createActivity("scout");
	assert.equal(fallback.model, "default");
	applyActivityEvent(fallback, {
		type: "message_end",
		message: { role: "assistant", provider: "openai", model: "gpt-5", content: [] },
	});
	assert.equal(fallback.model, "openai/gpt-5");
});

test("completed assistant progress reports are retained separately from tool activity", () => {
	const activity = createActivity("worker");
	applyActivityEvent(activity, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Progress: mapped auth\nOrdinary explanation" }],
		},
	});
	assert.equal(activity.reported, "mapped auth");
	assert.equal(activity.current, "writing response");

	applyActivityEvent(activity, { type: "tool_execution_start", toolName: "read", args: { path: "src/auth.ts" } });
	assert.equal(activity.reported, "mapped auth");
	applyActivityEvent(activity, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "ordinary answer" }] },
	});
	assert.equal(activity.reported, "mapped auth");

	applyActivityEvent(activity, {
		type: "message_end",
		message: {
			role: "assistant",
			content: [{ type: "text", text: "Progress: first\nProgress: \x1b[2Jsecond\tstep\nProgress:   " }],
		},
	});
	assert.equal(activity.reported, "second step");
});

test("progress parser ignores empty reports and non-assistant event text", () => {
	const activity = createActivity("worker");
	applyActivityEvent(activity, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "text", text: "Progress:   \nnot a report" }] },
	});
	applyActivityEvent(activity, {
		type: "message_end",
		message: { role: "toolResult", content: [{ type: "text", text: "Progress: forged" }] },
	});
	applyActivityEvent(activity, { type: "tool_execution_end", toolName: "Progress: forged", isError: false });
	applyActivityEvent(activity, { type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "Progress: forged" }] } });
	assert.equal(activity.reported, undefined);
});

test("tool-only assistant messages do not overwrite useful tool status", () => {
	const activity = createActivity("worker");
	applyActivityEvent(activity, { type: "tool_execution_start", toolName: "read", args: { path: "src/index.ts" } });
	applyActivityEvent(activity, { type: "tool_execution_end", toolName: "read", isError: false });
	applyActivityEvent(activity, {
		type: "message_end",
		message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: { path: "src/index.ts" } }] },
	});

	assert.equal(activity.current, "read finished");
	assert.deepEqual(activity.recent, ["queued", "read src/index.ts", "read finished"]);
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
	applyActivityEvent(activity, { type: "tool_execution_start", toolName: "bash", args: { command: long } });
	const first = activity.current;
	applyActivityEvent(activity, { type: "tool_execution_start", toolName: "bash", args: { command: long } });

	assert.equal(first.includes("\n"), false);
	assert.ok(first.length <= 101);
	assert.equal(activity.recent.filter((item) => item === first).length, 1);
});

test("terminal text sanitizer removes ANSI, OSC, string controls, and raw controls", () => {
	const unsafe = [
		"before",
		"\x1b[2J",
		"\x1b]52;c;SGVsbG8=\x07",
		"\x1b]0;title\x1b\\",
		"\x1b_payload\x1b\\",
		"\x00\x08\x7f\x85",
		"after\nnext",
	].join("");
	assert.equal(sanitizeTerminalText(unsafe), "beforeafter\nnext");
});
