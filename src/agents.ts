/**
 * Agent resolution — a name maps to a markdown file with frontmatter + a system
 * prompt body. Sources, lowest to highest precedence:
 *   bundled (this package's agents/) < user (~/.pi/agent/agents) < project (.pi/agents)
 * Compatible with pi-subagents / tmux-subagent agent files.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";

export interface AgentConfig {
	name: string;
	description: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	systemPrompt: string;
	systemPromptMode?: "append" | "replace";
	source: "bundled" | "user" | "project";
	filePath: string;
}

const BUNDLED_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "agents");

function loadDir(dir: string, source: AgentConfig["source"], out: Map<string, AgentConfig>): void {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return;
	}
	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;
		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}
		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);
		if (!frontmatter.name) continue;
		const tools = frontmatter.tools?.split(",").map((t) => t.trim()).filter(Boolean);
		out.set(frontmatter.name, {
			name: frontmatter.name,
			description: frontmatter.description ?? "",
			model: frontmatter.model,
			thinking: frontmatter.thinking,
			tools: tools && tools.length > 0 ? tools : undefined,
			systemPrompt: body,
			systemPromptMode: frontmatter.systemPromptMode === "replace" ? "replace" : "append",
			source,
			filePath,
		});
	}
}

function findProjectAgentsDir(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = path.join(dir, ".pi", "agents");
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {
			/* not found */
		}
		const parent = path.dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function discoverAgents(cwd: string): Map<string, AgentConfig> {
	const agents = new Map<string, AgentConfig>();
	loadDir(BUNDLED_DIR, "bundled", agents);
	loadDir(path.join(os.homedir(), ".pi", "agent", "agents"), "user", agents);
	const projectDir = findProjectAgentsDir(cwd);
	if (projectDir) loadDir(projectDir, "project", agents);
	return agents;
}

/** Apply a model:thinking suffix unless the model already names a thinking level. */
export function applyThinking(model: string | undefined, thinking: string | undefined): string | undefined {
	if (!model || !thinking || thinking === "off") return model;
	if (/:(off|low|medium|high)$/.test(model)) return model;
	return `${model}:${thinking}`;
}
