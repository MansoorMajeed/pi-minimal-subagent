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

export function withAppendPrompt(systemPrompt: string | undefined, append: string | undefined): string | undefined {
	if (!append) return systemPrompt;
	return systemPrompt?.trim() ? `${systemPrompt.trimEnd()}\n\n${append}` : append;
}
