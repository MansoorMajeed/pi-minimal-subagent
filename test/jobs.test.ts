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
	const queuedResults = await registry.cancel("queued");
	assert.deepEqual(started, ["a"]);
	assert.deepEqual(queuedResults.map((item) => item.activity.state), ["aborted", "aborted"]);

	let cancelled = false;
	const cancellation = registry.cancel("running").then(() => { cancelled = true; });
	await flush();
	assert.equal(cancelled, false);
	assert.equal(registry.activeCount, 1);
	gates.get("a")!.resolve(result(child("a").options, false));
	await cancellation;
	assert.equal(registry.activeCount, 0);
	assert.deepEqual((await running.completion).map((item) => item.agent), ["a"]);
	await registry.cancel("running");
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

test("disposal closes admission, aborts queued work, and waits for active settlement", async () => {
	const gate = deferred<SubagentResult>();
	const registry = new JobRegistry({ maxConcurrency: 1, runner: async () => gate.promise });
	const active = registry.submit({ id: "active", runDir: "/tmp/active", background: true, children: [child("a"), child("b")] });
	await flush();
	let disposed = false;
	const disposal = registry.dispose().then(() => { disposed = true; });
	await flush();
	assert.equal(disposed, false);
	assert.throws(
		() => registry.submit({ id: "late", runDir: "/tmp/late", background: true, children: [child("late")] }),
		/closed/,
	);
	gate.resolve(result(child("a").options, false));
	await disposal;
	assert.equal(disposed, true);
	assert.deepEqual((await active.completion).map((item) => item.activity.state), ["failed", "aborted"]);
});
