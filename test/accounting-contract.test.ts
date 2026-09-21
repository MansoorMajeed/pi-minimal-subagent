import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

function canonicalResults(entry: any): any[] {
	if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagent") {
		return entry.message.details?.results ?? [];
	}
	if (entry.type === "custom_message" && entry.customType === "minimal-subagent-complete") {
		return entry.details?.results ?? [];
	}
	return [];
}

test("accounting fixtures cover blocking and background persistence without copied-view double counting", () => {
	const entries = JSON.parse(fs.readFileSync(new URL("fixtures/accounting-entries.json", import.meta.url), "utf8"));
	const results = entries.flatMap(canonicalResults);
	assert.equal(results.length, 2);
	assert.equal(results.reduce((sum: number, result: any) => sum + result.usage.totalTokens, 0), 330);
	assert.equal(results.reduce((sum: number, result: any) => sum + result.usage.cost, 0), 0.03);
	assert.ok(entries.some((entry: any) => entry.type === "message"));
	assert.ok(entries.some((entry: any) => entry.type === "custom_message"));
});

test("accounting guide names both canonical entry types and their deduplication rule", () => {
	const guide = fs.readFileSync(new URL("docs/stats-accounting-integration.md", root), "utf8");
	assert.match(guide, /entry\.type == "custom_message"/);
	assert.match(guide, /entry\.customType == "minimal-subagent-complete"/);
	assert.match(guide, /details\.activities\[index\]\.usage/);
	assert.match(guide, /same persisted entry ID and result index/i);
});
