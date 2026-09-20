import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../src/result-summary.ts";
import type { SubagentResult } from "../src/spawn.ts";

function result(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		agent: "worker",
		ok: false,
		answer: "",
		inlineAnswer: "",
		exitCode: 1,
		logPath: "/tmp/worker.jsonl",
		timedOut: false,
		turnLimitExceeded: false,
		activity: {} as SubagentResult["activity"],
		usage: {} as SubagentResult["usage"],
		...overrides,
	};
}

test("successful result formatting remains unchanged", () => {
	assert.equal(
		summarize([result({ ok: true, answer: "complete", inlineAnswer: "complete", exitCode: 0 })]),
		"### [1] worker — ok\ncomplete\n\n_log: /tmp/worker.jsonl_",
	);
});

test("error-only failures retain the no-answer diagnostic", () => {
	assert.equal(
		summarize([result({ error: "Provider quota exceeded" })]),
		"### [1] worker — FAILED\n(no answer: Provider quota exceeded)\n\n_log: /tmp/worker.jsonl_",
	);
});

test("partial failed results display the answer and a labeled diagnostic", () => {
	const summary = summarize([
		result({ answer: "partial answer", inlineAnswer: "partial answer", error: "Provider quota exceeded" }),
	]);
	assert.match(summary, /### \[1\] worker — FAILED/);
	assert.match(summary, /partial answer/);
	assert.match(summary, /Diagnostic:.*Provider quota exceeded/);
	assert.doesNotMatch(summary, /no answer/);
	assert.match(summary, /_log: \/tmp\/worker\.jsonl_/);
});

test("partial timeout, turn-limit, and aborted results retain reasons and log paths", () => {
	const summary = summarize([
		result({ agent: "timer", answer: "timer partial", inlineAnswer: "timer partial", timedOut: true, error: "timed out", logPath: "/tmp/timer.jsonl" }),
		result({ agent: "limited", answer: "limit partial", inlineAnswer: "limit partial", turnLimitExceeded: true, error: "turn limit reached (2)", logPath: "/tmp/limited.jsonl" }),
		result({ agent: "stopped", answer: "abort partial", inlineAnswer: "abort partial", exitCode: null, error: "aborted", logPath: "/tmp/stopped.jsonl" }),
	]);
	assert.match(summary, /### \[1\] timer — TIMED OUT[\s\S]*timer partial[\s\S]*Diagnostic:.*timed out[\s\S]*_log: \/tmp\/timer\.jsonl_/);
	assert.match(summary, /### \[2\] limited — TURN LIMIT[\s\S]*limit partial[\s\S]*Diagnostic:.*turn limit reached \(2\)[\s\S]*_log: \/tmp\/limited\.jsonl_/);
	assert.match(summary, /### \[3\] stopped — FAILED[\s\S]*abort partial[\s\S]*Diagnostic:.*aborted[\s\S]*_log: \/tmp\/stopped\.jsonl_/);
	assert.doesNotMatch(summary, /no answer/);
});
