import { snapshotActivity, type ChildActivity } from "./activity.ts";
import { runSubagent, type SubagentResult, type SubagentRunOptions } from "./spawn.ts";

export interface JobChildInput {
	activity: ChildActivity;
	options: Omit<SubagentRunOptions, "signal" | "onActivity">;
}

interface JobChild {
	activity: ChildActivity;
	options?: Omit<SubagentRunOptions, "signal" | "onActivity">;
	result?: SubagentResult;
	running: boolean;
}

export interface SubmitJobInput {
	id: string;
	runDir: string;
	background: boolean;
	children: JobChildInput[];
}

export type JobState = "queued" | "running" | "cancelling" | "terminal";

export interface JobSnapshot {
	id: string;
	runDir: string;
	background: boolean;
	state: JobState;
	cancelRequested: boolean;
	activities: ChildActivity[];
	results?: SubagentResult[];
}

export interface JobHandle {
	id: string;
	completion: Promise<SubagentResult[]>;
	snapshot(): JobSnapshot;
}

interface JobRecord {
	id: string;
	runDir: string;
	background: boolean;
	children: JobChild[];
	controller?: AbortController;
	cancelRequested: boolean;
	terminal: boolean;
	resolve?: (results: SubagentResult[]) => void;
	completion?: Promise<SubagentResult[]>;
	terminalSnapshot?: JobSnapshot;
}

interface QueueEntry {
	job: JobRecord;
	index: number;
}

export interface JobRegistryOptions {
	maxConcurrency?: number;
	runner?: (options: SubagentRunOptions) => Promise<SubagentResult>;
	onChange?: () => void;
}

function terminalActivity(activity: ChildActivity, state: "aborted" | "failed", message: string): ChildActivity {
	const next = snapshotActivity(activity);
	next.state = state;
	next.current = message;
	next.recent = [...next.recent.filter((item) => item !== "queued"), message].slice(-5);
	return next;
}

function syntheticResult(child: JobChild, state: "aborted" | "failed", message: string): SubagentResult {
	const activity = terminalActivity(child.activity, state, message);
	return {
		agent: child.options!.label,
		ok: false,
		answer: "",
		inlineAnswer: "",
		exitCode: null,
		logPath: child.options!.logPath,
		timedOut: false,
		turnLimitExceeded: false,
		error: message,
		activity,
		usage: { ...activity.usage },
	};
}

export class JobRegistry {
	private readonly maxConcurrency: number;
	private readonly runner: (options: SubagentRunOptions) => Promise<SubagentResult>;
	private readonly onChange?: () => void;
	private readonly listeners = new Set<() => void>();
	private readonly jobs = new Map<string, JobRecord>();
	private queue: QueueEntry[] = [];
	private active = 0;
	private closed = false;
	private disposePromise?: Promise<void>;

	constructor(options: JobRegistryOptions = {}) {
		this.maxConcurrency = options.maxConcurrency ?? 4;
		this.runner = options.runner ?? runSubagent;
		this.onChange = options.onChange;
	}

	get activeCount(): number {
		return this.active;
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	submit(input: SubmitJobInput): JobHandle {
		if (this.closed) throw new Error("Subagent session runtime is closed.");
		if (this.jobs.has(input.id)) throw new Error(`Subagent job already exists: ${input.id}`);
		let resolve!: (results: SubagentResult[]) => void;
		const completion = new Promise<SubagentResult[]>((done) => { resolve = done; });
		const job: JobRecord = {
			id: input.id,
			runDir: input.runDir,
			background: input.background,
			children: input.children.map((item) => ({
				activity: snapshotActivity(item.activity),
				options: item.options,
				running: false,
			})),
			controller: new AbortController(),
			cancelRequested: false,
			terminal: false,
			resolve,
			completion,
		};
		this.jobs.set(job.id, job);
		for (let index = 0; index < job.children.length; index++) this.queue.push({ job, index });
		this.changed();
		this.pump();
		return { id: job.id, completion, snapshot: () => this.snapshot(job) };
	}

	get(id: string): JobSnapshot | undefined {
		const job = this.jobs.get(id);
		return job ? this.snapshot(job) : undefined;
	}

	listActiveBackground(): JobSnapshot[] {
		return [...this.jobs.values()]
			.filter((job) => job.background && !job.terminal)
			.map((job) => this.snapshot(job));
	}

	async cancel(id: string): Promise<SubagentResult[]> {
		const job = this.jobs.get(id);
		if (!job) throw new Error(`Unknown subagent job id: ${id}`);
		if (job.terminal) return job.terminalSnapshot!.results!;
		const completion = job.completion!;
		const controller = job.controller!;
		if (!job.cancelRequested) {
			job.cancelRequested = true;
			for (const child of job.children) {
				if (!child.running && !child.result) this.settleChild(job, child, syntheticResult(child, "aborted", "aborted before launch"));
			}
			controller.abort();
			this.changed();
			this.pump();
		}
		return completion;
	}

	dispose(): Promise<void> {
		if (!this.disposePromise) {
			this.closed = true;
			this.disposePromise = Promise.all(
				[...this.jobs.values()].filter((job) => !job.terminal).map((job) => this.cancel(job.id)),
			).then(() => undefined);
		}
		return this.disposePromise;
	}

	private pump(): void {
		while (this.active < this.maxConcurrency && this.queue.length > 0) {
			const entry = this.queue.shift()!;
			const child = entry.job.children[entry.index];
			if (entry.job.cancelRequested || child.result || child.running) continue;
			this.start(entry.job, child);
		}
	}

	private start(job: JobRecord, child: JobChild): void {
		child.running = true;
		this.active++;
		this.changed();
		void Promise.resolve()
			.then(() => this.runner({
				...child.options!,
				signal: job.controller!.signal,
				onActivity: (activity) => {
					if (job.terminal) return;
					child.activity = snapshotActivity(activity);
					this.changed();
				},
			}))
			.catch((error: unknown) => syntheticResult(child, "failed", `subagent runner failed: ${error instanceof Error ? error.message : String(error)}`))
			.then((result) => {
				child.running = false;
				this.active--;
				this.settleChild(job, child, result);
				this.pump();
			});
	}

	private settleChild(job: JobRecord, child: JobChild, result: SubagentResult): void {
		if (child.result) return;
		child.result = result;
		child.activity = snapshotActivity(result.activity);
		if (job.children.every((item) => item.result)) {
			const results = job.children.map((item) => item.result!);
			const resolve = job.resolve!;
			job.terminal = true;
			job.terminalSnapshot = {
				id: job.id,
				runDir: job.runDir,
				background: job.background,
				state: "terminal",
				cancelRequested: job.cancelRequested,
				activities: results.map((item) => ({ ...snapshotActivity(item.activity), task: "" })),
				results: results.map((item) => ({
					...item,
					activity: { ...snapshotActivity(item.activity), task: "" },
					usage: { ...item.usage },
				})),
			};
			if (!job.background) this.jobs.delete(job.id);
			job.children = [];
			job.controller = undefined;
			job.resolve = undefined;
			job.completion = undefined;
			resolve(results);
		}
		this.changed();
	}

	private snapshot(job: JobRecord): JobSnapshot {
		if (job.terminalSnapshot) {
			return {
				...job.terminalSnapshot,
				activities: job.terminalSnapshot.activities.map(snapshotActivity),
				results: job.terminalSnapshot.results?.map((item) => ({
					...item,
					activity: snapshotActivity(item.activity),
					usage: { ...item.usage },
				})),
			};
		}
		const running = job.children.some((child) => child.running);
		const state: JobState = job.terminal ? "terminal" : job.cancelRequested ? "cancelling" : running ? "running" : "queued";
		return {
			id: job.id,
			runDir: job.runDir,
			background: job.background,
			state,
			cancelRequested: job.cancelRequested,
			activities: job.children.map((child) => snapshotActivity(child.activity)),
			results: job.terminal ? job.children.map((child) => child.result!) : undefined,
		};
	}

	private changed(): void {
		this.onChange?.();
		for (const listener of this.listeners) listener();
	}
}
