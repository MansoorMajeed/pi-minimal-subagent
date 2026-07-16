export const MINIMAL_SUBAGENT_CHILD_ENV = "PI_MINIMAL_SUBAGENT_CHILD";

export function isMinimalSubagentChild(env: Record<string, string | undefined> = process.env): boolean {
	return env[MINIMAL_SUBAGENT_CHILD_ENV] === "1";
}
