export const READ_ONLY_TOOLS = new Set(["read", "grep", "find", "ls", "lsp", "hashline_read"]);
export const MUTATING_TOOLS = new Set(["bash", "edit", "write", "hashline_edit"]);
let fileChangeApprovalHandler = null;
let classifierHandler = null;
let subagentApprovalRouter = null;
let subagentClassifierRouter = null;
export function setSubagentApprovalRouter(router) {
    subagentApprovalRouter = router;
}
export function setSubagentClassifierRouter(router) {
    subagentClassifierRouter = router;
}
const pendingApprovals = new Map();
const pendingClassifications = new Map();
let approvalIdCounter = 0;
let classifierIdCounter = 0;
let permissionModeOverride = null;
export function setPermissionMode(mode) {
    permissionModeOverride = mode;
}
export function getPermissionMode() {
    if (permissionModeOverride !== null)
        return permissionModeOverride;
    const mode = process.env.LUCENT_CODE_PERMISSION_MODE;
    if (mode === "accept-on-edit")
        return "accept-on-edit";
    if (mode === "auto")
        return "auto";
    if (mode === "plan")
        return "plan";
    if (mode === "danger-full-access")
        return "danger-full-access";
    return "accept-on-edit";
}
export function setFileChangeApprovalHandler(handler) {
    fileChangeApprovalHandler = handler;
}
export function setClassifierHandler(handler) {
    classifierHandler = handler;
}
export function registerStdioApprovalHandler() {
    setFileChangeApprovalHandler(async (request) => {
        const id = `apr_${++approvalIdCounter}_${Date.now()}`;
        return new Promise((resolve) => {
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
export function registerStdioClassifierHandler() {
    setClassifierHandler(async (request) => {
        const id = `cls_${++classifierIdCounter}_${Date.now()}`;
        return new Promise((resolve) => {
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
export function resolveApprovalResponse(id, approved) {
    if (subagentApprovalRouter && subagentApprovalRouter(id, approved))
        return;
    const pending = pendingApprovals.get(id);
    if (pending) {
        pendingApprovals.delete(id);
        pending.resolve(approved);
    }
}
export function resolveClassifierResponse(id, approved) {
    if (subagentClassifierRouter && subagentClassifierRouter(id, approved))
        return;
    const pending = pendingClassifications.get(id);
    if (pending) {
        pendingClassifications.delete(id);
        pending.resolve(approved);
    }
}
export async function requestFileChangeApproval(request) {
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
export async function requestClassifierDecision(request) {
    if (getPermissionMode() !== "auto") {
        return true;
    }
    if (!classifierHandler) {
        return false;
    }
    return await classifierHandler(request);
}
