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
	options?: { noSession?: boolean; parentSessionFile?: string; mode?: "json" | "rpc" },
): string[] {
	const mode = options?.mode ?? "json";
	const args: string[] = ["--mode", mode];
	if (mode === "json") args.push("-p");
	if (options?.noSession ?? true) args.push("--no-session");
	if (options?.parentSessionFile) args.push("--parent-session", options.parentSessionFile);
	args.push("--subagent-name", agent.name);
	args.push("--subagent-task", task);
	const uniqueTools = agent.tools?.filter((tool, index, all) => all.indexOf(tool) === index);
	if (uniqueTools && uniqueTools.length > 0) args.push("--subagent-tools", uniqueTools.join(","));
	if (model) args.push("--model", model);
	if (uniqueTools && uniqueTools.length > 0) args.push("--tools", uniqueTools.join(","));
	if (tmpPromptPath) {
		args.push("--append-system-prompt", tmpPromptPath);
		args.push("--subagent-system-prompt-file", tmpPromptPath);
	}
	if (mode === "json") args.push(`Task: ${task}`);
	return args;
}
