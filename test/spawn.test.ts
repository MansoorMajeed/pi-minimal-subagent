import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { runSubagent } from "../src/spawn.ts";

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
