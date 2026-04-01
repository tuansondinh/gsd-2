import assert from "node:assert/strict";
import test from "node:test";

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

	await handleSubagentPermissionRequest(
		{ type: "approval_request", id: "apr_1", action: "edit", path: "a.ts", message: "Edit file" },
		proc as any,
		{
			requestFileChangeApproval: async (request) => {
				approvals.push(request);
			},
			requestClassifierDecision: async () => true,
		},
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

	await handleSubagentPermissionRequest(
		{ type: "approval_request", id: "apr_2", action: "write", path: "b.ts", message: "Write file" },
		proc as any,
		{
			requestFileChangeApproval: async () => {
				throw new Error("declined");
			},
			requestClassifierDecision: async () => true,
		},
	);

	assert.deepEqual(JSON.parse(writes[0].trim()), {
		type: "approval_response",
		id: "apr_2",
		approved: false,
	});
});

test("handleSubagentPermissionRequest forwards classifier requests through the parent classifier handler", async () => {
	const { proc, writes } = makeProc();
	const classifierCalls: Array<{ toolName: string; toolCallId: string; args: any }> = [];

	await handleSubagentPermissionRequest(
		{ type: "classifier_request", id: "cls_1", toolName: "bash", toolCallId: "tool_1", args: { command: "ls" } },
		proc as any,
		{
			requestFileChangeApproval: async () => {},
			requestClassifierDecision: async (request) => {
				classifierCalls.push(request);
				return false;
			},
		},
	);

	assert.deepEqual(classifierCalls, [{ toolName: "bash", toolCallId: "tool_1", args: { command: "ls" } }]);
	assert.deepEqual(JSON.parse(writes[0].trim()), {
		type: "classifier_response",
		id: "cls_1",
		approved: false,
	});
});
