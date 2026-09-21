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

function registeredRuntime() {
	let tool: any;
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const commands = new Map<string, any>();
	const messages: any[] = [];
	const renderers = new Map<string, any>();
	const previous = process.env[CHILD_MARKER];
	delete process.env[CHILD_MARKER];
	try {
		minimalSubagentExtension({
			registerTool: (definition: any) => { tool = definition; },
			registerCommand: (name: string, definition: any) => commands.set(name, definition),
			registerMessageRenderer: (name: string, renderer: any) => renderers.set(name, renderer),
			on: (name: string, handler: any) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
			sendMessage: (message: any, options: any) => messages.push({ message, options }),
		} as any);
	} finally {
		if (previous === undefined) delete process.env[CHILD_MARKER];
		else process.env[CHILD_MARKER] = previous;
	}
	assert.ok(tool);
	return { tool, handlers, commands, messages, renderers };
}

function registeredTool(): any {
	return registeredRuntime().tool;
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

test("TUI defaults to background while non-TUI defaults to blocking and rejects explicit async", { concurrency: false }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-async-matrix-"));
	const oldPath = process.env.PATH;
	const binDir = fakePi(dir, `const message={role:"assistant",content:[{type:"text",text:"done"}]}; setTimeout(() => process.stdout.write(JSON.stringify({type:"agent_end",messages:[message]})+"\\n"), 80);`);
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	const ctx = (mode: string) => ({ cwd: harnessDir, mode, modelRegistry: { getAvailable: () => [] }, sessionManager: { getSessionId: () => "session-1" }, ui: {} });
	try {
		const { tool, handlers } = registeredRuntime();
		assert.ok(tool.parameters.properties.async);
		assert.ok(tool.parameters.properties.id);
		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx("tui"));

		const receipt = await tool.execute("async-call", { tasks: [{ agent: "worker", task: "background" }] }, undefined, undefined, ctx("tui"));
		assert.match(receipt.content[0].text, /continues in the background/i);
		assert.ok(receipt.details.jobId);
		assert.equal(receipt.details.results, undefined);

		const blocking = await tool.execute("blocking-call", { tasks: [{ agent: "worker", task: "blocking" }], async: false }, undefined, undefined, ctx("tui"));
		assert.match(blocking.content[0].text, /worker — ok/i);
		const printDefault = await tool.execute("print-call", { tasks: [{ agent: "worker", task: "print" }] }, undefined, undefined, ctx("print"));
		assert.match(printDefault.content[0].text, /worker — ok/i);
		await assert.rejects(
			() => tool.execute("bad-call", { tasks: [{ agent: "worker", task: "bad" }], async: true }, undefined, undefined, ctx("rpc")),
			/TUI|synchronous/i,
		);
		await handlers.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx("tui"));
	} finally {
		process.env.PATH = oldPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("background status and cancellation require exact IDs and the direct command uses the same job", { concurrency: false }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-async-controls-"));
	const oldPath = process.env.PATH;
	const binDir = fakePi(dir, `setInterval(() => {}, 1000);`);
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	const notifications: string[] = [];
	const ctx = {
		cwd: harnessDir,
		mode: "tui",
		modelRegistry: { getAvailable: () => [] },
		sessionManager: { getSessionId: () => "session-controls" },
		ui: { notify: (text: string) => notifications.push(text), confirm: async () => true },
	};
	try {
		const { tool, handlers, commands } = registeredRuntime();
		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		const one = await tool.execute("one", { tasks: [{ agent: "worker", label: "first goal", task: "first" }] }, undefined, undefined, ctx);
		const two = await tool.execute("two", { tasks: [{ agent: "worker", task: "second" }] }, undefined, undefined, ctx);
		const active = await tool.execute("status", { action: "status" }, undefined, undefined, ctx);
		assert.match(active.content[0].text, new RegExp(one.details.jobId));
		assert.match(active.content[0].text, new RegExp(two.details.jobId));
		await assert.rejects(() => tool.execute("bad", { action: "status", id: one.details.jobId.slice(0, 4) }, undefined, undefined, ctx), /Unknown/);
		await assert.rejects(() => tool.execute("missing", { action: "cancel" }, undefined, undefined, ctx), /requires.*id/i);

		await commands.get("subagent-cancel").handler(one.details.jobId, ctx);
		assert.match(notifications.at(-1)!, /cancelled/i);
		const final = await tool.execute("status-one", { action: "status", id: one.details.jobId }, undefined, undefined, ctx);
		assert.match(final.content[0].text, /aborted|FAILED/i);
		await tool.execute("cancel-two", { action: "cancel", id: two.details.jobId }, undefined, undefined, ctx);
		await handlers.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx);
	} finally {
		process.env.PATH = oldPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("session replacement warns without cancelling until committed shutdown", { concurrency: false }, async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-minsub-async-lifecycle-"));
	const oldPath = process.env.PATH;
	const binDir = fakePi(dir, `setInterval(() => {}, 1000);`);
	process.env.PATH = `${binDir}${path.delimiter}${oldPath ?? ""}`;
	let allow = false;
	const ctx = {
		cwd: harnessDir,
		mode: "tui",
		modelRegistry: { getAvailable: () => [] },
		sessionManager: { getSessionId: () => "session-life" },
		ui: { confirm: async (_title: string, message: string) => { assert.match(message, /file edits are not undone/i); return allow; }, setWidget() {} },
	};
	try {
		const { tool, handlers } = registeredRuntime();
		await handlers.get("session_start")?.[0]?.({ reason: "startup" }, ctx);
		const receipt = await tool.execute("life", { tasks: [{ agent: "worker", task: "long" }] }, undefined, undefined, ctx);
		const declined = await handlers.get("session_before_switch")?.[0]?.({ reason: "new" }, ctx);
		assert.deepEqual(declined, { cancel: true });
		assert.match((await tool.execute("still", { action: "status", id: receipt.details.jobId }, undefined, undefined, ctx)).content[0].text, /running|queued/i);
		allow = true;
		assert.equal(await handlers.get("session_before_fork")?.[0]?.({ entryId: "abc" }, ctx), undefined);
		assert.match((await tool.execute("still2", { action: "status", id: receipt.details.jobId }, undefined, undefined, ctx)).content[0].text, /running|queued/i);
		await handlers.get("session_shutdown")?.[0]?.({ reason: "new" }, ctx);
		await handlers.get("session_shutdown")?.[0]?.({ reason: "new" }, ctx);
		const stopped = await tool.execute("stopped", { action: "status", id: receipt.details.jobId }, undefined, undefined, ctx);
		assert.match(stopped.content[0].text, /aborted|terminal/i);
	} finally {
		process.env.PATH = oldPath;
		fs.rmSync(dir, { recursive: true, force: true });
	}
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
