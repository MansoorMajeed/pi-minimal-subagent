export const DEFAULT_MAX_TURNS = 20;

export interface AgentRuntimeOptions {
	extensions?: string[];
	inheritProjectContext: boolean;
	maxTurns: number;
}

function normalizeList(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
	if (typeof raw === "string") return raw.split(",").map((item) => item.trim()).filter(Boolean);
	return [];
}

export function resolveAgentRuntimeOptions(frontmatter: Record<string, unknown>): AgentRuntimeOptions {
	const hasExtensions = Object.prototype.hasOwnProperty.call(frontmatter, "extensions");
	const rawMaxTurns = frontmatter.maxTurns;
	return {
		extensions: hasExtensions ? normalizeList(frontmatter.extensions) : undefined,
		inheritProjectContext: frontmatter.inheritProjectContext !== false,
		maxTurns:
			typeof rawMaxTurns === "number" && Number.isInteger(rawMaxTurns) && rawMaxTurns > 0
				? rawMaxTurns
				: DEFAULT_MAX_TURNS,
	};
}
