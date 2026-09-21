import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const BUNDLED_GUIDE = fileURLToPath(new URL("../SUBAGENT_MODELS.md", import.meta.url));
const MAX_MODEL_MATCHES = 50;

export function loadModelGuide(agentDir: string): { filePath: string; text: string } {
	const filePath = path.join(agentDir, "SUBAGENT_MODELS.md");
	try {
		return { filePath, text: fs.readFileSync(filePath, "utf8") };
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		return { filePath: BUNDLED_GUIDE, text: fs.readFileSync(BUNDLED_GUIDE, "utf8") };
	}
}

interface ModelEntry {
	provider: string;
	id: string;
	name: string;
}

export function searchModels(models: readonly ModelEntry[], query: string): { matches: ModelEntry[]; total: number } {
	const term = query.trim().toLowerCase();
	if (!term) throw new Error("subagent action 'models' requires a nonblank query (e.g. 'luna').");
	const matches = models
		.filter((model) => `${model.provider}/${model.id}`.toLowerCase().includes(term) || model.name.toLowerCase().includes(term))
		.sort((a, b) => `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`));
	return { matches: matches.slice(0, MAX_MODEL_MATCHES), total: matches.length };
}
