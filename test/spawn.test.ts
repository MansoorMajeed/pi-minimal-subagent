import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { MAX_INLINE_ANSWER_BYTES, runSubagent, spillLargeAnswer } from "../src/spawn.ts";

function fakePi(dir: string, body: string): string {
	const binDir = path.join(dir, "bin");
	fs.mkdirSync(binDir);
	const executable = path.join(binDir, "pi");
	fs.writeFileSync(executable, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
	return binDir;
}

function baseOptions(dir: string) {
	return {
		task: "inspect the code",
		label: "scout",
		logPath: path.join(dir, "scout.jsonl"),
		cwd: dir,
		timeoutMs: 5_000,
	};
}

test("runSubagent marks the spawned process as a minimal subagent child", { concurrency: false }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-test-"));
	const oldPath = process.env.PATH;
	const binDir = fakePi(
		dir,
		`const text = process.env.PI_MINIMAL_SUBAGENT_CHILD === "1" ? "marked" : "unmarked";
		process.stdout.write(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text}]}]}) + "\\n");`,
	);
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	try {
		const result = await runSubagent(baseOptions(dir));
		assert.equal(result.ok, true);
		assert.equal(result.answer, "marked");
	} finally {
		process.env.PATH = oldPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runSubagent reports and reaps a timed-out child", { concurrency: false }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-test-"));
	const oldPath = process.env.PATH;
	const binDir = fakePi(dir, `setInterval(() => {}, 1000);`);
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	try {
		const result = await runSubagent({ ...baseOptions(dir), timeoutMs: 30 });
		assert.equal(result.ok, false);
		assert.equal(result.timedOut, true);
		assert.equal(result.activity.state, "timed_out");
	} finally {
		process.env.PATH = oldPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runSubagent reports and reaps an aborted child", { concurrency: false }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-test-"));
	const oldPath = process.env.PATH;
	const binDir = fakePi(dir, `setInterval(() => {}, 1000);`);
	const controller = new AbortController();
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	setTimeout(() => controller.abort(), 30);
	try {
		const result = await runSubagent({ ...baseOptions(dir), signal: controller.signal });
		assert.equal(result.ok, false);
		assert.equal(result.timedOut, false);
		assert.equal(result.error, "aborted");
		assert.equal(result.activity.state, "aborted");
	} finally {
		process.env.PATH = oldPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runSubagent maps extension and project-context controls to exact Pi flags", { concurrency: false }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-test-"));
	const oldPath = process.env.PATH;
	const binDir = fakePi(
		dir,
		`const text = JSON.stringify(process.argv.slice(2));
		process.stdout.write(JSON.stringify({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text}]}]}) + "\\n");`,
	);
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	try {
		const stripped = await runSubagent({
			...baseOptions(dir),
			extensions: [],
			inheritProjectContext: false,
		});
		const strippedArgs = JSON.parse(stripped.answer);
		assert.ok(strippedArgs.includes("--no-extensions"));
		assert.ok(strippedArgs.includes("--no-context-files"));
		assert.equal(strippedArgs.includes("--extension"), false);

		const allowlisted = await runSubagent({
			...baseOptions(dir),
			extensions: ["/tmp/a.ts", "/tmp/b.ts"],
		});
		const allowlistedArgs = JSON.parse(allowlisted.answer);
		assert.deepEqual(
			allowlistedArgs.slice(allowlistedArgs.indexOf("--no-extensions"), allowlistedArgs.indexOf("--no-extensions") + 5),
			["--no-extensions", "--extension", "/tmp/a.ts", "--extension", "/tmp/b.ts"],
		);

		const inherited = await runSubagent(baseOptions(dir));
		const inheritedArgs = JSON.parse(inherited.answer);
		assert.equal(inheritedArgs.includes("--no-extensions"), false);
		assert.equal(inheritedArgs.includes("--no-context-files"), false);
	} finally {
		process.env.PATH = oldPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("turn limit stops before the next turn and retains the last answer", { concurrency: false }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-test-"));
	const oldPath = process.env.PATH;
	const binDir = fakePi(
		dir,
		`const emit = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
		for (let i = 1; i <= 2; i++) {
			emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"answer " + i}]}});
		}
		emit({type:"turn_start",turnIndex:2});
		setInterval(() => {}, 1000);`,
	);
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	try {
		const result = await runSubagent({ ...baseOptions(dir), maxTurns: 2 });
		assert.equal(result.ok, false);
		assert.equal(result.turnLimitExceeded, true);
		assert.equal(result.answer, "answer 2");
		assert.equal(result.activity.state, "turn_limit");
	} finally {
		process.env.PATH = oldPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("turn limit does not reject a natural completion on the final turn", { concurrency: false }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-test-"));
	const oldPath = process.env.PATH;
	const binDir = fakePi(
		dir,
		`const emit = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
		emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"final answer"}]}});
		emit({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:"final answer"}]}]});`,
	);
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	try {
		const result = await runSubagent({ ...baseOptions(dir), maxTurns: 1 });
		assert.equal(result.ok, true);
		assert.equal(result.turnLimitExceeded, false);
		assert.equal(result.answer, "final answer");
	} finally {
		process.env.PATH = oldPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("large answers spill to Markdown with a Unicode-safe bounded excerpt", () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-test-"));
	const outputPath = path.join(dir, "scout-output.md");
	const answer = `prefix ${"🙂".repeat(MAX_INLINE_ANSWER_BYTES)} suffix`;
	try {
		const spilled = spillLargeAnswer(answer, outputPath);
		assert.equal(spilled.outputPath, outputPath);
		assert.equal(fs.readFileSync(outputPath, "utf-8"), answer);
		assert.ok(Buffer.byteLength(spilled.inlineAnswer, "utf-8") < MAX_INLINE_ANSWER_BYTES);
		assert.equal(spilled.inlineAnswer.includes("�"), false);
		assert.match(spilled.inlineAnswer, /Full output saved to:/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("normal answers remain unchanged and spill failure falls back to full text", () => {
	const answer = "normal answer";
	assert.deepEqual(spillLargeAnswer(answer, "/unused"), { inlineAnswer: answer });

	const large = "x".repeat(MAX_INLINE_ANSWER_BYTES + 1);
	const failed = spillLargeAnswer(large, "/unused", () => {
		throw new Error("disk full");
	});
	assert.deepEqual(failed, { inlineAnswer: large });
});

test("runSubagent returns usage and spills only model-facing large output", { concurrency: false }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-test-"));
	const oldPath = process.env.PATH;
	const answer = "z".repeat(MAX_INLINE_ANSWER_BYTES + 1);
	const binDir = fakePi(
		dir,
		`const message = {role:"assistant",content:[{type:"text",text:${JSON.stringify(answer)}}],usage:{input:12,output:4,cacheRead:3,cacheWrite:1,totalTokens:20,cost:{total:0.02}}};
		process.stdout.write(JSON.stringify({type:"message_end",message}) + "\\n");
		process.stdout.write(JSON.stringify({type:"agent_end",messages:[message]}) + "\\n");`,
	);
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	try {
		const result = await runSubagent(baseOptions(dir));
		assert.equal(result.answer, answer);
		assert.ok(result.inlineAnswer.length < answer.length);
		assert.equal(fs.readFileSync(result.outputPath!, "utf-8"), answer);
		assert.deepEqual(result.usage, {
			input: 12,
			output: 4,
			cacheRead: 3,
			cacheWrite: 1,
			totalTokens: 20,
			contextTokens: 20,
			cost: 0.02,
			turns: 1,
		});
	} finally {
		process.env.PATH = oldPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("runSubagent emits activity before the child completes", { concurrency: false }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-test-"));
	const oldPath = process.env.PATH;
	const binDir = fakePi(
		dir,
		`const emit = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
		emit({type:"agent_start"});
		emit({type:"tool_execution_start",toolName:"read",args:{path:"src/index.ts"}});
		setTimeout(() => {
			emit({type:"message_end",message:{role:"assistant",content:[{type:"text",text:"final answer"}]}});
			emit({type:"agent_end",messages:[{role:"assistant",content:[{type:"text",text:"final answer"}]}]});
		}, 100);`,
	);
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	const updates: Array<{ current: string; at: number }> = [];
	const started = Date.now();
	try {
		const result = await runSubagent({
			...baseOptions(dir),
			onActivity: (activity) => updates.push({ current: activity.current, at: Date.now() }),
		});
		assert.equal(result.ok, true);
		assert.equal(result.answer, "final answer");
		assert.ok(updates.some((update) => update.current === "read src/index.ts"));
		assert.ok(updates.some((update) => update.at - started < 100));
	} finally {
		process.env.PATH = oldPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
