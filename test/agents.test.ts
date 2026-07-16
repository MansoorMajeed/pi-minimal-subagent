import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_MAX_TURNS, resolveAgentRuntimeOptions } from "../src/agent-options.ts";

test("agent frontmatter preserves omitted and empty extension semantics", () => {
	assert.equal(resolveAgentRuntimeOptions({}).extensions, undefined);
	assert.deepEqual(resolveAgentRuntimeOptions({ extensions: null }).extensions, []);
	assert.deepEqual(resolveAgentRuntimeOptions({ extensions: "/tmp/a.ts, /tmp/b.ts" }).extensions, ["/tmp/a.ts", "/tmp/b.ts"]);
	assert.equal(resolveAgentRuntimeOptions({ inheritProjectContext: false }).inheritProjectContext, false);
	assert.equal(resolveAgentRuntimeOptions({ maxTurns: 7 }).maxTurns, 7);
	assert.equal(resolveAgentRuntimeOptions({ maxTurns: 0 }).maxTurns, DEFAULT_MAX_TURNS);
	assert.equal(resolveAgentRuntimeOptions({}).inheritProjectContext, true);
	assert.equal(resolveAgentRuntimeOptions({}).maxTurns, DEFAULT_MAX_TURNS);
});
