export const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
export const MAX_TIMER_DELAY_MS = 2_147_483_647;

export interface AgentRuntimeOptions {
	extensions?: string[];
	inheritProjectContext: boolean;
	maxTurns?: number;
	timeoutMs: number;
}

function normalizeList(raw: unknown): string[] {
	if (Array.isArray(raw)) return raw.map((item) => String(item).trim()).filter(Boolean);
	if (typeof raw === "string") return raw.split(",").map((item) => item.trim()).filter(Boolean);
	return [];
}

export function resolveAgentRuntimeOptions(frontmatter: Record<string, unknown>): AgentRuntimeOptions {
	const hasExtensions = Object.prototype.hasOwnProperty.call(frontmatter, "extensions");
	const rawMaxTurns = frontmatter.maxTurns;
	const rawTimeoutMs = frontmatter.timeoutMs;
	return {
		extensions: hasExtensions ? normalizeList(frontmatter.extensions) : undefined,
		inheritProjectContext: frontmatter.inheritProjectContext !== false,
		maxTurns:
			typeof rawMaxTurns === "number" && Number.isInteger(rawMaxTurns) && rawMaxTurns > 0
				? rawMaxTurns
				: undefined,
		timeoutMs:
			typeof rawTimeoutMs === "number" &&
			Number.isInteger(rawTimeoutMs) &&
			rawTimeoutMs > 0 &&
			rawTimeoutMs <= MAX_TIMER_DELAY_MS
				? rawTimeoutMs
				: DEFAULT_TIMEOUT_MS,
	};
}
