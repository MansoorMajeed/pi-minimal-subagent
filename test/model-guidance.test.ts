import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { loadModelGuide, searchModels } from "../src/model-guidance.ts";

function withAgentDir(fn: (dir: string) => void): void {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-model-guide-"));
	try {
		fn(dir);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("missing global guide loads the bundled model and provider preferences", () => {
	withAgentDir((dir) => {
		const guide = loadModelGuide(dir);
		assert.equal(guide.filePath, new URL("../SUBAGENT_MODELS.md", import.meta.url).pathname);
		for (const model of ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-6-astra"]) assert.ok(guide.text.includes(model));
		assert.match(guide.text, /openai-codex/);
		assert.match(guide.text, /openrouter/);
		assert.match(guide.text, /xhigh/);
	});
});

test("global guide replaces rather than merges and is reread on each discovery", () => {
	withAgentDir((dir) => {
		const filePath = path.join(dir, "SUBAGENT_MODELS.md");
		fs.writeFileSync(filePath, "Only use my local model.\n");
		assert.deepEqual(loadModelGuide(dir), { filePath, text: "Only use my local model.\n" });
		fs.writeFileSync(filePath, "Updated preference");
		assert.equal(loadModelGuide(dir).text, "Updated preference");
		fs.writeFileSync(filePath, "");
		assert.equal(loadModelGuide(dir).text, "");
	});
});

test("unreadable global guide surfaces its error instead of reverting provider policy", () => {
	withAgentDir((dir) => {
		fs.mkdirSync(path.join(dir, "SUBAGENT_MODELS.md"));
		assert.throws(() => loadModelGuide(dir), { code: "EISDIR" });
	});
});

const models = [
	{ provider: "openrouter", id: "openai/gpt-5.6-luna", name: "Luna via router" },
	{ provider: "openai-codex", id: "gpt-5.6-sol", name: "Sol" },
	{ provider: "local", id: "custom-123", name: "Luna local" },
	{ provider: "openai-codex", id: "gpt-5.6-luna", name: "Luna" },
];

test("model search matches names and exact provider/id substrings case-insensitively", () => {
	assert.deepEqual(searchModels(models, "  LUNA  "), {
		matches: [models[2], models[3], models[0]],
		total: 3,
	});
	assert.deepEqual(searchModels(models, "OPENAI-CODEX/gpt-5.6-sol"), { matches: [models[1]], total: 1 });
	assert.equal(searchModels(models, "openai-codex").total, 2);
	assert.deepEqual(models[0], { provider: "openrouter", id: "openai/gpt-5.6-luna", name: "Luna via router" });
});

test("model search requires a nonblank literal query and reports no matches", () => {
	for (const query of ["", "   "]) assert.throws(() => searchModels(models, query), /nonblank query/);
	assert.deepEqual(searchModels(models, ".*"), { matches: [], total: 0 });
	assert.deepEqual(searchModels([], "luna"), { matches: [], total: 0 });
	assert.deepEqual(searchModels(models, "missing"), { matches: [], total: 0 });
});

test("large catalogues are filtered before returning at most fifty sorted matches", () => {
	const catalogue = Array.from({ length: 2_000 }, (_, index) => ({
		provider: "local", id: `model-${String(index).padStart(4, "0")}`, name: `Model ${index}`,
	})).reverse();
	const broad = searchModels(catalogue, "model");
	assert.equal(broad.total, 2_000);
	assert.equal(broad.matches.length, 50);
	assert.equal(broad.matches[0].id, "model-0000");
	assert.equal(broad.matches[49].id, "model-0049");
	const narrow = searchModels(catalogue, "model-1999");
	assert.equal(narrow.total, 1);
	assert.equal(narrow.matches[0].id, "model-1999");
});
