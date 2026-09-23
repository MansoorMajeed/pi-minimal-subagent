import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { runSubagent } from "../src/spawn.ts";

function fakePi(dir: string, body: string): string {
	const binDir = path.join(dir, "bin");
	fs.mkdirSync(binDir);
	fs.writeFileSync(path.join(binDir, "pi"), `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
	return binDir;
}

test("forced termination kills same-group descendants that ignore SIGTERM", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-process-tree-"));
	const oldPath = process.env.PATH;
	const pidPath = path.join(dir, "descendant.pid");
	const descendant = `process.on("SIGTERM", () => {}); setTimeout(() => {}, 10_000);`;
	const binDir = fakePi(
		dir,
		`const { spawn } = require("node:child_process");
		const fs = require("node:fs");
		const child = spawn(process.execPath, ["-e", ${JSON.stringify(descendant)}], { stdio: "ignore" });
		fs.writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));
		setTimeout(() => {}, 10_000);`,
	);
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	let descendantPid: number | undefined;
	try {
		const result = await runSubagent({
			task: "inspect the code",
			label: "scout",
			logPath: path.join(dir, "scout.jsonl"),
			cwd: dir,
			timeoutMs: 500,
		});
		descendantPid = Number(fs.readFileSync(pidPath, "utf8"));
		assert.equal(result.timedOut, true);
		await new Promise((resolve) => setTimeout(resolve, 50));
		assert.throws(() => process.kill(descendantPid!, 0), { code: "ESRCH" });
	} finally {
		if (descendantPid) try { process.kill(descendantPid, "SIGKILL"); } catch { /* already dead */ }
		process.env.PATH = oldPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
