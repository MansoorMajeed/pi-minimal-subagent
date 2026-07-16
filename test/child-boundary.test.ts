import assert from "node:assert/strict";
import test from "node:test";
import { isMinimalSubagentChild, MINIMAL_SUBAGENT_CHILD_ENV } from "../src/child-boundary.ts";

test("child boundary recognizes only the explicit marker", () => {
	assert.equal(isMinimalSubagentChild({}), false);
	assert.equal(isMinimalSubagentChild({ [MINIMAL_SUBAGENT_CHILD_ENV]: "0" }), false);
	assert.equal(isMinimalSubagentChild({ [MINIMAL_SUBAGENT_CHILD_ENV]: "1" }), true);
});
