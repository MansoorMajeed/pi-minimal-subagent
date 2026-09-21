import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function findPackageRoot(start) {
	let current = start;
	while (true) {
		const packagePath = path.join(current, "package.json");
		if (fs.existsSync(packagePath) && JSON.parse(fs.readFileSync(packagePath, "utf8")).name === "@earendil-works/pi-coding-agent") return current;
		const parent = path.dirname(current);
		if (parent === current) throw new Error("could not locate installed pi package");
		current = parent;
	}
}

const piRoot = findPackageRoot(path.dirname(fs.realpathSync(execFileSync("which", ["pi"], { encoding: "utf8" }).trim())));
const piAiRoot = path.join(piRoot, "node_modules/@earendil-works/pi-ai");
const { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } = await import(pathToFileURL(path.join(piRoot, "dist/index.js")));
const { getModel, createAssistantMessageEventStream } = await import(pathToFileURL(path.join(piAiRoot, "dist/compat.js")));
const root = process.cwd();

async function reproduce(name, childDelay, abortDelay) {
	const temp = fs.mkdtempSync(path.join(os.tmpdir(), `minsub-runtime-race-${name}-`));
	const harness = path.join(temp, "harness");
	fs.mkdirSync(harness, { recursive: true });
	fs.cpSync(path.join(root, "src"), path.join(harness, "src"), { recursive: true });
	fs.cpSync(path.join(root, "agents"), path.join(harness, "agents"), { recursive: true });
	fs.copyFileSync(path.join(root, "SUBAGENT_MODELS.md"), path.join(harness, "SUBAGENT_MODELS.md"));
	fs.mkdirSync(path.join(harness, "node_modules/@earendil-works"), { recursive: true });
	fs.symlinkSync(piRoot, path.join(harness, "node_modules/@earendil-works/pi-coding-agent"), "dir");
	fs.symlinkSync(path.join(piRoot, "node_modules/@earendil-works/pi-tui"), path.join(harness, "node_modules/@earendil-works/pi-tui"), "dir");
	fs.symlinkSync(path.join(piRoot, "node_modules/typebox"), path.join(harness, "node_modules/typebox"), "dir");
	const extension = (await import(`${pathToFileURL(path.join(harness, "src/index.ts")).href}?${name}`)).default;

	const bin = path.join(temp, "bin");
	fs.mkdirSync(bin);
	fs.writeFileSync(path.join(bin, "pi"), `#!/usr/bin/env node\nconst m={role:'assistant',content:[{type:'text',text:'child done'}]};setTimeout(()=>{process.stdout.write(JSON.stringify({type:'agent_end',messages:[m]})+'\\n');},${childDelay});`, { mode: 0o755 });
	const oldPath = process.env.PATH;
	const oldMarker = process.env.PI_MINIMAL_SUBAGENT_CHILD;
	delete process.env.PI_MINIMAL_SUBAGENT_CHILD;
	process.env.PATH = `${bin}${path.delimiter}${oldPath}`;

	try {
		const loader = new DefaultResourceLoader({ cwd: harness, agentDir: path.join(temp, "agent"), extensionFactories: [extension] });
		await loader.reload();
		const model = getModel("anthropic", "claude-sonnet-4-5");
		const { session } = await createAgentSession({
			cwd: harness,
			agentDir: path.join(temp, "agent"),
			model,
			thinkingLevel: "off",
			resourceLoader: loader,
			sessionManager: SessionManager.inMemory(harness),
			settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
		});
		await session.modelRuntime.setRuntimeApiKey("anthropic", "fake");
		let streamCalls = 0;
		session.agent.getApiKey = async () => "fake";
		session.agent.streamFunction = (_model, _context, options = {}) => {
			streamCalls++;
			const stream = createAssistantMessageEventStream();
			const message = {
				role: "assistant",
				content: [{ type: "text", text: "parent interrupted" }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "pending",
				timestamp: Date.now(),
			};
			stream.push({ type: "start", partial: message });
			options.signal?.addEventListener("abort", () => setTimeout(() => {
				message.stopReason = "aborted";
				message.errorMessage = "aborted";
				stream.push({ type: "error", reason: "aborted", error: message });
				stream.end(message);
			}, 150), { once: true });
			return stream;
		};
		const uiContext = {
			setWidget() {}, notify() {}, confirm: async () => true, select: async () => undefined,
			input: async () => undefined, editor: async () => undefined, custom: async () => undefined,
			setStatus() {}, setWorkingMessage() {}, setEditorText() {}, getEditorText: () => "",
		};
		await session.bindExtensions({ mode: "tui", uiContext });
		const tool = session.extensionRunner.getToolDefinition("subagent");
		const ctx = {
			ui: uiContext, mode: "tui", hasUI: true, cwd: harness,
			sessionManager: session.sessionManager, modelRegistry: session.extensionRunner.getModelRegistry(),
			model: session.model, scopedModels: session.scopedModels, thinkingLevel: session.thinkingLevel,
			isIdle: () => session.isIdle, isProjectTrusted: () => true,
		};
		await tool.execute("launch", { tasks: [{ agent: "worker", task: name }] }, undefined, undefined, ctx);
		const parent = session.prompt("stay busy");
		await new Promise((resolve) => setTimeout(resolve, abortDelay));
		await session.abort();
		await parent;
		const entries = session.sessionManager.getEntries();
		const customCompletions = entries.filter((entry) =>
			(entry.type === "custom_message" || entry.type === "message") &&
			(entry.message?.customType ?? entry.customType) === "minimal-subagent-complete"
		).length;
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "new" });
		session.dispose();
		return { name, streamCalls, customCompletions };
	} finally {
		process.env.PATH = oldPath;
		if (oldMarker === undefined) delete process.env.PI_MINIMAL_SUBAGENT_CHILD;
		else process.env.PI_MINIMAL_SUBAGENT_CHILD = oldMarker;
		fs.rmSync(temp, { recursive: true, force: true });
	}
}

const results = [
	await reproduce("completion-during-abort", 80, 20),
	await reproduce("completion-pending-before-abort", 20, 80),
];
for (const result of results) {
	if (result.streamCalls !== 1 || result.customCompletions !== 0) {
		throw new Error(`runtime race reproduced: ${JSON.stringify(result)}`);
	}
}
console.log(JSON.stringify(results));
