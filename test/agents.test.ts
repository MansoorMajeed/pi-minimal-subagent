import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_TIMEOUT_MS, MAX_TIMER_DELAY_MS, resolveAgentRuntimeOptions } from "../src/agent-options.ts";

test("agent frontmatter preserves omitted and empty extension semantics", () => {
	assert.equal(resolveAgentRuntimeOptions({}).extensions, undefined);
	assert.deepEqual(resolveAgentRuntimeOptions({ extensions: null }).extensions, []);
	assert.deepEqual(resolveAgentRuntimeOptions({ extensions: "/tmp/a.ts, /tmp/b.ts" }).extensions, ["/tmp/a.ts", "/tmp/b.ts"]);
	assert.equal(resolveAgentRuntimeOptions({ inheritProjectContext: false }).inheritProjectContext, false);
	assert.equal(resolveAgentRuntimeOptions({ maxTurns: 7 }).maxTurns, 7);
	assert.equal(resolveAgentRuntimeOptions({ maxTurns: 0 }).maxTurns, undefined);
	assert.equal(resolveAgentRuntimeOptions({ maxTurns: -1 }).maxTurns, undefined);
	assert.equal(resolveAgentRuntimeOptions({ maxTurns: 1.5 }).maxTurns, undefined);
	assert.equal(resolveAgentRuntimeOptions({ maxTurns: "7" }).maxTurns, undefined);
	assert.equal(resolveAgentRuntimeOptions({}).inheritProjectContext, true);
	assert.equal(resolveAgentRuntimeOptions({}).maxTurns, undefined);
});

test("agent frontmatter defaults and validates child timeouts", () => {
	assert.equal(resolveAgentRuntimeOptions({}).timeoutMs, DEFAULT_TIMEOUT_MS);
	assert.equal(resolveAgentRuntimeOptions({ timeoutMs: 60_000 }).timeoutMs, 60_000);
	assert.equal(resolveAgentRuntimeOptions({ timeoutMs: 0 }).timeoutMs, DEFAULT_TIMEOUT_MS);
	assert.equal(resolveAgentRuntimeOptions({ timeoutMs: -1 }).timeoutMs, DEFAULT_TIMEOUT_MS);
	assert.equal(resolveAgentRuntimeOptions({ timeoutMs: 1.5 }).timeoutMs, DEFAULT_TIMEOUT_MS);
	assert.equal(resolveAgentRuntimeOptions({ timeoutMs: "60000" }).timeoutMs, DEFAULT_TIMEOUT_MS);
	assert.equal(resolveAgentRuntimeOptions({ timeoutMs: MAX_TIMER_DELAY_MS + 1 }).timeoutMs, DEFAULT_TIMEOUT_MS);
});
