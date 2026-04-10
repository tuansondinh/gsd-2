/**
 * Cross-platform path display tests.
 *
 * Verifies that toPosixPath correctly normalizes Windows paths and that
 * the system prompt builder produces forward-slash paths for LLM consumption.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { toPosixPath } from "../utils/path-display.js";
import { buildSystemPrompt } from "../core/system-prompt.js";
import { createGrepTool } from "../core/tools/grep.js";

// ─── toPosixPath ────────────────────────────────────────────────────────────

test("toPosixPath: converts Windows backslash paths to forward slashes", () => {
	assert.equal(toPosixPath("C:\\Users\\name\\project"), "C:/Users/name/project");
});

test("toPosixPath: handles mixed separators", () => {
	assert.equal(toPosixPath("C:\\Users/name\\project/src"), "C:/Users/name/project/src");
});

test("toPosixPath: no-op for Unix paths", () => {
	assert.equal(toPosixPath("/home/user/project"), "/home/user/project");
});

test("toPosixPath: handles empty string", () => {
	assert.equal(toPosixPath(""), "");
});

test("toPosixPath: handles Windows UNC paths", () => {
	assert.equal(toPosixPath("\\\\server\\share\\dir"), "//server/share/dir");
});

test("toPosixPath: handles .gsd/worktrees path on Windows", () => {
	assert.equal(
		toPosixPath("C:\\Users\\name\\project\\.gsd\\worktrees\\M001"),
		"C:/Users/name/project/.gsd/worktrees/M001",
	);
});

// ─── System prompt path normalization ───────────────────────────────────────

test("buildSystemPrompt: cwd uses forward slashes even with Windows input", () => {
	const prompt = buildSystemPrompt({
		cwd: "C:\\Users\\name\\development\\app-name",
	});
	assert.ok(
		prompt.includes("C:/Users/name/development/app-name"),
		"System prompt should contain forward-slash path",
	);
	assert.ok(
		!prompt.includes("C:\\Users\\name\\development\\app-name"),
		"System prompt must NOT contain backslash path",
	);
});

test("buildSystemPrompt: Unix paths pass through unchanged", () => {
	const prompt = buildSystemPrompt({
		cwd: "/home/user/project",
	});
	assert.ok(prompt.includes("/home/user/project"));
});

test("buildSystemPrompt: encourages scout-first reconnaissance when subagent is available", () => {
	const prompt = buildSystemPrompt({
		cwd: "/home/user/project",
		selectedTools: ["read", "lsp", "subagent", "edit", "write"],
	});
	assert.match(prompt, /delegate reconnaissance to the scout subagent/i);
	assert.match(prompt, /0 scouts for narrow known-file work, 1 scout for one broad unfamiliar subsystem/i);
	assert.match(prompt, /For one scout use \{ agent, task \}/i);
	assert.match(prompt, /Scout is for mapping and reconnaissance only/i);
	assert.match(prompt, /multiple scout subagents in parallel/i);
	assert.match(prompt, /broad review or audit requests, use scout only as a prep step/i);
	assert.match(prompt, /Skip scout only when the task is clearly narrow/i);
	assert.match(prompt, /When the user names a subagent such as scout, worker, reviewer, or planner, invoke the subagent tool directly/i);
});

test("buildSystemPrompt: prefers lsp over grep for typed code navigation when available", () => {
	const prompt = buildSystemPrompt({
		cwd: "/home/user/project",
		selectedTools: ["read", "grep", "find", "ls", "lsp"],
	});
	assert.match(prompt, /use lsp first for symbols/i);
	assert.match(prompt, /Do not use grep\/find as a substitute for symbol navigation when LSP is available/i);
	assert.match(prompt, /If LSP is unavailable or failing, say so briefly and then fall back to grep\/read/i);
});

test("createGrepTool: description steers semantic code navigation to lsp", () => {
	const tool = createGrepTool(process.cwd());
	assert.match(tool.description, /Use this for raw text search, not semantic code navigation/i);
	assert.match(tool.description, /use the `lsp` tool instead when available/i);
});

// ─── Regression: no backslash paths in LLM-visible text ────────────────────

/**
 * Pattern that matches Windows-style absolute paths with backslashes.
 * Catches: C:\Users\..., D:\Projects\..., \\server\share\...
 * Does not match: escaped chars in regex, JSON strings, etc.
 */
const WINDOWS_ABS_PATH_RE = /[A-Z]:\\[A-Za-z]/;

test("buildSystemPrompt: no Windows absolute paths with backslashes in output", () => {
	// Simulate a Windows-like cwd
	const prompt = buildSystemPrompt({
		cwd: "D:\\Projects\\my-app\\.gsd\\worktrees\\M002",
	});
	const lines = prompt.split("\n");
	const violations = lines.filter(line => WINDOWS_ABS_PATH_RE.test(line));
	assert.equal(
		violations.length, 0,
		`System prompt contains Windows backslash paths:\n${violations.join("\n")}`,
	);
});
