export type PermissionMode = "danger-full-access" | "accept-on-edit" | "auto" | "plan";

export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "lsp", "hashline_read", "pty_read", "pty_wait"]);
export const MUTATING_TOOLS = new Set(["bash", "edit", "write", "hashline_edit", "pty_start", "pty_send", "pty_resize", "pty_kill"]);

export interface FileChangeApprovalRequest {
	action: "write" | "edit" | "delete" | "move";
	path: string;
	message: string;
}

export interface ClassifierRequest {
	toolName: string;
	toolCallId: string;
	args: any;
}

type FileChangeApprovalHandler = (request: FileChangeApprovalRequest) => Promise<boolean>;
type ClassifierHandler = (request: ClassifierRequest) => Promise<boolean>;
export type NetworkApprovalDecision = "allow-once" | "allow-session" | "deny";

export interface NetworkApprovalRequest {
	command: string;
	message: string;
}

type NetworkApprovalHandler = (request: NetworkApprovalRequest) => Promise<NetworkApprovalDecision>;

let fileChangeApprovalHandler: FileChangeApprovalHandler | null = null;
let classifierHandler: ClassifierHandler | null = null;
let networkApprovalHandler: NetworkApprovalHandler | null = null;

let subagentApprovalRouter: ((proxyId: string, approved: boolean) => boolean) | null = null;
let subagentClassifierRouter: ((proxyId: string, approved: boolean) => boolean) | null = null;

export function setSubagentApprovalRouter(router: ((proxyId: string, approved: boolean) => boolean) | null): void {
	subagentApprovalRouter = router;
}

export function setSubagentClassifierRouter(router: ((proxyId: string, approved: boolean) => boolean) | null): void {
	subagentClassifierRouter = router;
}

const pendingApprovals = new Map<string, { resolve: (approved: boolean) => void }>();
const pendingClassifications = new Map<string, { resolve: (approved: boolean) => void }>();

let approvalIdCounter = 0;
let classifierIdCounter = 0;

let permissionModeOverride: PermissionMode | null = null;

export function setPermissionMode(mode: PermissionMode): void {
	permissionModeOverride = mode;
}

export function getPermissionMode(): PermissionMode {
	if (permissionModeOverride !== null) return permissionModeOverride;
	const mode = process.env.LUCENT_CODE_PERMISSION_MODE;
	if (mode === "accept-on-edit") return "accept-on-edit";
	if (mode === "auto") return "auto";
	if (mode === "plan") return "plan";
	if (mode === "danger-full-access") return "danger-full-access";
	return "accept-on-edit";
}

export function setFileChangeApprovalHandler(handler: FileChangeApprovalHandler | null): void {
	fileChangeApprovalHandler = handler;
}

export function getFileChangeApprovalHandler(): FileChangeApprovalHandler | null {
	return fileChangeApprovalHandler;
}

export function setClassifierHandler(handler: ClassifierHandler | null): void {
	classifierHandler = handler;
}

export function getClassifierHandler(): ClassifierHandler | null {
	return classifierHandler;
}

export function setNetworkApprovalHandler(handler: NetworkApprovalHandler | null): void {
	networkApprovalHandler = handler;
}

export function registerStdioApprovalHandler(): void {
	setFileChangeApprovalHandler(async (request: FileChangeApprovalRequest): Promise<boolean> => {
		const id = `apr_${++approvalIdCounter}_${Date.now()}`;

		return new Promise<boolean>((resolve) => {
			pendingApprovals.set(id, { resolve });

			const msg = JSON.stringify({
				type: "approval_request",
				id,
				action: request.action,
				path: request.path,
				message: request.message,
			});
			process.stdout.write(msg + "\n");
		});
	});
}

export function registerStdioClassifierHandler(): void {
	setClassifierHandler(async (request: ClassifierRequest): Promise<boolean> => {
		const id = `cls_${++classifierIdCounter}_${Date.now()}`;

		return new Promise<boolean>((resolve) => {
			pendingClassifications.set(id, { resolve });

			const msg = JSON.stringify({
				type: "classifier_request",
				id,
				toolName: request.toolName,
				toolCallId: request.toolCallId,
				args: request.args,
			});
			process.stdout.write(msg + "\n");
		});
	});
}

export function resolveApprovalResponse(id: string, approved: boolean): void {
	if (subagentApprovalRouter && subagentApprovalRouter(id, approved)) return;
	const pending = pendingApprovals.get(id);
	if (pending) {
		pendingApprovals.delete(id);
		pending.resolve(approved);
	}
}

export function resolveClassifierResponse(id: string, approved: boolean): void {
	if (subagentClassifierRouter && subagentClassifierRouter(id, approved)) return;
	const pending = pendingClassifications.get(id);
	if (pending) {
		pendingClassifications.delete(id);
		pending.resolve(approved);
	}
}

export async function requestFileChangeApproval(request: FileChangeApprovalRequest): Promise<void> {
	if (getPermissionMode() !== "accept-on-edit") {
		return;
	}

	if (!fileChangeApprovalHandler) {
		throw new Error(`Approval required before ${request.action} on ${request.path}, but no approval handler is configured.`);
	}

	const approved = await fileChangeApprovalHandler(request);
	if (!approved) {
		throw new Error(`User declined ${request.action} for ${request.path}.`);
	}
}

export async function requestNetworkApproval(request: NetworkApprovalRequest): Promise<NetworkApprovalDecision> {
	if (!networkApprovalHandler) {
		return "deny";
	}
	return await networkApprovalHandler(request);
}

export async function requestClassifierDecision(request: ClassifierRequest): Promise<boolean> {
	if (getPermissionMode() !== "auto") {
		return true;
	}

	if (!classifierHandler) {
		return false;
	}

	return await classifierHandler(request);
}
