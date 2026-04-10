import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DefaultResourceLoader } from "./resource-loader.js";
import { createAgentSession } from "./sdk.js";
import { AuthStorage } from "./auth-storage.js";
import { ModelRegistry } from "./model-registry.js";
import { SessionManager } from "./session-manager.js";
import { SettingsManager } from "./settings-manager.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// best effort cleanup
		}
	}
});

test("createAgentSession restores last session model even when API key cannot be resolved at startup", async () => {
	const tempDir = join(
		process.cwd(),
		".tmp-tests",
		`sdk-restore-model-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDir, { recursive: true });
	tempDirs.push(tempDir);

	const authStorage = AuthStorage.inMemory({
		anthropic: { type: "api_key", key: "test-anthropic-key" },
	});
	const modelRegistry = new ModelRegistry(authStorage, join(tempDir, "models.json"));
	const settingsManager = SettingsManager.inMemory();
	const sessionManager = SessionManager.inMemory(tempDir);

	sessionManager.appendMessage({
		role: "user",
		content: [{ type: "text", text: "hello" }],
		timestamp: Date.now(),
	});
	sessionManager.appendModelChange("zai", "glm-4.7");

	const resourceLoader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir: tempDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});

	const originalZaiKey = process.env.ZAI_API_KEY;
	delete process.env.ZAI_API_KEY;

	try {
		const { session, modelFallbackMessage } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			modelRegistry,
			settingsManager,
			sessionManager,
			resourceLoader,
		});

		assert.equal(modelFallbackMessage, undefined);
		assert.equal(session.model?.provider, "zai");
		assert.equal(session.model?.id, "glm-4.7");
		session.dispose();
	} finally {
		if (originalZaiKey === undefined) {
			delete process.env.ZAI_API_KEY;
		} else {
			process.env.ZAI_API_KEY = originalZaiKey;
		}
	}
});

test("createAgentSession defaults to adaptive for supported Anthropic models when enabled", async () => {
	const tempDir = join(
		process.cwd(),
		".tmp-tests",
		`sdk-anthropic-adaptive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDir, { recursive: true });
	tempDirs.push(tempDir);

	const authStorage = AuthStorage.inMemory({
		anthropic: { type: "api_key", key: "test-anthropic-key" },
	});
	const modelRegistry = new ModelRegistry(authStorage, join(tempDir, "models.json"));
	const settingsManager = SettingsManager.inMemory();
	settingsManager.setDefaultModelAndProvider("anthropic", "claude-sonnet-4-6");
	settingsManager.setDefaultThinkingLevel("high");
	settingsManager.setAnthropicAdaptiveByDefault(true);
	const sessionManager = SessionManager.inMemory(tempDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir: tempDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});

	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		authStorage,
		modelRegistry,
		settingsManager,
		sessionManager,
		resourceLoader,
	});

	assert.equal(session.model?.provider, "anthropic");
	assert.equal(session.model?.id, "claude-sonnet-4-6");
	assert.equal(session.thinkingLevel, "adaptive");
	assert.equal(settingsManager.getDefaultThinkingLevel(), "high");
	session.dispose();
});

test("AgentSession switches supported Anthropic models to adaptive when the setting is enabled", async () => {
	const tempDir = join(
		process.cwd(),
		".tmp-tests",
		`sdk-anthropic-switch-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDir, { recursive: true });
	tempDirs.push(tempDir);

	const authStorage = AuthStorage.inMemory({
		anthropic: { type: "api_key", key: "test-anthropic-key" },
		openai: { type: "api_key", key: "test-openai-key" },
	});
	const modelRegistry = new ModelRegistry(authStorage, join(tempDir, "models.json"));
	const settingsManager = SettingsManager.inMemory();
	settingsManager.setDefaultModelAndProvider("openai", "gpt-5.4");
	settingsManager.setDefaultThinkingLevel("high");
	settingsManager.setClientAdaptiveByDefault(false);
	settingsManager.setAnthropicAdaptiveByDefault(true);
	const sessionManager = SessionManager.inMemory(tempDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir: tempDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});

	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		authStorage,
		modelRegistry,
		settingsManager,
		sessionManager,
		resourceLoader,
	});

	assert.equal(session.model?.provider, "openai");
	assert.equal(session.thinkingLevel, "high");

	const anthropicModel = modelRegistry.getAvailable().find((model) =>
		model.provider === "anthropic" && model.id === "claude-sonnet-4-6"
	);
	if (!anthropicModel) throw new Error("expected claude-sonnet-4-6 to be available");

	await session.setModel(anthropicModel);

	assert.equal(session.model?.provider, "anthropic");
	assert.equal(session.model?.id, "claude-sonnet-4-6");
	assert.equal(session.thinkingLevel, "adaptive");
	session.dispose();
});

test("createAgentSession defaults to adaptive for reasoning models when clientAdaptiveByDefault is enabled", async () => {
	const tempDir = join(
		process.cwd(),
		".tmp-tests",
		`sdk-client-adaptive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
	);
	mkdirSync(tempDir, { recursive: true });
	tempDirs.push(tempDir);

	const authStorage = AuthStorage.inMemory({
		openai: { type: "api_key", key: "test-openai-key" },
	});
	const modelRegistry = new ModelRegistry(authStorage, join(tempDir, "models.json"));
	const settingsManager = SettingsManager.inMemory();
	settingsManager.setDefaultModelAndProvider("openai", "gpt-5.4");
	settingsManager.setDefaultThinkingLevel("high");
	settingsManager.setClientAdaptiveByDefault(true);
	const sessionManager = SessionManager.inMemory(tempDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: tempDir,
		agentDir: tempDir,
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
	});

	const { session } = await createAgentSession({
		cwd: tempDir,
		agentDir: tempDir,
		authStorage,
		modelRegistry,
		settingsManager,
		sessionManager,
		resourceLoader,
	});

	assert.equal(session.model?.provider, "openai");
	assert.equal(session.model?.id, "gpt-5.4");
	assert.equal(session.thinkingLevel, "adaptive");
	session.dispose();
});
