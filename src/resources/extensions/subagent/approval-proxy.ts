import type { ChildProcess } from "node:child_process";

export type SubagentPermissionRequest =
	| {
			type: "approval_request";
			id: string;
			action: "write" | "edit" | "delete" | "move";
			path: string;
			message: string;
	  }
	| {
			type: "classifier_request";
			id: string;
			toolName: string;
			toolCallId: string;
			args: any;
	  };

export function isSubagentPermissionRequest(event: any): event is SubagentPermissionRequest {
	return Boolean(
		event &&
			typeof event.id === "string" &&
			((event.type === "approval_request" && typeof event.path === "string" && typeof event.message === "string") ||
				(event.type === "classifier_request" && typeof event.toolName === "string" && typeof event.toolCallId === "string")),
	);
}

export async function handleSubagentPermissionRequest(
	event: SubagentPermissionRequest,
	proc: Pick<ChildProcess, "stdin">,
	handlers: {
		requestFileChangeApproval: (request: {
			action: "write" | "edit" | "delete" | "move";
			path: string;
			message: string;
		}) => Promise<void>;
		requestClassifierDecision: (request: {
			toolName: string;
			toolCallId: string;
			args: any;
		}) => Promise<boolean>;
	},
): Promise<boolean> {
	if (event.type === "approval_request") {
		let approved = true;
		try {
			await handlers.requestFileChangeApproval({
				action: event.action,
				path: event.path,
				message: event.message,
			});
		} catch {
			approved = false;
		}
		if (proc.stdin && !proc.stdin.destroyed) {
			proc.stdin.write(JSON.stringify({ type: "approval_response", id: event.id, approved }) + "\n");
		}
		return true;
	}

	const approved = await handlers.requestClassifierDecision({
		toolName: event.toolName,
		toolCallId: event.toolCallId,
		args: event.args,
	});
	if (proc.stdin && !proc.stdin.destroyed) {
		proc.stdin.write(JSON.stringify({ type: "classifier_response", id: event.id, approved }) + "\n");
	}
	return true;
}
