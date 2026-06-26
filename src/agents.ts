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

/** Accept `tools` as a comma-separated string or a YAML sequence. */
function normalizeTools(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
	if (typeof raw === "string") return raw.split(",").map((t) => t.trim()).filter(Boolean);
	return [];
}

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
		let frontmatter: Record<string, unknown>;
		let body: string;
		try {
			const parsed = parseFrontmatter<Record<string, unknown>>(content);
			frontmatter = parsed.frontmatter;
			body = parsed.body;
		} catch {
			continue; // one malformed-YAML file must not take down agent discovery
		}
		const name = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
		if (!name) continue;
		const tools = normalizeTools(frontmatter.tools);
		out.set(name, {
			name,
			description: typeof frontmatter.description === "string" ? frontmatter.description : "",
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			thinking: typeof frontmatter.thinking === "string" ? frontmatter.thinking : undefined,
			tools: tools.length > 0 ? tools : undefined,
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

