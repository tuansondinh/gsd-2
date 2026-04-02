import type { ExtensionAPI } from "@gsd/pi-coding-agent";
import auditCommand from "./audit.js";
import clearCommand from "./clear.js";
import planCommand from "./plan.js";

export default function slashCommands(pi: ExtensionAPI) {
	auditCommand(pi);
	clearCommand(pi);
	planCommand(pi);
}
