import * as fs from "node:fs";
import * as path from "node:path";

/** Names a file whose text is appended to every child's system prompt, e.g. host rules from an embedding app. */
export const CHILD_APPEND_PROMPT_ENV = "PI_MINIMAL_SUBAGENT_APPEND_PROMPT";

export function loadChildAppendPrompt(env: Record<string, string | undefined> = process.env): string | undefined {
	const file = env[CHILD_APPEND_PROMPT_ENV];
	if (!file) return undefined;
	if (!path.isAbsolute(file)) throw new Error(`${CHILD_APPEND_PROMPT_ENV} must be an absolute path: ${file}`);
	try {
		return fs.readFileSync(file, "utf8").trim() || undefined;
	} catch (error) {
		throw new Error(`${CHILD_APPEND_PROMPT_ENV} could not be read (${file}): ${error instanceof Error ? error.message : String(error)}`);
	}
}

/** Names absolute extension paths (":"-separated) that every child loads, e.g. tools from an embedding app. */
export const CHILD_EXTENSIONS_ENV = "PI_MINIMAL_SUBAGENT_CHILD_EXTENSIONS";

export function loadChildExtensions(env: Record<string, string | undefined> = process.env): string[] {
	const value = env[CHILD_EXTENSIONS_ENV];
	if (!value) return [];
	const paths = value.split(":").filter((entry) => entry !== "");
	for (const file of paths) {
		if (!path.isAbsolute(file)) throw new Error(`${CHILD_EXTENSIONS_ENV} entries must be absolute paths: ${file}`);
	}
	return paths;
}

/**
 * Names tools (","-separated) added to the allowlist of every child whose agent sets
 * `tools`. pi's --tools replaces the whole active set, extension tools included, so
 * host extension tools are otherwise off for those agents.
 */
export const CHILD_TOOLS_ENV = "PI_MINIMAL_SUBAGENT_CHILD_TOOLS";

export function loadChildTools(env: Record<string, string | undefined> = process.env): string[] {
	const names = (env[CHILD_TOOLS_ENV] ?? "").split(",").map((entry) => entry.trim()).filter((entry) => entry !== "");
	for (const name of names) {
		if (/\s/.test(name)) throw new Error(`${CHILD_TOOLS_ENV} entries must be tool names separated by commas: ${name}`);
	}
	return names;
}

/** An agent without an allowlist keeps pi's default selection, which already includes extension tools. */
export function withHostTools(tools: string[] | undefined, hostTools: string[]): string[] | undefined {
	if (!tools?.length || hostTools.length === 0) return tools;
	return [...new Set([...tools, ...hostTools])];
}

export function withAppendPrompt(systemPrompt: string | undefined, append: string | undefined): string | undefined {
	if (!append) return systemPrompt;
	return systemPrompt?.trim() ? `${systemPrompt.trimEnd()}\n\n${append}` : append;
}
