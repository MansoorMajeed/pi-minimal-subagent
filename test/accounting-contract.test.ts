import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

function canonicalDetails(entry: any): any | undefined {
	if (entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "subagent") {
		return entry.message.details;
	}
	if (entry.type === "custom_message" && entry.customType === "minimal-subagent-complete") {
		return entry.details;
	}
}

function canonicalResults(entries: any[]): any[] {
	const seenEntries = new Set<string>();
	const byChild = new Map<string, any>();
	for (const entry of entries) {
		if (typeof entry.id === "string" && seenEntries.has(entry.id)) continue;
		if (typeof entry.id === "string") seenEntries.add(entry.id);
		const details = canonicalDetails(entry);
		const runIdentity = details?.jobId ?? details?.runDir;
		if (typeof runIdentity !== "string" || !Array.isArray(details?.results)) continue;
		details.results.forEach((result: any, index: number) => {
			byChild.set(JSON.stringify([runIdentity, index]), result);
		});
	}
	return [...byChild.values()];
}

test("accounting fixtures count one result per run and task across terminal snapshots", () => {
	const entries = JSON.parse(fs.readFileSync(new URL("fixtures/accounting-entries.json", import.meta.url), "utf8"));
	const results = canonicalResults(entries);
	assert.equal(results.length, 4);
	assert.equal(results.reduce((sum: number, result: any) => sum + result.usage.totalTokens, 0), 425);
	assert.ok(Math.abs(results.reduce((sum: number, result: any) => sum + result.usage.cost, 0) - 0.039) < 1e-12);
	assert.deepEqual(
		entries.filter((entry: any) => (entry.details ?? entry.message?.details)?.jobId === "background-run").map((entry: any) => entry.id),
		["background-completion-entry", "background-status-entry", "background-cancel-entry"],
	);
	assert.equal(entries.find((entry: any) => entry.id === "cancelled-job-entry").message.details.results[0].usage.totalTokens, 40);
});

test("accounting guide names both canonical entry types and their deduplication rule", () => {
	const guide = fs.readFileSync(new URL("docs/stats-accounting-integration.md", root), "utf8");
	assert.match(guide, /entry\.type == "custom_message"/);
	assert.match(guide, /entry\.customType == "minimal-subagent-complete"/);
	assert.match(guide, /details\.activities\[index\]\.usage/);
	assert.match(guide, /details\.jobId \?\? details\.runDir/);
	assert.match(guide, /result index/i);
	assert.match(guide, /\/subagent-cancel.*does not persist.*result/i);
});
