import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

test("installed runtime replacement never consumes busy or pending background completion", { timeout: 20_000 }, () => {
	const output = execFileSync(process.execPath, ["test/fixtures/runtime-race.mjs"], { encoding: "utf8" });
	const results = JSON.parse(output) as Array<{ name: string; streamCalls: number; customCompletions: number }>;
	assert.deepEqual(results, [
		{ name: "completion-during-abort", streamCalls: 1, customCompletions: 0 },
		{ name: "completion-pending-before-abort", streamCalls: 1, customCompletions: 0 },
	]);
});
