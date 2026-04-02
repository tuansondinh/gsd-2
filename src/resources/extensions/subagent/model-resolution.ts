export interface ResolvedSubagentAgent {
	name: string;
	model?: string;
}

export interface ResolveSubagentModelOptions {
	overrideModel?: string;
	parentModel?: { provider: string; id: string };
}

const BARE_MODEL_PROVIDER_RULES: Array<{ provider: string; matches: (modelId: string) => boolean }> = [
	{ provider: "anthropic", matches: (modelId) => modelId.startsWith("claude-") },
	{ provider: "google", matches: (modelId) => modelId.startsWith("gemini-") },
	{
		provider: "openai",
		matches: (modelId) => /^(gpt-|o[134]-|omni-|text-embedding-)/.test(modelId),
	},
	{ provider: "xai", matches: (modelId) => modelId.startsWith("grok-") },
	{
		provider: "mistral",
		matches: (modelId) => /^(mistral-|ministral-|codestral-)/.test(modelId),
	},
	{ provider: "groq", matches: (modelId) => modelId.startsWith("llama-") || modelId.startsWith("mixtral-") },
];

export function inferProviderForBareModel(modelId: string): string | undefined {
	const normalizedModelId = modelId.trim().toLowerCase();
	if (!normalizedModelId) return undefined;
	return BARE_MODEL_PROVIDER_RULES.find((rule) => rule.matches(normalizedModelId))?.provider;
}

export function isQualifiedSubagentModel(model: string): boolean {
	const trimmed = model.trim();
	if (!trimmed || trimmed.includes(" ")) return false;
	const parts = trimmed.split("/");
	return parts.length === 2 && parts.every(Boolean);
}

export function normalizeSubagentModel(model: string | undefined | null): string | undefined {
	const trimmed = model?.trim();
	if (!trimmed || trimmed.startsWith("$")) return undefined;
	if (isQualifiedSubagentModel(trimmed)) return trimmed;
	if (trimmed.includes("/")) return undefined;
	const inferredProvider = inferProviderForBareModel(trimmed);
	return inferredProvider ? `${inferredProvider}/${trimmed}` : undefined;
}

export function resolveSubagentModel(
	agent: ResolvedSubagentAgent,
	options: ResolveSubagentModelOptions = {},
): string | undefined {
	const overrideModel = normalizeSubagentModel(options.overrideModel);
	if (overrideModel) return overrideModel;

	const agentModel = normalizeSubagentModel(agent.model);
	if (agentModel) return agentModel;

	if (options.parentModel?.provider && options.parentModel?.id) {
		return normalizeSubagentModel(`${options.parentModel.provider}/${options.parentModel.id}`);
	}

	return undefined;
}
