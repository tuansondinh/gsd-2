import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, parse } from "node:path";
import {
	AuthStorage,
	createAgentSession,
	DefaultResourceLoader,
	ModelRegistry,
	SessionManager,
	SettingsManager,
	type AgentToolResult,
} from "@gsd/pi-coding-agent";

import { initResources } from "../resource-loader.ts";
import { discoverAgents } from "../resources/extensions/subagent/agents.ts";
import { buildSubagentProcessArgs, getBundledExtensionPathsFromEnv } from "../resources/extensions/subagent/launch-helpers.ts";
import { stopLiveSubagents } from "../resources/extensions/subagent/index.ts";

function overrideHomeEnv(homeDir: string): () => void {
	const original = {
		HOME: process.env.HOME,
		USERPROFILE: process.env.USERPROFILE,
		HOMEDRIVE: process.env.HOMEDRIVE,
		HOMEPATH: process.env.HOMEPATH,
	};

	process.env.HOME = homeDir;
	process.env.USERPROFILE = homeDir;

	if (process.platform === "win32") {
		const parsedHome = parse(homeDir);
		process.env.HOMEDRIVE = parsedHome.root.replace(/[\\/]+$/, "");
		const homePath = homeDir.slice(parsedHome.root.length).replace(/\//g, "\\");
		process.env.HOMEPATH = homePath.startsWith("\\") ? homePath : `\\${homePath}`;
	}

	return () => {
		if (original.HOME === undefined) delete process.env.HOME; else process.env.HOME = original.HOME;
		if (original.USERPROFILE === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = original.USERPROFILE;
		if (original.HOMEDRIVE === undefined) delete process.env.HOMEDRIVE; else process.env.HOMEDRIVE = original.HOMEDRIVE;
		if (original.HOMEPATH === undefined) delete process.env.HOMEPATH; else process.env.HOMEPATH = original.HOMEPATH;
	};
}

function withTempProject(t: test.TestContext) {
	const root = mkdtempSync(join(tmpdir(), "lsd-subagent-test-"));
	const home = join(root, "home");
	const project = join(root, "project");
	const agentDir = join(home, ".lsd", "agent");
	mkdirSync(home, { recursive: true });
	mkdirSync(project, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const restoreHome = overrideHomeEnv(home);
	const originalAgentDir = process.env.LSD_CODING_AGENT_DIR;
	process.env.LSD_CODING_AGENT_DIR = agentDir;

	t.after(() => {
		restoreHome();
		if (originalAgentDir === undefined) delete process.env.LSD_CODING_AGENT_DIR;
		else process.env.LSD_CODING_AGENT_DIR = originalAgentDir;
		rmSync(root, { recursive: true, force: true });
	});

	return { root, home, project, agentDir };
}

function writeAgentFile(dir: string, fileName: string, frontmatter: string[], body = "Agent body\n"): string {
	mkdirSync(dir, { recursive: true });
	const filePath = join(dir, fileName);
	writeFileSync(filePath, `---\n${frontmatter.join("\n")}\n---\n\n${body}`);
	return filePath;
}

function writeSkillDir(baseDir: string, name: string, description: string, body = "# Skill\n"): string {
	const skillDir = join(baseDir, name);
	mkdirSync(skillDir, { recursive: true });
	const skillPath = join(skillDir, "SKILL.md");
	writeFileSync(skillPath, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}`);
	return skillPath;
}

function writeProviderExtension(filePath: string): void {
	writeFileSync(
		filePath,
		`import { AssistantMessageEventStream } from "@gsd/pi-ai";

export default function(pi) {
	pi.registerProvider("test-provider", {
		authMode: "none",
		baseUrl: "http://localhost:11434",
		api: "openai-completions",
		models: [{
			id: "test-model",
			name: "Test Model",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000,
			maxTokens: 1024,
		}],
		streamSimple() {
			const stream = new AssistantMessageEventStream();
			queueMicrotask(() => {
				stream.end({
					role: "assistant",
					content: [{ type: "text", text: "test-provider reply" }],
					api: "openai-completions",
					provider: "test-provider",
					model: "test-model",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "stop",
					timestamp: Date.now(),
				});
			});
			return stream;
		},
	});
}
`,
	);
}

async function createSubagentSession(projectDir: string, agentDir: string) {
	const authStorage = AuthStorage.inMemory({});
	const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory(projectDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: projectDir,
		agentDir,
		settingsManager,
		noPromptTemplates: true,
		noThemes: true,
	});
	await resourceLoader.reload();
	const { session } = await createAgentSession({
		cwd: projectDir,
		agentDir,
		authStorage,
		modelRegistry,
		settingsManager,
		sessionManager,
		resourceLoader,
	});
	return session;
}

async function executeSubagentTool(
	projectDir: string,
	agentDir: string,
	args: Record<string, unknown>,
): Promise<AgentToolResult<any>> {
	const session = await createSubagentSession(projectDir, agentDir);
	try {
		const tool = session.state.tools.find((entry) => entry.name === "subagent");
		assert.ok(tool, "subagent tool should be registered");
		return await (tool.execute("call-1", args) as Promise<AgentToolResult<any>>);
	} finally {
		session.dispose();
		await stopLiveSubagents();
	}
}

test("discoverAgents finds user and project agents with project override and scope filtering", (t) => {
	const { project, agentDir } = withTempProject(t);
	const userAgentsDir = join(agentDir, "agents");
	const projectAgentsDir = join(project, ".lsd", "agents");

	writeAgentFile(userAgentsDir, "user-only.md", ["name: user-only", "description: User only agent"]);
	writeAgentFile(userAgentsDir, "collision.md", ["name: collision", "description: User collision"]);
	const bundledScout = discoverAgents(project, "user").agents.find((agent) => agent.name === "scout");
	writeAgentFile(projectAgentsDir, "project-only.md", ["name: project-only", "description: Project only agent"]);
	const projectCollisionPath = writeAgentFile(projectAgentsDir, "collision.md", [
		"name: collision",
		"description: Project collision",
	]);

	const both = discoverAgents(join(project, "nested", "deeper"), "both");
	assert.equal(both.projectAgentsDir, projectAgentsDir);
	assert.equal(both.agents.find((agent) => agent.name === "collision")?.description, "Project collision");
	assert.equal(both.agents.find((agent) => agent.name === "collision")?.source, "project");
	assert.equal(both.agents.find((agent) => agent.name === "collision")?.filePath, projectCollisionPath);
	assert.ok(both.agents.some((agent) => agent.name === "user-only"));
	assert.ok(both.agents.some((agent) => agent.name === "project-only"));
	if (bundledScout) {
		assert.ok(both.agents.some((agent) => agent.name === "scout" && agent.source === bundledScout.source));
	}

	const userOnly = discoverAgents(project, "user");
	assert.ok(userOnly.agents.some((agent) => agent.name === "collision"));
	assert.ok(userOnly.agents.some((agent) => agent.name === "user-only"));
	assert.ok(!userOnly.agents.some((agent) => agent.name === "project-only"));

	const projectOnly = discoverAgents(project, "project");
	assert.deepEqual(projectOnly.agents.map((agent) => agent.name).sort(), ["collision", "project-only"]);
});

test("discoverAgents parses agent frontmatter, keeps $budget_model, and drops malformed models", (t) => {
	const { project, agentDir } = withTempProject(t);
	const userAgentsDir = join(agentDir, "agents");

	writeAgentFile(userAgentsDir, "valid.md", [
		"name: valid-agent",
		"description: Valid agent",
		"model: $budget_model",
		"tools: read, bash, , lsp, bash, read",
	], "Valid body\n");
	writeAgentFile(userAgentsDir, "missing-name.md", ["description: Missing name"]);
	writeAgentFile(userAgentsDir, "missing-description.md", ["name: missing-description"]);
	writeAgentFile(userAgentsDir, "invalid-model-spaces.md", [
		"name: invalid-model-spaces",
		"description: Invalid model spaces",
		"model: bad model",
	]);
	writeAgentFile(userAgentsDir, "invalid-model-slashes.md", [
		"name: invalid-model-slashes",
		"description: Invalid model slashes",
		"model: anthropic/claude/sonnet",
	]);
	writeAgentFile(userAgentsDir, "empty-tools.md", [
		"name: empty-tools",
		"description: Empty tools",
		"tools: ', ,'",
		"model: sonnet",
	]);

	const result = discoverAgents(project, "user");
	const names = result.agents.map((agent) => agent.name);
	assert.ok(names.includes("valid-agent"));
	assert.ok(names.includes("invalid-model-spaces"));
	assert.ok(names.includes("invalid-model-slashes"));
	assert.ok(names.includes("empty-tools"));

	const valid = result.agents.find((agent) => agent.name === "valid-agent");
	assert.equal(valid?.model, "$budget_model");
	assert.deepEqual(valid?.tools, ["read", "bash", "lsp"]);
	assert.equal(valid?.systemPrompt.trim(), "Valid body");
	assert.equal(result.agents.find((agent) => agent.name === "invalid-model-spaces")?.model, undefined);
	assert.equal(result.agents.find((agent) => agent.name === "invalid-model-slashes")?.model, undefined);
	assert.equal(result.agents.find((agent) => agent.name === "empty-tools")?.tools, undefined);
	assert.equal(result.agents.find((agent) => agent.name === "empty-tools")?.model, "sonnet");
});

test("discoverAgents includes bundled system agents when synced agent dir is empty", (t) => {
	const { project } = withTempProject(t);
	const result = discoverAgents(project, "user");
	const scout = result.agents.find((agent) => agent.name === "scout");
	assert.ok(scout, "expected bundled scout agent to be discoverable");
	assert.equal(scout?.source, "bundled");
});

test("resource loader discovers project, user, and bundled skills with project shadowing user", async (t) => {
	const { project, home, agentDir } = withTempProject(t);
	const userSkillsDir = join(home, ".agents", "skills");
	const projectSkillsDir = join(project, ".lsd", "skills");

	const userShadowPath = writeSkillDir(userSkillsDir, "shadowed-skill", "User version", "# User\n");
	const projectShadowPath = writeSkillDir(projectSkillsDir, "shadowed-skill", "Project version", "# Project\n");
	writeSkillDir(userSkillsDir, "user-only-skill", "User only", "# User only\n");
	writeSkillDir(projectSkillsDir, "project-only-skill", "Project only", "# Project only\n");

	const bundledSkillsPath = existsSync(join(process.cwd(), "dist", "resources", "skills"))
		? join(process.cwd(), "dist", "resources", "skills")
		: join(process.cwd(), "src", "resources", "skills");

	const loader = new DefaultResourceLoader({
		cwd: project,
		agentDir,
		additionalSkillPaths: [bundledSkillsPath],
		noExtensions: true,
		noPromptTemplates: true,
		noThemes: true,
	});
	await loader.reload();

	const skills = loader.getSkills().skills;
	assert.ok(skills.some((skill) => skill.name === "project-only-skill"));
	assert.ok(skills.some((skill) => skill.name === "user-only-skill"));
	assert.ok(skills.some((skill) => skill.name === "create-skill"), "bundled skills should be discovered");
	assert.equal(skills.find((skill) => skill.name === "shadowed-skill")?.filePath, projectShadowPath);
	assert.notEqual(userShadowPath, projectShadowPath);
});

test("subagent helper reads empty, missing, and multiple bundled extension env paths", () => {
	assert.deepEqual(getBundledExtensionPathsFromEnv({}), []);
	assert.deepEqual(getBundledExtensionPathsFromEnv({ GSD_BUNDLED_EXTENSION_PATHS: "   " }), []);

	const extensionA = "/tmp/ext-a.js";
	const extensionB = "/tmp/ext-b.js";
	assert.deepEqual(
		getBundledExtensionPathsFromEnv({
			GSD_BUNDLED_EXTENSION_PATHS: `${extensionA}${delimiter}${extensionB}`,
			LSD_BUNDLED_EXTENSION_PATHS: `${extensionB}${delimiter}${extensionA}`,
		}),
		[extensionA, extensionB],
	);
});

test("subagent process args include resolved model, tools, and prompt path", () => {
	const args = buildSubagentProcessArgs(
		{
			name: "scout",
			description: "Scout",
			tools: ["read", "lsp"],
			systemPrompt: "body",
			source: "user",
			filePath: "/tmp/scout.md",
		},
		"investigate auth flow",
		"/tmp/prompt.md",
		"test-provider/test-model",
	);

	assert.deepEqual(args, [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		"test-provider/test-model",
		"--tools",
		"read,lsp",
		"--append-system-prompt",
		"/tmp/prompt.md",
		"Task: investigate auth flow",
	]);
});

test("subagent process args dedupe duplicate tool names", () => {
	const args = buildSubagentProcessArgs(
		{
			name: "scout",
			description: "Scout",
			tools: ["read", "lsp", "read", "grep", "lsp"],
			systemPrompt: "body",
			source: "user",
			filePath: "/tmp/scout.md",
		},
		"investigate auth flow",
		null,
		undefined,
	);

	assert.deepEqual(args, [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--tools",
		"read,lsp,grep",
		"Task: investigate auth flow",
	]);
});

test("integration: scout resolves $budget_model to provider/id and runs successfully", async (t) => {
	const { project, agentDir } = withTempProject(t);
	initResources(agentDir);
	writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ budgetSubagentModel: "test-provider/test-model" }));
	const extensionPath = join(project, "test-provider-extension.js");
	writeProviderExtension(extensionPath);
	const originalBundledPaths = process.env.GSD_BUNDLED_EXTENSION_PATHS;
	process.env.GSD_BUNDLED_EXTENSION_PATHS = extensionPath;
	process.env.LSD_BUNDLED_EXTENSION_PATHS = extensionPath;

	t.after(() => {
		if (originalBundledPaths === undefined) delete process.env.GSD_BUNDLED_EXTENSION_PATHS;
		else process.env.GSD_BUNDLED_EXTENSION_PATHS = originalBundledPaths;
		delete process.env.LSD_BUNDLED_EXTENSION_PATHS;
		return stopLiveSubagents();
	});

	const result = await executeSubagentTool(project, agentDir, {
		agent: "scout",
		task: "Return a short acknowledgement.",
	});

	assert.equal(result.details?.results?.[0]?.exitCode, 0);
	assert.equal(result.details?.results?.[0]?.model, "test-provider/test-model");
	assert.match(result.content[0]?.type === "text" ? result.content[0].text : "", /test-provider reply/);
});

test("integration: built-in teams-builder and teams-reviewer agents can be found and spawned", async (t) => {
	const { project, agentDir } = withTempProject(t);
	initResources(agentDir);
	const extensionPath = join(project, "test-provider-extension.js");
	writeProviderExtension(extensionPath);
	const originalBundledPaths = process.env.GSD_BUNDLED_EXTENSION_PATHS;
	process.env.GSD_BUNDLED_EXTENSION_PATHS = extensionPath;
	process.env.LSD_BUNDLED_EXTENSION_PATHS = extensionPath;

	t.after(() => {
		if (originalBundledPaths === undefined) delete process.env.GSD_BUNDLED_EXTENSION_PATHS;
		else process.env.GSD_BUNDLED_EXTENSION_PATHS = originalBundledPaths;
		delete process.env.LSD_BUNDLED_EXTENSION_PATHS;
		return stopLiveSubagents();
	});

	const agents = discoverAgents(project, "user");
	assert.ok(agents.agents.some((agent) => agent.name === "teams-builder"));
	assert.ok(agents.agents.some((agent) => agent.name === "teams-reviewer"));

	const builder = await executeSubagentTool(project, agentDir, {
		agent: "teams-builder",
		task: "Acknowledge readiness.",
		model: "test-provider/test-model",
	});
	const reviewer = await executeSubagentTool(project, agentDir, {
		agent: "teams-reviewer",
		task: "Acknowledge readiness.",
		model: "test-provider/test-model",
	});

	assert.equal(builder.details?.results?.[0]?.exitCode, 0);
	assert.equal(reviewer.details?.results?.[0]?.exitCode, 0);
	assert.equal(builder.details?.results?.[0]?.model, "test-provider/test-model");
	assert.equal(reviewer.details?.results?.[0]?.model, "test-provider/test-model");
});

test.after(() => {
	setImmediate(() => process.exit(process.exitCode ?? 0));
});
