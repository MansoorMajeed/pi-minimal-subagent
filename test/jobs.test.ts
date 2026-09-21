import assert from "node:assert/strict";
import test from "node:test";
import { createActivity, snapshotActivity } from "../src/activity.ts";
import { JobRegistry, type JobChildInput } from "../src/jobs.ts";
import type { SubagentResult, SubagentRunOptions } from "../src/spawn.ts";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
	return { promise, resolve, reject };
}

function child(name: string): JobChildInput {
	const activity = createActivity(name, "test/model", { task: `task ${name}`, goal: `goal ${name}` });
	return {
		activity,
		options: {
			task: activity.task,
			label: name,
			goal: activity.goal,
			logPath: `/tmp/${name}.jsonl`,
			cwd: "/tmp",
			timeoutMs: 1000,
		},
	};
}

function result(options: SubagentRunOptions, ok = true): SubagentResult {
	const activity = createActivity(options.label, options.model, { task: options.task, goal: options.goal });
	activity.state = ok ? "done" : "failed";
	activity.current = ok ? "done" : "failed";
	return {
		agent: options.label,
		ok,
		answer: ok ? `answer ${options.label}` : "",
		inlineAnswer: ok ? `answer ${options.label}` : "",
		exitCode: ok ? 0 : 1,
		logPath: options.logPath,
		timedOut: false,
		turnLimitExceeded: false,
		error: ok ? undefined : "failed",
		activity: snapshotActivity(activity),
		usage: { ...activity.usage },
	};
}

async function flush() {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

test("one registry shares four slots across simultaneous sync and background jobs in FIFO order", async () => {
	const pending = new Map<string, ReturnType<typeof deferred<SubagentResult>>>();
	const started: string[] = [];
	const registry = new JobRegistry({
		maxConcurrency: 4,
		runner: async (options) => {
			started.push(options.label);
			const wait = deferred<SubagentResult>();
			pending.set(options.label, wait);
			return wait.promise;
		},
	});

	const first = registry.submit({ id: "sync", runDir: "/tmp/sync", background: false, children: ["a", "b", "c"].map(child) });
	const second = registry.submit({ id: "async", runDir: "/tmp/async", background: true, children: ["d", "e", "f"].map(child) });
	await flush();
	assert.deepEqual(started, ["a", "b", "c", "d"]);
	assert.equal(registry.activeCount, 4);
	pending.get("b")!.resolve(result(child("b").options));
	await flush();
	assert.deepEqual(started, ["a", "b", "c", "d", "e"]);
	pending.get("a")!.resolve(result(child("a").options));
	await flush();
	assert.deepEqual(started, ["a", "b", "c", "d", "e", "f"]);
	for (const name of ["c", "d", "e", "f"]) pending.get(name)!.resolve(result(child(name).options));
	assert.deepEqual((await first.completion).map((item) => item.agent), ["a", "b", "c"]);
	assert.deepEqual((await second.completion).map((item) => item.agent), ["d", "e", "f"]);
	assert.equal(registry.activeCount, 0);
});

test("queued cancellation settles without spawning and running cancellation holds capacity until runner settlement", async () => {
	const gates = new Map<string, ReturnType<typeof deferred<SubagentResult>>>();
	const started: string[] = [];
	const registry = new JobRegistry({
		maxConcurrency: 1,
		runner: async (options) => {
			started.push(options.label);
			const gate = deferred<SubagentResult>();
			gates.set(options.label, gate);
			return gate.promise;
		},
	});
	const running = registry.submit({ id: "running", runDir: "/tmp/running", background: true, children: [child("a")] });
	const queued = registry.submit({ id: "queued", runDir: "/tmp/queued", background: true, children: [child("b"), child("c")] });
	await flush();
	const queuedCancellation = await registry.cancel("queued");
	assert.equal(queuedCancellation.disposition, "cancelled");
	assert.deepEqual(started, ["a"]);
	assert.deepEqual(queuedCancellation.results.map((item) => item.activity.state), ["aborted", "aborted"]);

	let cancelled = false;
	const cancellation = registry.cancel("running").then(() => { cancelled = true; });
	await flush();
	assert.equal(cancelled, false);
	assert.equal(registry.activeCount, 1);
	gates.get("a")!.resolve(result(child("a").options, false));
	await cancellation;
	assert.equal(registry.activeCount, 0);
	assert.deepEqual((await running.completion).map((item) => item.agent), ["a"]);
	assert.equal((await registry.cancel("running")).disposition, "already-terminal");
});

test("cancellation disposition reflects natural-completion and simultaneous races", async () => {
	const gates = new Map<string, ReturnType<typeof deferred<SubagentResult>>>();
	const registry = new JobRegistry({ runner: async (options) => {
		const gate = deferred<SubagentResult>();
		gates.set(options.label, gate);
		return gate.promise;
	} });

	registry.submit({ id: "natural", runDir: "/tmp/natural", background: true, children: [child("natural")] });
	await flush();
	gates.get("natural")!.resolve(result(child("natural").options));
	await flush();
	const after = await registry.cancel("natural");
	assert.equal(after.disposition, "already-terminal");
	assert.equal(after.results[0].ok, true);

	registry.submit({ id: "simultaneous", runDir: "/tmp/simultaneous", background: true, children: [child("simultaneous")] });
	await flush();
	gates.get("simultaneous")!.resolve(result(child("simultaneous").options));
	const racing = await registry.cancel("simultaneous");
	assert.equal(racing.disposition, "cancelled");
	assert.equal(racing.results[0].ok, true);
});

test("runner rejection becomes an ordered failure and never strands sibling work", async () => {
	const registry = new JobRegistry({
		maxConcurrency: 2,
		runner: async (options) => {
			if (options.label === "first") throw new Error("setup exploded");
			return result(options);
		},
	});
	const job = registry.submit({ id: "reject", runDir: "/tmp/reject", background: false, children: [child("first"), child("second")] });
	const results = await job.completion;
	assert.deepEqual(results.map((item) => item.agent), ["first", "second"]);
	assert.equal(results[0].ok, false);
	assert.match(results[0].error!, /setup exploded/);
	assert.equal(results[1].ok, true);
	assert.equal(registry.activeCount, 0);
});

test("terminal retention drops blocking records and keeps only background status snapshots", async () => {
	const registry = new JobRegistry({ runner: async (options) => result(options) });
	const blocking = registry.submit({ id: "blocking", runDir: "/tmp/blocking", background: false, children: [child("sync")] });
	await blocking.completion;
	assert.equal(registry.get("blocking"), undefined);
	assert.equal((registry as any).jobs.size, 0);

	const background = registry.submit({ id: "background", runDir: "/tmp/background", background: true, children: [child("async")] });
	await background.completion;
	const retained = (registry as any).jobs.get("background");
	assert.equal((registry as any).jobs.size, 1);
	assert.equal(retained.controller, undefined);
	assert.equal(retained.resolve, undefined);
	assert.equal(retained.completion, undefined);
	assert.deepEqual(retained.children, []);
	const snapshot = registry.get("background")!;
	assert.equal(snapshot.activities[0].task, "");
	assert.equal(snapshot.results![0].activity.task, "");
	assert.match(snapshot.results![0].answer, /answer async/);
});

test("disposal closes admission, aborts queued work, and waits for active settlement", async () => {
	const gate = deferred<SubagentResult>();
	const registry = new JobRegistry({ maxConcurrency: 1, runner: async () => gate.promise });
	const active = registry.submit({ id: "active", runDir: "/tmp/active", background: true, children: [child("a"), child("b")] });
	await flush();
	let disposed = false;
	let duplicateDisposed = false;
	const disposal = registry.dispose().then(() => { disposed = true; });
	const duplicateDisposal = registry.dispose().then(() => { duplicateDisposed = true; });
	await flush();
	assert.equal(disposed, false);
	assert.equal(duplicateDisposed, false);
	assert.throws(
		() => registry.submit({ id: "late", runDir: "/tmp/late", background: true, children: [child("late")] }),
		/closed/,
	);
	gate.resolve(result(child("a").options, false));
	await Promise.all([disposal, duplicateDisposal]);
	assert.equal(disposed, true);
	assert.equal(duplicateDisposed, true);
	assert.deepEqual((await active.completion).map((item) => item.activity.state), ["failed", "aborted"]);
});
