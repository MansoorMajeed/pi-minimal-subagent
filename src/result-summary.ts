import type { SubagentResult } from "./spawn.ts";

export function summarize(results: SubagentResult[]): string {
	const parts: string[] = [];
	for (let i = 0; i < results.length; i++) {
		const r = results[i];
		const status = r.ok ? "ok" : r.timedOut ? "TIMED OUT" : r.turnLimitExceeded ? "TURN LIMIT" : "FAILED";
		parts.push(`### [${i + 1}] ${r.agent} — ${status}`);
		if (r.inlineAnswer) {
			parts.push(r.inlineAnswer);
			if (r.error) parts.push(`Diagnostic: ${r.error}`);
		} else if (r.error) parts.push(`(no answer: ${r.error})`);
		parts.push(`\n_log: ${r.logPath}_`);
		parts.push("");
	}
	return parts.join("\n").trim();
}
