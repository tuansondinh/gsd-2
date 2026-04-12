import { getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionCommandContext } from "@gsd/pi-coding-agent";

type FastCommandAction = "toggle" | "on" | "off" | "status" | "invalid";

function parseFastCommandAction(args: string): FastCommandAction {
	const normalized = args.trim().toLowerCase();
	if (!normalized) return "toggle";
	if (normalized === "on") return "on";
	if (normalized === "off") return "off";
	if (normalized === "status") return "status";
	return "invalid";
}

function supportsFastMode(model: ExtensionCommandContext["model"]): boolean {
	if (!model) return false;
	if (model.api === "openai-codex-responses") return true;
	if (model.api !== "openai-responses") return false;
	if (model.provider !== "openai") return false;
	return model.capabilities?.supportsServiceTier === true;
}

function getModelLabel(model: ExtensionCommandContext["model"]): string {
	if (!model) return "no active model";
	return `${model.provider}/${model.id}`;
}

function getSettingsManager(): SettingsManager {
	return SettingsManager.create(process.cwd(), getAgentDir());
}

export const __testing = {
	parseFastCommandAction,
	supportsFastMode,
};

export default function fastCommand(pi: ExtensionAPI) {
	pi.registerCommand("fast", {
		description: "Toggle fast mode for OpenAI/Codex models (service_tier=priority)",
		getArgumentCompletions(prefix: string) {
			const options = [
				{ value: "on", label: "on", description: "Enable fast mode" },
				{ value: "off", label: "off", description: "Disable fast mode" },
				{ value: "status", label: "status", description: "Show current fast-mode status" },
			];
			const query = prefix.trim().toLowerCase();
			return options.filter((item) => item.value.startsWith(query));
		},
		async handler(args: string, ctx: ExtensionCommandContext) {
			const settings = getSettingsManager() as SettingsManager & {
				getFastMode: () => boolean;
				setFastMode: (enabled: boolean) => void;
			};
			const current = settings.getFastMode();
			const action = parseFastCommandAction(args);
			const model = ctx.model;
			const supported = supportsFastMode(model);
			const modelLabel = getModelLabel(model);

			if (action === "invalid") {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}

			if (action === "status") {
				ctx.ui.notify(
					`Fast mode: ${current ? "ON" : "OFF"} · model ${modelLabel} is ${supported ? "supported" : "unsupported"}`,
					"info",
				);
				return;
			}

			const next = action === "toggle" ? !current : action === "on";
			settings.setFastMode(next);

			if (!supported) {
				ctx.ui.notify(
					`Fast mode: ${next ? "ON" : "OFF"} (saved). Current model ${modelLabel} does not support fast mode.`,
					"warning",
				);
				return;
			}

			ctx.ui.notify(
				`Fast mode: ${next ? "ON" : "OFF"} (saved). ${next ? "Requests will include service_tier=priority." : "Requests will omit service_tier."}`,
				"info",
			);
		},
	});
}
