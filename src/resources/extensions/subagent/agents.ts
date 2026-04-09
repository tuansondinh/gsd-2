/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, parseFrontmatter } from "@gsd/pi-coding-agent";

const PROJECT_AGENT_DIR_CANDIDATES = [".lsd", ".gsd", ".pi"] as const;

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	model?: string;
	systemPrompt: string;
	source: "bundled" | "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

function normalizeAgentModel(model: string | undefined): string | undefined {
	const trimmed = model?.trim();
	if (!trimmed) return undefined;
	if (trimmed === "$budget_model") return trimmed;
	if (trimmed.includes(" ")) return undefined;
	if (!trimmed.includes("/")) return trimmed;
	const parts = trimmed.split("/");
	return parts.length === 2 && parts.every(Boolean) ? trimmed : undefined;
}

function loadAgentsFromDir(dir: string, source: "bundled" | "user" | "project"): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
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

		const { frontmatter, body } = parseFrontmatter<Record<string, string>>(content);

		if (!frontmatter.name || !frontmatter.description) {
			continue;
		}

		const tools = frontmatter.tools
			?.split(",")
			.map((t: string) => t.trim())
			.filter(Boolean)
			.filter((tool: string, index: number, all: string[]) => all.indexOf(tool) === index);

		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: tools && tools.length > 0 ? tools : undefined,
			model: normalizeAgentModel(frontmatter.model),
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		// Prefer the documented project-local location while preserving support
		// for older workarounds that placed agents under .pi/agents.
		for (const configDir of PROJECT_AGENT_DIR_CANDIDATES) {
			const candidate = path.join(currentDir, configDir, "agents");
			if (isDirectory(candidate)) return candidate;
		}

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

function getBundledAgentsDir(): string {
	const here = path.dirname(fileURLToPath(import.meta.url));
	return path.resolve(here, "../../agents");
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const userDir = path.join(getAgentDir(), "agents");
	const bundledDir = getBundledAgentsDir();
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const bundledAgents = scope === "project" ? [] : loadAgentsFromDir(bundledDir, "bundled");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents = scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	const agentMap = new Map<string, AgentConfig>();

	const addAgents = (items: AgentConfig[]) => {
		for (const agent of items) agentMap.set(agent.name, agent);
	};

	if (scope === "both") {
		addAgents(bundledAgents);
		addAgents(userAgents);
		addAgents(projectAgents);
	} else if (scope === "user") {
		addAgents(bundledAgents);
		addAgents(userAgents);
	} else {
		addAgents(projectAgents);
	}

	return { agents: Array.from(agentMap.values()), projectAgentsDir };
}

export function formatAgentList(agents: AgentConfig[], maxItems: number): { text: string; remaining: number } {
	if (agents.length === 0) return { text: "none", remaining: 0 };
	const listed = agents.slice(0, maxItems);
	const remaining = agents.length - listed.length;
	return {
		text: listed.map((a) => `${a.name} (${a.source}): ${a.description}`).join("; "),
		remaining,
	};
}
