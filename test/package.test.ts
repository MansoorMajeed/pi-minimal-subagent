import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";

const root = new URL("../", import.meta.url);

test("package exposes the extension without a model-invoked skill", () => {
	const pkg = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8"));
	assert.deepEqual(pkg.pi, { extensions: ["./src/index.ts"] });
	assert.equal(fs.existsSync(new URL("skills/minimal-subagent/SKILL.md", root)), false);
});

test("packed extension includes its model guide and loader", () => {
	const cache = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-npm-cache-"));
	try {
		const output = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts", "--cache", cache], {
			cwd: root,
			encoding: "utf8",
		});
		const files = JSON.parse(output)[0].files.map((file: { path: string }) => file.path);
		assert.ok(files.includes("SUBAGENT_MODELS.md"));
		assert.ok(files.includes("src/model-guidance.ts"));
	} finally {
		fs.rmSync(cache, { recursive: true, force: true });
	}
});
