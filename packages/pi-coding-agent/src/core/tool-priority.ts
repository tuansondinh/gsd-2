export type ToolPriority = "always" | "on-error" | "collapse";

const ALWAYS_VISIBLE = new Set(["edit", "write", "subagent", "await_subagent"]);
const ON_ERROR = new Set(["bash", "bg_shell"]);

export function getToolPriority(toolName: string): ToolPriority {
	if (ALWAYS_VISIBLE.has(toolName)) return "always";
	if (ON_ERROR.has(toolName)) return "on-error";
	return "collapse";
}

export function shouldCollapse(toolName: string, isError: boolean): boolean {
	const priority = getToolPriority(toolName);
	if (priority === "always") return false;
	if (priority === "on-error") return !isError;
	return true;
}
