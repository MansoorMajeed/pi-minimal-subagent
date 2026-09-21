import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("package exposes the extension without a model-invoked skill", () => {
	const pkg = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8"));
	assert.deepEqual(pkg.pi, { extensions: ["./src/index.ts"] });
	assert.equal(fs.existsSync(new URL("skills/minimal-subagent/SKILL.md", root)), false);
	assert.equal(fs.existsSync(new URL("SUBAGENT_MODELS.md", root)), true);
});
