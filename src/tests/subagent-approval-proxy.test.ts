import assert from "node:assert/strict";
import test, { beforeEach, afterEach } from "node:test";

import {
	setFileChangeApprovalHandler,
	setClassifierHandler,
	getFileChangeApprovalHandler,
	getClassifierHandler,
} from "@gsd/pi-coding-agent";
import {
	handleSubagentPermissionRequest,
	isSubagentPermissionRequest,
} from "../resources/extensions/subagent/approval-proxy.ts";

function makeProc() {
	const writes: string[] = [];
	return {
		proc: {
			stdin: {
				destroyed: false,
				write: (chunk: string) => {
					writes.push(chunk);
					return true;
				},
			},
		},
		writes,
	};
}

// Store original handlers to restore after tests
let originalFileChangeHandler: ReturnType<typeof getFileChangeApprovalHandler>;
let originalClassifierHandler: ReturnType<typeof getClassifierHandler>;

beforeEach(() => {
	originalFileChangeHandler = getFileChangeApprovalHandler();
	originalClassifierHandler = getClassifierHandler();
});

afterEach(() => {
	setFileChangeApprovalHandler(originalFileChangeHandler);
	setClassifierHandler(originalClassifierHandler);
});

test("isSubagentPermissionRequest recognizes approval requests", () => {
	assert.equal(
		isSubagentPermissionRequest({
			type: "approval_request",
			id: "apr_1",
			action: "edit",
			path: "a.ts",
			message: "Edit file",
		}),
		true,
	);
});

test("isSubagentPermissionRequest recognizes classifier requests", () => {
	assert.equal(
		isSubagentPermissionRequest({
			type: "classifier_request",
			id: "cls_1",
			toolName: "bash",
			toolCallId: "tool_1",
			args: { command: "ls" },
		}),
		true,
	);
});

test("handleSubagentPermissionRequest forwards approval requests through the parent approval handler", async () => {
	const { proc, writes } = makeProc();
	const approvals: Array<{ action: string; path: string; message: string }> = [];

	setFileChangeApprovalHandler(async (request) => {
		approvals.push(request);
		return true;
	});

	await handleSubagentPermissionRequest(
		{ type: "approval_request", id: "apr_1", action: "edit", path: "a.ts", message: "Edit file" },
		proc as any,
	);

	assert.deepEqual(approvals, [{ action: "edit", path: "a.ts", message: "Edit file" }]);
	assert.deepEqual(JSON.parse(writes[0].trim()), {
		type: "approval_response",
		id: "apr_1",
		approved: true,
	});
});

test("handleSubagentPermissionRequest returns declined approval responses when parent approval rejects", async () => {
	const { proc, writes } = makeProc();

	setFileChangeApprovalHandler(async () => {
		throw new Error("declined");
	});

	await handleSubagentPermissionRequest(
		{ type: "approval_request", id: "apr_2", action: "write", path: "b.ts", message: "Write file" },
		proc as any,
	);

	assert.deepEqual(JSON.parse(writes[0].trim()), {
		type: "approval_response",
		id: "apr_2",
		approved: false,
	});
});

test("handleSubagentPermissionRequest denies approval requests by default when no handler configured", async () => {
	const { proc, writes } = makeProc();

	// No handler configured - should deny by default
	setFileChangeApprovalHandler(null);

	await handleSubagentPermissionRequest(
		{ type: "approval_request", id: "apr_3", action: "edit", path: "c.ts", message: "Edit file" },
		proc as any,
	);

	assert.deepEqual(JSON.parse(writes[0].trim()), {
		type: "approval_response",
		id: "apr_3",
		approved: false,
	});
});

test("handleSubagentPermissionRequest forwards classifier requests through the parent classifier handler", async () => {
	const { proc, writes } = makeProc();
	const classifierCalls: Array<{ toolName: string; toolCallId: string; args: any }> = [];

	setClassifierHandler(async (request) => {
		classifierCalls.push(request);
		return false;
	});

	await handleSubagentPermissionRequest(
		{ type: "classifier_request", id: "cls_1", toolName: "bash", toolCallId: "tool_1", args: { command: "ls" } },
		proc as any,
	);

	assert.deepEqual(classifierCalls, [{ toolName: "bash", toolCallId: "tool_1", args: { command: "ls" } }]);
	assert.deepEqual(JSON.parse(writes[0].trim()), {
		type: "classifier_response",
		id: "cls_1",
		approved: false,
	});
});

test("handleSubagentPermissionRequest denies classifier requests by default when no handler configured", async () => {
	const { proc, writes } = makeProc();

	// No classifier handler configured - should deny by default
	setClassifierHandler(null);

	await handleSubagentPermissionRequest(
		{ type: "classifier_request", id: "cls_2", toolName: "bash", toolCallId: "tool_2", args: { command: "rm -rf" } },
		proc as any,
	);

	assert.deepEqual(JSON.parse(writes[0].trim()), {
		type: "classifier_response",
		id: "cls_2",
		approved: false,
	});
});
