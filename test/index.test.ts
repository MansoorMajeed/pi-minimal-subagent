import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

function findPackageRoot(start: string): string {
	let current = start;
	while (true) {
		const packagePath = path.join(current, "package.json");
		if (fs.existsSync(packagePath)) {
			const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8"));
			if (pkg.name === "@earendil-works/pi-coding-agent") return current;
		}
		const parent = path.dirname(current);
		if (parent === current) throw new Error("could not locate installed pi package");
		current = parent;
	}
}

const harnessDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-extension-harness-"));
const sourceDir = path.resolve(new URL("../src", import.meta.url).pathname);
fs.cpSync(sourceDir, path.join(harnessDir, "src"), { recursive: true });
fs.cpSync(path.resolve(new URL("../agents", import.meta.url).pathname), path.join(harnessDir, "agents"), { recursive: true });
fs.copyFileSync(new URL("../SUBAGENT_MODELS.md", import.meta.url), path.join(harnessDir, "SUBAGENT_MODELS.md"));
const piRoot = findPackageRoot(path.dirname(fs.realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const dependencyRoot = path.join(piRoot, "node_modules");
fs.mkdirSync(path.join(harnessDir, "node_modules", "@earendil-works"), { recursive: true });
fs.symlinkSync(piRoot, path.join(harnessDir, "node_modules", "@earendil-works", "pi-coding-agent"), "dir");
fs.symlinkSync(path.join(dependencyRoot, "@earendil-works", "pi-tui"), path.join(harnessDir, "node_modules", "@earendil-works", "pi-tui"), "dir");
fs.symlinkSync(path.join(dependencyRoot, "typebox"), path.join(harnessDir, "node_modules", "typebox"), "dir");
const indexModule = await import(pathToFileURL(path.join(harnessDir, "src", "index.ts")).href);
const activityModule = await import(pathToFileURL(path.join(harnessDir, "src", "activity.ts")).href);
const layoutModule = await import(pathToFileURL(path.join(harnessDir, "src", "status-layout.ts")).href);
const tuiModule = await import(pathToFileURL(path.join(dependencyRoot, "@earendil-works", "pi-tui", "dist", "index.js")).href);
const minimalSubagentExtension = indexModule.default;
const { SubagentStatusComponent } = indexModule;
const { createActivity } = activityModule;
const { buildStatusRows } = layoutModule;
const { visibleWidth } = tuiModule;

test.after(() => fs.rmSync(harnessDir, { recursive: true, force: true }));

function fakeTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

const CHILD_MARKER = "PI_MINIMAL_SUBAGENT_CHILD";

function registeredTool(): any {
	let tool: any;
	const previous = process.env[CHILD_MARKER];
	delete process.env[CHILD_MARKER];
	try {
		minimalSubagentExtension({ registerTool: (definition: any) => { tool = definition; } } as any);
	} finally {
		if (previous === undefined) delete process.env[CHILD_MARKER];
		else process.env[CHILD_MARKER] = previous;
	}
	assert.ok(tool);
	return tool;
}

function fakePi(dir: string, body: string): string {
	const binDir = path.join(dir, "bin");
	fs.mkdirSync(binDir);
	const executable = path.join(binDir, "pi");
	fs.writeFileSync(executable, `#!/usr/bin/env node\n${body}`, { mode: 0o755 });
	return binDir;
}

test("extension registration remains suppressed inside a minimal subagent child", () => {
	const previous = process.env[CHILD_MARKER];
	let registered = false;
	process.env[CHILD_MARKER] = "1";
	try {
		minimalSubagentExtension({ registerTool: () => { registered = true; } } as any);
	} finally {
		if (previous === undefined) delete process.env[CHILD_MARKER];
		else process.env[CHILD_MARKER] = previous;
	}
	assert.equal(registered, false);
});

test("tool schema accepts an optional concise task label", () => {
	const tool = registeredTool();
	const taskProperties = tool.parameters.properties.tasks.items.properties;
	assert.ok(taskProperties.label);
	assert.equal(taskProperties.label.description, "Concise display goal (e.g. 'Implement refresh-token rotation')");
});

test("agent discovery includes the active guide without changing the tool description", { concurrency: false }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-guide-wiring-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	try {
		const tool = registeredTool();
		assert.doesNotMatch(tool.description, /gpt-5\.6-luna|gpt-6-astra/);
		const discover = () => tool.execute("list", { action: "list" }, undefined, undefined, { cwd: dir });
		const bundled = (await discover()).content[0].text;
		assert.match(bundled, /Available agents:/);
		assert.match(bundled, /worker/);
		assert.match(bundled, /gpt-5\.6-luna/);
		assert.ok(bundled.includes(path.join(harnessDir, "SUBAGENT_MODELS.md")));

		const override = path.join(dir, "SUBAGENT_MODELS.md");
		fs.writeFileSync(override, "Prefer my local model only.");
		const custom = (await discover()).content[0].text;
		assert.match(custom, /Prefer my local model only/);
		assert.ok(custom.includes(override));
		assert.doesNotMatch(custom, /gpt-5\.6-luna|openai-codex/);

		fs.writeFileSync(override, "");
		assert.doesNotMatch((await discover()).content[0].text, /gpt-5\.6-luna/);
		fs.writeFileSync(override, "x".repeat(60_000));
		await assert.rejects(discover(), /too large/i);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("models action searches the available registry and retains provider alternatives", async () => {
	const tool = registeredTool();
	assert.ok(tool.parameters.properties.query);
	let reads = 0;
	const ctx = { modelRegistry: { getAvailable() {
		reads++;
		return [
			{ provider: "openrouter", id: "openai/luna", name: "Luna", headers: { secret: "do-not-expose" } },
			{ provider: "openai-codex", id: "gpt-luna", name: "Luna" },
			{ provider: "local", id: "other", name: "Other" },
		];
	} } };
	const result = await tool.execute("models", { action: "models", query: "LUNA" }, undefined, undefined, ctx);
	assert.equal(reads, 1);
	assert.match(result.content[0].text, /openai-codex\/gpt-luna/);
	assert.match(result.content[0].text, /openrouter\/openai\/luna/);
	assert.doesNotMatch(JSON.stringify(result), /do-not-expose|local\/other/);
	const absent = await tool.execute("models", { action: "models", query: "missing" }, undefined, undefined, ctx);
	assert.match(absent.content[0].text, /No available models match/);
});

test("models action requires a search term instead of dumping the catalogue", async () => {
	const tool = registeredTool();
	for (const query of [undefined, "", "   "]) {
		await assert.rejects(
			() => tool.execute("models", { action: "models", query }, undefined, undefined, {}),
			/nonblank query/,
		);
	}
});

test("models action bounds broad searches and tells the parent to narrow them", async () => {
	const tool = registeredTool();
	const ctx = { modelRegistry: { getAvailable: () => Array.from({ length: 2_000 }, (_, index) => ({
		provider: "local", id: `luna-${String(index).padStart(4, "0")}`, name: "Luna",
	})) } };
	const result = await tool.execute("models", { action: "models", query: "luna" }, undefined, undefined, ctx);
	const text = result.content[0].text;
	assert.equal(text.split("\n").filter((line: string) => line.startsWith("- ")).length, 50);
	assert.match(text, /50 of 2000/);
	assert.match(text, /[Nn]arrow/);
	assert.doesNotMatch(text, /luna-0050/);

	for (const name of ["🙂".repeat(20_000), "x".repeat(51_100) + "\n" + "x".repeat(1_000), "x\n".repeat(2_200)]) {
		ctx.modelRegistry.getAvailable = () => [{ provider: "local", id: "luna", name }];
		const oversized = await tool.execute("models", { action: "models", query: "luna" }, undefined, undefined, ctx);
		assert.ok(Buffer.byteLength(oversized.content[0].text) <= 50 * 1024);
		assert.ok(oversized.content[0].text.split("\n").length <= 2_000);
		assert.match(oversized.content[0].text, /[Nn]arrow/);
	}
});

test("status component keeps six sanitized width-bounded rows", () => {
	const activity = createActivity("worker\x1b[2J", "provider/model", {
		task: "full task",
		goal: "A very long goal that must be clipped safely without wrapping",
		startedAt: 1_000,
		deadlineAt: 31_000,
	});
	activity.state = "running";
	activity.reported = "progress\nwith controls\x1b[2J";
	activity.recent = ["read first.ts", "bash echo second"];
	const component = new SubagentStatusComponent(buildStatusRows([activity], 2_000), undefined, fakeTheme());
	const lines = component.render(18);

	assert.equal(lines.length, 6);
	assert.ok(lines.every((line) => visibleWidth(line) <= 18));
	assert.ok(lines.every((line) => !line.includes("\x1b[2J")));
});

test("expanded rendering exposes full tasks while running and preserves completed output", () => {
	const tool = registeredTool();
	const activity = createActivity("worker", "provider/model", {
		task: "First task line\nSecond task line",
		goal: "Implement feature",
	});
	const details = { runDir: "/tmp/run", activities: [activity] };
	const partial = tool.renderResult(
		{ content: [{ type: "text", text: "Subagents: 0/1 complete" }], details },
		{ expanded: true, isPartial: true },
		fakeTheme(),
	);
	const partialText = partial.render(100).join("\n");
	assert.match(partialText, /Task \[1\] worker/);
	assert.match(partialText, /First task line\s*\nSecond task line/);
	assert.doesNotMatch(partialText, /Subagents: 0\/1 complete/);

	const completed = tool.renderResult(
		{ content: [{ type: "text", text: "completed child output" }], details },
		{ expanded: true, isPartial: false },
		fakeTheme(),
	);
	const completedText = completed.render(100).join("\n");
	assert.match(completedText, /Task \[1\] worker/);
	assert.match(completedText, /completed child output/);
});

test("tool wiring preserves labeled task metadata, refreshes the clock, and clears its timer", { concurrency: false }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-index-test-"));
	const oldPath = process.env.PATH;
	const realSetInterval = globalThis.setInterval;
	const realClearInterval = globalThis.clearInterval;
	const intervalHandles: Array<{ callback: () => void; cleared: boolean; unref: () => void }> = [];
	const binDir = fakePi(
		dir,
		`const task = process.argv.at(-1);
		if (task.includes("error path")) {
			process.stderr.write("fake failure");
			process.exit(1);
		} else if (task.includes("abort path")) {
			setInterval(() => {}, 1000);
		} else {
			const emit = (x) => process.stdout.write(JSON.stringify(x) + "\\n");
			setTimeout(() => {
				const message = {role:"assistant",content:[{type:"text",text:"Progress: inspected code; finishing"}]};
				emit({type:"message_end",message});
				emit({type:"agent_end",messages:[message]});
			}, 500);
		}`,
	);
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	(globalThis as any).setInterval = (callback: () => void, delay: number) => {
		assert.equal(delay, 1_000);
		const handle = { callback, cleared: false, unref() {} };
		intervalHandles.push(handle);
		return handle;
	};
	(globalThis as any).clearInterval = (handle: { cleared: boolean }) => { handle.cleared = true; };

	const updates: any[] = [];
	try {
		const tool = registeredTool();
		const execution = tool.execute(
			"call-1",
			{ tasks: [{ agent: "worker", label: "Implement refresh tokens", task: "Full task\nwith details" }] },
			undefined,
			(update: any) => updates.push(update),
			{ cwd: dir },
		);
		await new Promise((resolve) => setTimeout(resolve, 180));
		assert.equal(intervalHandles.length, 1);
		const updatesBeforeClock = updates.length;
		intervalHandles[0].callback();
		await new Promise((resolve) => setTimeout(resolve, 170));
		assert.ok(updates.length > updatesBeforeClock);
		const result = await execution;

		assert.equal(intervalHandles[0].cleared, true);
		assert.ok(updates.length >= 2);
		assert.ok(updates.every((update) => update.content[0].text.startsWith("Subagents:")));
		assert.ok(updates.every((update) => !update.content[0].text.includes("Progress:")));
		const activity = result.details.activities[0];
		assert.equal(activity.task, "Full task\nwith details");
		assert.equal(activity.goal, "Implement refresh tokens");
		assert.equal(activity.reported, "inspected code; finishing");

		await tool.execute(
			"call-2",
			{ tasks: [{ agent: "worker", task: "error path" }] },
			undefined,
			undefined,
			{ cwd: dir },
		);
		assert.equal(intervalHandles[1].cleared, true);

		const controller = new AbortController();
		const aborted = tool.execute(
			"call-3",
			{ tasks: [{ agent: "worker", task: "abort path" }] },
			controller.signal,
			undefined,
			{ cwd: dir },
		);
		setTimeout(() => controller.abort(), 30);
		await aborted;
		assert.equal(intervalHandles[2].cleared, true);
	} finally {
		globalThis.setInterval = realSetInterval;
		globalThis.clearInterval = realClearInterval;
		process.env.PATH = oldPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
