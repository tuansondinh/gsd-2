import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { Agent } from "@gsd/pi-agent-core";
import { AuthStorage } from "./auth-storage.js";
import { AgentSession } from "./agent-session.js";
import { ModelRegistry } from "./model-registry.js";
import { DefaultResourceLoader } from "./resource-loader.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

let testDir: string;

function writeSkill(
	cwd: string,
	name: string,
	description: string,
	body = `# ${name}\n`,
	frontmatterExtras = "",
): string {
	const skillDir = join(cwd, ".lsd", "skills", name);
	mkdirSync(skillDir, { recursive: true });
	const skillPath = join(skillDir, "SKILL.md");
	writeFileSync(
		skillPath,
		`---\nname: ${name}\ndescription: ${description}${frontmatterExtras ? `\n${frontmatterExtras}` : ""}\n---\n\n${body}`,
	);
	return skillPath;
}

describe("Skill tool", () => {
	beforeEach(() => {
		testDir = mkdtempSync(join(tmpdir(), "skill-tool-test-"));
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	async function createSession() {
		const agentDir = join(testDir, "agent-home");
		const authStorage = AuthStorage.inMemory({});
		const modelRegistry = new ModelRegistry(authStorage, join(agentDir, "models.json"));
		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd: testDir,
			agentDir,
			settingsManager,
			additionalSkillPaths: [join(testDir, ".lsd", "skills")],
			noExtensions: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();

		return new AgentSession({
			agent: new Agent(),
			sessionManager: SessionManager.inMemory(testDir),
			settingsManager,
			cwd: testDir,
			resourceLoader,
			modelRegistry,
		});
	}

	it("resolves a project-level skill to the exact skill block format", async () => {
		const skillPath = writeSkill(
			testDir,
			"swift-testing",
			"Use for Swift Testing assertions and verification patterns.",
			"# Swift Testing\nUse this skill.\n",
		);
		const session = await createSession();

		const tool = session.state.tools.find((entry) => entry.name === "Skill");
		assert.ok(tool, "Skill tool should be registered");

		const result = await tool.execute("call-1", { skill: "swift-testing" });
		assert.equal(
			result.content[0]?.type === "text" ? result.content[0].text : "",
			`<skill name="swift-testing" location="${skillPath}">\nReferences are relative to ${join(testDir, ".lsd", "skills", "swift-testing")}.\n\n# Swift Testing\nUse this skill.\n</skill>`,
		);
	});

	it("returns a helpful error for unknown skills", async () => {
		writeSkill(testDir, "swift-testing", "Use for Swift Testing assertions and verification patterns.");
		const session = await createSession();
		const tool = session.state.tools.find((entry) => entry.name === "Skill");
		assert.ok(tool, "Skill tool should be registered");

		const result = await tool.execute("call-2", { skill: "nonexistent" });
		const message = result.content[0]?.type === "text" ? result.content[0].text : "";
		assert.match(message, /^Skill "nonexistent" not found\. Available skills: /);
		assert.match(message, /swift-testing/);
	});

	it("expands explicit /skill:name invocations", async () => {
		writeSkill(
			testDir,
			"teams-plan",
			"Plan and build a feature.",
			"# Teams Plan\nUse this skill.\n",
			"user-invocable: true",
		);
		const session = await createSession();
		const expanded = (session as unknown as { _expandSkillCommand: (text: string) => string })._expandSkillCommand(
			"/skill:teams-plan build auth",
		);
		assert.match(expanded, /<skill name="teams-plan"/);
		assert.match(expanded, /build auth/);
	});

	it("does not expand bare /name aliases even when user-invocable is set", async () => {
		writeSkill(
			testDir,
			"teams-plan",
			"Plan and build a feature.",
			"# Teams Plan\nUse this skill.\n",
			"user-invocable: true",
		);
		const session = await createSession();
		const expanded = (session as unknown as { _expandSkillCommand: (text: string) => string })._expandSkillCommand(
			"/teams-plan build auth",
		);
		assert.equal(expanded, "/teams-plan build auth");
	});

	it("does not treat bare /name skill invocations as commands when no skill: prefix is used", async () => {
		writeSkill(testDir, "internal-skill", "Internal only.", "# Internal\n");
		const session = await createSession();
		const expanded = (session as unknown as { _expandSkillCommand: (text: string) => string })._expandSkillCommand(
			"/internal-skill test",
		);
		assert.equal(expanded, "/internal-skill test");
	});
});
