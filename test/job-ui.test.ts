import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";

function packageRoot(start: string): string {
	let current = start;
	while (true) {
		const file = path.join(current, "package.json");
		if (fs.existsSync(file) && JSON.parse(fs.readFileSync(file, "utf8")).name === "@earendil-works/pi-coding-agent") return current;
		const next = path.dirname(current);
		if (next === current) throw new Error("installed Pi not found");
		current = next;
	}
}
const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-job-ui-"));
fs.cpSync(new URL("../src", import.meta.url), path.join(root, "src"), { recursive: true });
const piRoot = packageRoot(path.dirname(fs.realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const deps = path.join(piRoot, "node_modules");
fs.mkdirSync(path.join(root, "node_modules", "@earendil-works"), { recursive: true });
for (const name of ["pi-coding-agent", "pi-tui"]) fs.symlinkSync(name === "pi-coding-agent" ? piRoot : path.join(deps, "@earendil-works", name), path.join(root, "node_modules", "@earendil-works", name), "dir");
const { showJobPicker } = await import(pathToFileURL(path.join(root, "src/job-ui.ts")).href);
const { JobRegistry } = await import(pathToFileURL(path.join(root, "src/jobs.ts")).href);
const { createActivity } = await import(pathToFileURL(path.join(root, "src/activity.ts")).href);
const { visibleWidth } = await import(pathToFileURL(path.join(deps, "@earendil-works/pi-tui/dist/index.js")).href);
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}
function child(name: string, goal = "same goal") {
	const activity = createActivity(name, "test/model", { task: `full task ${name}\nsecond line`, goal });
	return { activity, options: { task: activity.task, label: name, goal, logPath: `/tmp/${name}.jsonl`, sessionPath: `/tmp/${name}.session`, cwd: "/tmp", timeoutMs: 1000 } };
}
function result(name: string) {
	const activity = createActivity(name, "test/model", { goal: "same goal" });
	activity.state = "done";
	return { agent: name, ok: true, answer: `answer ${name}`, inlineAnswer: `answer ${name}`, outputPath: `/tmp/${name}-output.md`, exitCode: 0, logPath: `/tmp/${name}.jsonl`, sessionPath: `/tmp/${name}.session`, timedOut: false, turnLimitExceeded: false, activity, usage: activity.usage };
}
function setup(count = 1) {
	const gates = new Map<string, ReturnType<typeof deferred<ReturnType<typeof result>>>>();
	const jobs = new JobRegistry({ runner: async (opts: { label: string }) => {
		const gate = deferred<ReturnType<typeof result>>();
		gates.set(opts.label, gate);
		return gate.promise;
	} });
	for (let i = 0; i < count; i++) jobs.submit({ id: `job-${i}`, runDir: `/tmp/job-${i}`, background: true, children: [child(`agent-${i}`, i === 0 ? "\u001b[31mgoal\u001b[0m 👋" : "same goal")] });
	return { jobs, gates };
}
function ui(rows = 9) {
	const views: Array<{ render(width: number): string[]; handleInput(data: string): void; dispose?(): void }> = [];
	const notices: string[] = [];
	const customOptions: any[] = [];
	const selects: Array<{ title: string; options: string[]; signal?: AbortSignal; resolve(value: string | undefined): void }> = [];
	const confirms: Array<{ message: string; signal?: AbortSignal; resolve(value: boolean): void }> = [];
	const terminal = { rows, columns: 40 };
	const ctx = { mode: "tui", ui: {
		notify: (msg: string) => notices.push(msg),
		custom: (factory: Function, options: any) => new Promise((resolve) => { customOptions.push(options); views.push(factory({ terminal, requestRender() {} }, { fg: (_c: string, s: string) => s, bold: (s: string) => s }, {}, resolve)); }),
		select: (title: string, options: string[], opts?: { signal?: AbortSignal }) => new Promise<string | undefined>((resolve) => selects.push({ title, options, signal: opts?.signal, resolve })),
		confirm: (_title: string, message: string, opts?: { signal?: AbortSignal }) => new Promise<boolean>((resolve) => confirms.push({ message, signal: opts?.signal, resolve })),
	} };
	return { ctx, terminal, views, notices, selects, confirms, customOptions };
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test("empty and non-TUI paths do not open views", async () => {
	const { jobs } = setup(0);
	const screen = ui();
	await showJobPicker(screen.ctx, jobs, new AbortController().signal);
	assert.match(screen.notices[0], /No background jobs/i);
	await showJobPicker({ ...screen.ctx, mode: "rpc" }, jobs, new AbortController().signal);
	assert.match(screen.notices[1], /TUI/i);
	assert.equal(screen.views.length, 0);
});

test("real SelectList scrolls all jobs, preserves exact ID through resize, and bounds rows and columns", async () => {
	const { jobs } = setup(35);
	const screen = ui(9);
	const owner = new AbortController();
	const command = showJobPicker(screen.ctx, jobs, owner.signal);
	const picker = screen.views[0];
	assert.ok(picker.render(40).length <= 9);
	assert.equal(screen.customOptions[0]?.overlay, true, "footer and live widgets must not push the selected row off-screen");
	assert.deepEqual(screen.customOptions[0]?.overlayOptions, { width: "100%", maxHeight: "100%" });
	for (let i = 0; i < 34; i++) picker.handleInput("\x1b[B");
	assert.match(picker.render(40).join("\n"), /job-34/);
	screen.terminal.rows = 1;
	assert.ok(picker.render(1).length <= 1);
	assert.ok(picker.render(1).every((row) => visibleWidth(row) <= 1));
	screen.terminal.rows = 2;
	assert.ok(picker.render(5).length <= 2);
	screen.terminal.rows = 5;
	for (const width of [5, 12, 40]) {
		const lines = picker.render(width);
		assert.ok(lines.length <= 5);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
		if (width >= 12) assert.match(lines.join("\n"), /job-34/);
		assert.doesNotMatch(lines.join("\n"), /\u001b\[31m/);
	}
	picker.handleInput("\r");
	await tick();
	assert.match(screen.selects[0].title, /job-34/);
	assert.deepEqual(screen.selects[0].options, ["View details", "Cancel job"]);
	screen.selects[0].resolve(undefined);
	await command;
	assert.equal(jobs.get("job-34")?.state, "queued");
	owner.abort();
});

test("narrow picker preserves distinguishing ID suffixes for duplicate goals and timestamp prefixes", async () => {
	const jobs = new JobRegistry({ runner: async () => new Promise(() => {}) });
	for (const id of ["muesjk3-a1b2", "muesjk3-b1b2"]) {
		jobs.submit({ id, runDir: `/tmp/${id}`, background: true, children: [child("worker", "Identical task goal")] });
	}
	const screen = ui(6);
	const owner = new AbortController();
	const command = showJobPicker(screen.ctx, jobs, owner.signal);
	const picker = screen.views[0];
	const first = picker.render(12);
	assert.match(first.join("\n"), /a1b2/);
	picker.handleInput("\x1b[B");
	const second = picker.render(12);
	assert.match(second.join("\n"), /b1b2/);
	assert.ok([...first, ...second].every((line) => visibleWidth(line) <= 12));
	picker.handleInput("\r");
	await tick();
	assert.equal(screen.selects[0].title, "Job muesjk3-b1b2", "display clipping never changes the exact action ID");
	screen.selects[0].resolve(undefined);
	await command;
	owner.abort();
});

test("picker Home/End/Page navigation selects duplicate-goal jobs by exact ID", async () => {
	const { jobs } = setup(25);
	const screen = ui(7);
	const owner = new AbortController();
	const command = showJobPicker(screen.ctx, jobs, owner.signal);
	const picker = screen.views[0];
	picker.handleInput("\x1b[F");
	assert.match(picker.render(40).join("\n"), /ID: job-24/);
	picker.handleInput("\x1b[5~");
	assert.match(picker.render(40).join("\n"), /ID: job-21/);
	picker.handleInput("\x1b[H");
	assert.match(picker.render(40).join("\n"), /ID: job-0/);
	picker.handleInput("\x1b[6~");
	assert.match(picker.render(40).join("\n"), /ID: job-3/);
	picker.handleInput("\x1b[F");
	screen.terminal.rows = 3;
	assert.ok(picker.render(12).length <= 3);
	assert.match(picker.render(12).join("\n"), /job-24/);
	picker.handleInput("\r");
	await tick();
	assert.match(screen.selects[0].title, /job-24/);
	screen.selects[0].resolve(undefined);
	await command;
	owner.abort();
});

test("job details show configured thinking or default for legacy activities", async () => {
	for (const thinking of ["off", undefined]) {
		const jobs = new JobRegistry({ runner: async () => new Promise(() => {}) });
		const entry = child("worker");
		entry.activity.thinking = thinking;
		jobs.submit({ id: "thinking-job", runDir: "/tmp/thinking-job", background: true, children: [entry] });
		const screen = ui(30);
		const owner = new AbortController();
		const command = showJobPicker(screen.ctx, jobs, owner.signal);
		screen.views[0].handleInput("\r");
		await tick();
		screen.selects[0].resolve("View details");
		await tick();
		assert.match(screen.views[1].render(120).join("\n"), new RegExp(`Thinking: ${thinking ?? "default"}`));
		screen.views[1].handleInput("\x1b");
		await command;
		owner.abort();
	}
});

test("details snapshot scrolls safely and never modifies editor or inserts messages", async () => {
	const { jobs } = setup(1);
	const screen = ui(7);
	const owner = new AbortController();
	const command = showJobPicker(screen.ctx, jobs, owner.signal);
	screen.views[0].handleInput("\r");
	await tick();
	screen.selects[0].resolve("View details");
	await tick();
	const details = screen.views[1];
	assert.ok(details);
	assert.match(details.render(80)[0], /snapshot/i);
	assert.equal(screen.customOptions[1]?.overlay, true, "details must not be clipped by Pi's footer");
	let lines = details.render(20);
	assert.ok(lines.length <= 7 && lines.every((line) => visibleWidth(line) <= 20));
	details.handleInput("\x1b[F");
	lines = details.render(20);
	assert.match(lines.join("\n"), /session|task|artifact/i);
	details.handleInput("\x1b[H");
	assert.match(details.render(20).join("\n"), /job-0/);
	details.handleInput("\x1b[6~");
	details.handleInput("\x1b[5~");
	details.handleInput("\x1b");
	await command;
	owner.abort();
});

test("job finishing while action menu is open is reported as finished, not cancelled", async () => {
	const { jobs, gates } = setup();
	const screen = ui();
	const owner = new AbortController();
	const command = showJobPicker(screen.ctx, jobs, owner.signal);
	screen.views[0].handleInput("\r");
	await tick();
	gates.get("agent-0")!.resolve(result("agent-0"));
	await tick();
	screen.selects[0].resolve("Cancel job");
	await command;
	assert.equal(screen.confirms.length, 0);
	assert.match(screen.notices.join("\n"), /already finished/);
	owner.abort();
});

test("state changes while choosing and confirming cannot cancel finished jobs", async () => {
	const { jobs, gates } = setup();
	const screen = ui();
	const owner = new AbortController();
	const command = showJobPicker(screen.ctx, jobs, owner.signal);
	screen.views[0].handleInput("\r");
	await tick();
	screen.selects[0].resolve("Cancel job");
	await tick();
	assert.match(screen.confirms[0].message, /edits.*not undone/i);
	await tick();
	gates.get("agent-0")!.resolve(result("agent-0"));
	await tick();
	screen.confirms[0].resolve(true);
	await command;
	assert.match(screen.notices.join("\n"), /already finished/i);
	owner.abort();
});

test("abort completes custom picker and details idempotently; late callbacks cannot use invalid context", async () => {
	for (const openDetails of [false, true]) {
		const { jobs } = setup();
		const screen = ui();
		const owner = new AbortController();
		const command = showJobPicker(screen.ctx, jobs, owner.signal);
		const picker = screen.views[0];
		if (openDetails) {
			picker.handleInput("\r");
			await tick();
			screen.selects[0].resolve("View details");
			await tick();
		}
		owner.abort();
		await command;
		assert.equal(owner.signal.aborted, true);
		for (const view of screen.views) { view.handleInput("\r"); view.handleInput("\x1b"); view.dispose?.(); }
		assert.equal(screen.notices.length, 0);
	}
});

test("Escape and declined confirmation leave running work untouched; confirmed cancellation settles", async () => {
	const { jobs, gates } = setup();
	const screen = ui();
	const owner = new AbortController();
	const dismissed = showJobPicker(screen.ctx, jobs, owner.signal);
	screen.views[0].handleInput("\x1b");
	await dismissed;
	assert.equal(screen.selects.length, 0);
	assert.equal(jobs.get("job-0")?.cancelRequested, false);
	const declined = showJobPicker(screen.ctx, jobs, owner.signal);
	screen.views[1].handleInput("\r");
	await tick();
	screen.selects[0].resolve("Cancel job");
	await tick();
	assert.equal(screen.confirms[0].signal, owner.signal);
	screen.confirms[0].resolve(false);
	await declined;
	assert.equal(jobs.get("job-0")?.cancelRequested, false);
	const approved = showJobPicker(screen.ctx, jobs, owner.signal);
	screen.views[2].handleInput("\r");
	await tick();
	screen.selects[1].resolve("Cancel job");
	await tick();
	screen.confirms[1].resolve(true);
	await tick();
	assert.equal(jobs.get("job-0")?.state, "cancelling");
	const cancelled = result("agent-0");
	cancelled.ok = false;
	cancelled.activity.state = "aborted";
	gates.get("agent-0")!.resolve(cancelled);
	await approved;
	assert.match(screen.notices.join("\n"), /cancelled.*edits are not undone/i);
	owner.abort();
});

test("completion winning during cancellation settlement reports success and points to retained results", async () => {
	const { jobs, gates } = setup();
	const screen = ui();
	const owner = new AbortController();
	const command = showJobPicker(screen.ctx, jobs, owner.signal);
	screen.views[0].handleInput("\r");
	await tick();
	screen.selects[0].resolve("Cancel job");
	await tick();
	// Resolve the child without flushing the registry's settlement microtasks.
	gates.get("agent-0")!.resolve(result("agent-0"));
	screen.confirms[0].resolve(true);
	await command;
	assert.equal(jobs.get("job-0")?.cancelRequested, true, "exercise the cancellation/settlement gap");
	assert.equal(jobs.get("job-0")?.results[0].ok, true);
	assert.match(screen.notices.join("\n"), /finished successfully.*\/subagents/);
	assert.doesNotMatch(screen.notices.join("\n"), /cancelled/);
	owner.abort();
});

test("natural failures and limits winning cancellation settlement retain their true outcome", async () => {
	for (const state of ["failed", "timed_out", "turn_limit"]) {
		const { jobs, gates } = setup();
		const screen = ui();
		const owner = new AbortController();
		const command = showJobPicker(screen.ctx, jobs, owner.signal);
		screen.views[0].handleInput("\r");
		await tick();
		screen.selects[0].resolve("Cancel job");
		await tick();
		const failure = { ...result("agent-0"), ok: false, error: "No API key", timedOut: state === "timed_out", turnLimitExceeded: state === "turn_limit" };
		failure.activity.state = state;
		gates.get("agent-0")!.resolve(failure);
		screen.confirms[0].resolve(true);
		await command;
		assert.equal(jobs.get("job-0")?.cancelRequested, true, "exercise the cancellation/settlement gap");
		assert.equal(jobs.get("job-0")?.results[0].activity.state, state);
		assert.match(screen.notices.join("\n"), /finished before cancellation took effect.*\/subagents/);
		assert.doesNotMatch(screen.notices.join("\n"), /cancelled|successfully/);
		owner.abort();
	}
});

test("already cancelling and retained terminal entries offer only details", async () => {
	const { jobs, gates } = setup();
	const owner = new AbortController();
	const cancellation = jobs.cancel("job-0");
	const first = ui();
	const open = showJobPicker(first.ctx, jobs, owner.signal);
	first.views[0].handleInput("\r");
	await tick();
	assert.deepEqual(first.selects[0].options, ["View details"]);
	first.selects[0].resolve(undefined);
	await open;
	gates.get("agent-0")!.resolve(result("agent-0"));
	await cancellation;
	const terminal = ui(6);
	const inspect = showJobPicker(terminal.ctx, jobs, owner.signal);
	terminal.views[0].handleInput("\r");
	await tick();
	assert.deepEqual(terminal.selects[0].options, ["View details"]);
	terminal.selects[0].resolve("View details");
	await tick();
	const details = terminal.views[1];
	const seen = new Set<string>();
	for (let i = 0; i < 50; i++) {
		for (const line of details.render(32)) seen.add(line);
		details.handleInput("\x1b[B");
	}
	const all = [...seen].join("\n");
	assert.match(all, /answer agent-0/);
	assert.match(all, /agent-0-output.md/);
	assert.match(all, /agent-0.session/);
	assert.doesNotMatch(all, /full task agent-0/); // terminal snapshots intentionally drop tasks
	details.handleInput("\x1b");
	await inspect;
	owner.abort();
});

test("cancelled details use consistent human outcomes while preserving answers, diagnostics and artifacts", async () => {
	const { jobs, gates } = setup();
	await tick();
	const cancelled = { ...result("agent-0"), ok: false, error: "aborted by user\nfull diagnostic", answer: "partial handoff", inlineAnswer: "partial handoff" };
	cancelled.activity.state = "aborted";
	gates.get("agent-0")!.resolve(cancelled);
	await tick();
	const before = structuredClone(jobs.get("job-0"));
	const screen = ui(6);
	const owner = new AbortController();
	const command = showJobPicker(screen.ctx, jobs, owner.signal);
	screen.views[0].handleInput("\r");
	await tick();
	screen.selects[0].resolve("View details");
	await tick();
	const view = screen.views[1];
	const seen = new Set<string>();
	for (let i = 0; i < 60; i++) {
		for (const line of view.render(80)) seen.add(line);
		view.handleInput("\x1b[B");
	}
	const all = [...seen].join("\n");
	assert.match(all, /agent-0: cancelled/);
	assert.doesNotMatch(all, /FAILED/);
	for (const expected of ["partial handoff", "aborted by user", "full diagnostic", "agent-0.jsonl", "agent-0-output.md", "agent-0.session"]) assert.ok(all.includes(expected), expected);
	assert.deepEqual(jobs.get("job-0"), before, "human rendering must not change stored/model-facing results");
	view.handleInput("\x1b");
	await command;
	owner.abort();
});

test("active multi-task details retain settled child answers and paths without waiting for whole job", async () => {
	const gates = new Map<string, ReturnType<typeof deferred<ReturnType<typeof result>>>>();
	const jobs = new JobRegistry({ runner: async (opts: { label: string }) => {
		const gate = deferred<ReturnType<typeof result>>();
		gates.set(opts.label, gate);
		return gate.promise;
	} });
	jobs.submit({ id: "multi", runDir: "/tmp/multi", background: true, children: [child("first"), child("second")] });
	await tick();
	gates.get("first")!.resolve(result("first"));
	await tick();
	const screen = ui(6);
	const owner = new AbortController();
	const command = showJobPicker(screen.ctx, jobs, owner.signal);
	screen.views[0].handleInput("\r");
	await tick();
	screen.selects[0].resolve("View details");
	await tick();
	const view = screen.views[1];
	const seen = new Set<string>();
	for (let i = 0; i < 100; i++) {
		for (const line of view.render(40)) seen.add(line);
		view.handleInput("\x1b[B");
	}
	const all = [...seen].join("\n");
	assert.match(all, /answer first/);
	assert.match(all, /first-output.md/);
	assert.match(all, /full task second/);
	view.handleInput("\x1b");
	await command;
	owner.abort();
	gates.get("second")!.resolve(result("second"));
});

test("details show complete active tasks and paths through width-safe scrolling and resize", async () => {
	const { jobs } = setup();
	const owner = new AbortController();
	const screen = ui(4);
	const command = showJobPicker(screen.ctx, jobs, owner.signal);
	screen.views[0].handleInput("\r");
	await tick();
	screen.selects[0].resolve("View details");
	await tick();
	const details = screen.views[1];
	const seen = new Set<string>();
	for (const width of [8, 20, 40]) {
		screen.terminal.columns = width;
		details.handleInput("\x1b[H");
		for (let i = 0; i < 100; i++) {
			const lines = details.render(width);
			assert.ok(lines.length <= screen.terminal.rows);
			assert.ok(lines.every((line) => visibleWidth(line) <= width));
			if (width === 40) for (const line of lines) seen.add(line);
			details.handleInput("\x1b[B");
		}
	}
	const all = [...seen].join("\n");
	assert.match(all, /full task agent-0/);
	assert.match(all, /second line/);
	assert.match(all, /agent-0.jsonl/);
	assert.match(all, /agent-0.session/);
	assert.doesNotMatch(all, /\x1b\[31m/);
	screen.terminal.rows = 2;
	assert.ok(details.render(8).length <= 2);
	screen.terminal.rows = 1;
	assert.ok(details.render(1).length <= 1);
	details.handleInput("\x1b");
	await command;
	owner.abort();
});

test("abort during action and confirmation awaits ignores late dialog results", async () => {
	for (const atConfirm of [false, true]) {
		const { jobs } = setup();
		const screen = ui();
		const owner = new AbortController();
		const command = showJobPicker(screen.ctx, jobs, owner.signal);
		screen.views[0].handleInput("\r");
		await tick();
		assert.equal(screen.selects[0].signal, owner.signal);
		if (atConfirm) {
			screen.selects[0].resolve("Cancel job");
			await tick();
		}
		owner.abort();
		if (atConfirm) screen.confirms[0].resolve(true);
		else screen.selects[0].resolve("Cancel job");
		await command;
		assert.equal(jobs.get("job-0")?.cancelRequested, false);
		assert.deepEqual(screen.notices, []);
	}
});

test("abort during cancellation settlement suppresses all stale notifications", async () => {
	const { jobs, gates } = setup();
	const screen = ui();
	const owner = new AbortController();
	const command = showJobPicker(screen.ctx, jobs, owner.signal);
	screen.views[0].handleInput("\r");
	await tick();
	screen.selects[0].resolve("Cancel job");
	await tick();
	screen.confirms[0].resolve(true);
	await tick();
	owner.abort();
	gates.get("agent-0")!.resolve(result("agent-0"));
	await command;
	assert.deepEqual(screen.notices, []);
});
