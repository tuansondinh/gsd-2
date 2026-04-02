import * as path from "node:path";

import type { AgentConfig } from "./agents.js";

export function getBundledExtensionPathsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
	const rawPaths = [env.GSD_BUNDLED_EXTENSION_PATHS, env.LSD_BUNDLED_EXTENSION_PATHS]
		.map((value) => value?.trim())
		.filter((value): value is string => Boolean(value));
	const unique = new Set<string>();
	for (const raw of rawPaths) {
		for (const entry of raw.split(path.delimiter).map((value) => value.trim()).filter(Boolean)) {
			unique.add(entry);
		}
	}
	return Array.from(unique);
}

export function buildSubagentProcessArgs(
	agent: AgentConfig,
	task: string,
	tmpPromptPath: string | null,
	model: string | undefined,
): string[] {
	const args: string[] = ["--mode", "json", "-p", "--no-session"];
	if (model) args.push("--model", model);
	if (agent.tools && agent.tools.length > 0) args.push("--tools", agent.tools.join(","));
	if (tmpPromptPath) args.push("--append-system-prompt", tmpPromptPath);
	args.push(`Task: ${task}`);
	return args;
}
