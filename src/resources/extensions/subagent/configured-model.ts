import type { AgentConfig } from "./agents.js";
import type { SharedPreferences } from "../shared/preferences.js";

export function resolveConfiguredSubagentModel(
	agent: AgentConfig,
	preferences?: SharedPreferences,
	settingsBudgetModel?: string,
): string | undefined {
	const configuredModel = agent.model?.trim();
	if (!configuredModel) return undefined;
	if (configuredModel === "$budget_model") {
		return settingsBudgetModel?.trim() || preferences?.subagent?.budget_model?.trim() || undefined;
	}
	return configuredModel;
}
