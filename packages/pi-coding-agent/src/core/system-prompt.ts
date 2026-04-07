/**
 * System prompt construction and project context loading
 */

import { existsSync } from "node:fs";
import { getDocsPath, getExamplesPath, getReadmePath } from "../config.js";
import { toPosixPath } from "../utils/path-display.js";
import { formatSkillsForPrompt, type Skill } from "./skills.js";

/** Tool descriptions for system prompt */
const toolDescriptions: Record<string, string> = {
	read: "Read file contents",
	bash: "Execute bash commands (ls, grep, find, etc.)",
	edit: "Make surgical edits to files (find exact text and replace)",
	write: "Create or overwrite files",
	grep: "Search file contents for patterns (respects .gitignore). For symbol definitions, references, type info, or callers in code, use lsp instead",
	find: "Find files by glob pattern (respects .gitignore)",
	ls: "List directory contents",
	lsp: "Code intelligence via Language Server Protocol (go-to-definition, references, diagnostics, hover, rename, symbols)",
};

export interface BuildSystemPromptOptions {
	/**
	 * Custom system prompt that replaces the default role header, tool list,
	 * and guidelines entirely. You are responsible for providing your own
	 * tool-usage guidance. Project context, skills, extension promptGuidelines,
	 * date/cwd, and appendSystemPrompt are still applied on top.
	 */
	customPrompt?: string;
	/** Tools to include in prompt. Default: [read, bash, edit, write] */
	selectedTools?: string[];
	/** Optional one-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Additional guideline bullets appended to the default system prompt guidelines. */
	promptGuidelines?: string[];
	/** Text to append to system prompt. */
	appendSystemPrompt?: string;
	/** Working directory. Default: process.cwd() */
	cwd?: string;
	/** Pre-loaded context files. */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Build the system prompt with tools, guidelines, and context */
export function buildSystemPrompt(options: BuildSystemPromptOptions = {}): string {
	const {
		customPrompt,
		selectedTools,
		toolSnippets,
		promptGuidelines,
		appendSystemPrompt,
		cwd,
		contextFiles: providedContextFiles,
		skills: providedSkills,
	} = options;
	const resolvedCwd = toPosixPath(cwd ?? process.cwd());

	const now = new Date();
	const dateTime = now.toLocaleString("en-US", {
		weekday: "long",
		year: "numeric",
		month: "long",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		timeZoneName: "short",
	});

	const appendSection = appendSystemPrompt ? `\n\n${appendSystemPrompt}` : "";

	const contextFiles = providedContextFiles ?? [];
	const skills = providedSkills ?? [];

	if (customPrompt) {
		let prompt = customPrompt;

		if (appendSection) {
			prompt += appendSection;
		}

		// Append project context files
		if (contextFiles.length > 0) {
			prompt += "\n\n# Project Context\n\n";
			prompt += "Project-specific instructions and guidelines:\n\n";
			for (const { path: filePath, content } of contextFiles) {
				prompt += `## ${filePath}\n\n${content}\n\n`;
			}
		}

		// Append skills section (if read or Skill tool is available)
		const customPromptHasSkillAccess = !selectedTools || selectedTools.includes("read") || selectedTools.includes("Skill");
		if (customPromptHasSkillAccess && skills.length > 0) {
			prompt += formatSkillsForPrompt(skills);
		}

		// Append promptGuidelines from extension-registered tools.
		// Without this, tools registered via pi.registerTool() with promptGuidelines
		// have their definitions reach the API but the model has no guidance on when
		// to use them (#1184).
		if (promptGuidelines && promptGuidelines.length > 0) {
			prompt += "\n\n";
			for (const guideline of promptGuidelines) {
				prompt += guideline + "\n";
			}
		}

		// Add date/time and working directory last
		prompt += `\nCurrent date and time: ${dateTime}`;
		prompt += `\nCurrent working directory: ${resolvedCwd}`;

		return prompt;
	}

	// Get absolute paths to documentation and examples
	const readmePath = getReadmePath();
	const docsPath = getDocsPath();
	const examplesPath = getExamplesPath();

	// Build tools list based on selected tools.
	// Built-ins use toolDescriptions. Custom tools can provide one-line snippets.
	const tools = selectedTools || ["read", "bash", "edit", "write"];
	const toolsList =
		tools.length > 0
			? tools
					.map((name) => {
						const snippet = toolSnippets?.[name] ?? toolDescriptions[name] ?? name;
						return `- ${name}: ${snippet}`;
					})
					.join("\n")
			: "(none)";

	// Build guidelines based on which tools are actually available
	const guidelinesList: string[] = [];
	const guidelinesSet = new Set<string>();
	const addGuideline = (guideline: string): void => {
		if (guidelinesSet.has(guideline)) {
			return;
		}
		guidelinesSet.add(guideline);
		guidelinesList.push(guideline);
	};

	const hasBash = tools.includes("bash");
	const hasEdit = tools.includes("edit");
	const hasWrite = tools.includes("write");
	const hasGrep = tools.includes("grep");
	const hasFind = tools.includes("find");
	const hasLs = tools.includes("ls");
	const hasRead = tools.includes("read");
	const hasLsp = tools.includes("lsp");

	// LSP guideline — must come FIRST so it outranks grep/bash in the model's priority
	if (hasLsp) {
		addGuideline(
			`Use lsp as the primary tool for code navigation in typed codebases:
- Navigation: definition, type_definition, implementation, references, incoming_calls, outgoing_calls
- Understanding: hover (types + docs), signature (parameter info), symbols (file/workspace search)
- Refactoring: rename (project-wide), code_actions (quick-fixes, imports, refactors), format (formatter)
- Verification: diagnostics after edits to catch type errors immediately
- Before choosing a code-navigation tool, classify your intent: symbol lookup (definition, references, type info, callers, rename, formatting, diagnostics) or text search. Symbols → lsp. Text patterns / non-code files → grep/find/ls
- Tool selection — code navigation:
  • Find where a symbol is defined → lsp definition (not grep)
  • Find all usages of a symbol → lsp references (not grep)
  • Find implementations of an interface or method → lsp implementation (not grep)
  • Get type info or docs for a symbol → lsp hover/signature (not reading source first)
  • Find all callers of a function → lsp incoming_calls (not grep)
  • Search for a text pattern, TODO, log message, or non-code content → grep
  • Search for filenames or directory structure → find/ls
  • Rename a symbol across the codebase → lsp rename (not find-and-replace)
  • Check typed errors after edits → lsp diagnostics (not manual scans)
  • Format a file → lsp format when available (not shelling out)
- When lsp is available, ALWAYS prefer it over grep/bash/find for: finding definitions, finding references, getting type info, renaming symbols, listing symbols in a file or workspace, checking diagnostics/errors, and formatting
- Never grep for a symbol definition when lsp can resolve it semantically
- Never shell out to a formatter when lsp format is available`,
		);
	}

	// If the request is primarily conceptual or product/design oriented, answer the design or strategy question first and inspect the codebase only after confirming implementation detail is needed.
	addGuideline(
		"If the request is primarily conceptual, product, or UX/design oriented, answer the question first with concise recommendations and inspect the codebase only after confirming implementation detail is needed",
	);

	// Use subagents for broad reconnaissance before spending expensive-model tokens on discovery
	if (tools.includes("subagent")) {
		addGuideline(
			"Use a scout subagent for broad repo reconnaissance when file ownership or architecture is unclear; keep the scout read-only, use a cheaper model when available, and ask it to return a high-signal handoff with exact files/symbols to inspect next",
		);
	}

	addGuideline(
		"Do not deep-dive backend schemas, migrations, or infrastructure for a conceptual/product request until you confirm that implementation constraints actually matter",
	);

	// File exploration guidelines (only for tasks lsp cannot do: raw text search, non-code files, etc.)
	if (hasBash && !hasGrep && !hasFind && !hasLs) {
		addGuideline("Use bash for file operations like ls, rg, find");
	} else if (hasBash && (hasGrep || hasFind || hasLs)) {
		if (hasLsp) {
			addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore) — but prefer lsp over grep/find when navigating typed code");
		} else {
			addGuideline("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
		}
	}

	// Read before edit guideline
	if (hasRead && hasEdit) {
		addGuideline("Use read to examine files before editing. You must use this tool instead of cat or sed.");
	}

	// Edit guideline
	if (hasEdit) {
		addGuideline("Use edit for precise changes (old text must match exactly)");
	}

	// Write guideline
	if (hasWrite) {
		addGuideline("Use write only for new files or complete rewrites");
	}

	// Output guideline (only when actually writing or executing)
	if (hasEdit || hasWrite) {
		addGuideline(
			"When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did",
		);
	}

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	// Always include these
	addGuideline("Be concise in your responses");
	addGuideline("Show file paths clearly when working with files");

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");

	const piDocsBlock = existsSync(readmePath)
		? `\n\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When working on pi topics, read the docs and follow .md cross-references before implementing`
		: "";

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}${piDocsBlock}`;

	if (appendSection) {
		prompt += appendSection;
	}

	// Append project context files
	if (contextFiles.length > 0) {
		prompt += "\n\n# Project Context\n\n";
		prompt += "Project-specific instructions and guidelines:\n\n";
		for (const { path: filePath, content } of contextFiles) {
			prompt += `## ${filePath}\n\n${content}\n\n`;
		}
	}

	// Append skills section (if read or Skill tool is available)
	const hasSkill = tools.includes("Skill");
	if ((hasRead || hasSkill) && skills.length > 0) {
		prompt += formatSkillsForPrompt(skills);
	}

	// Add date/time and working directory last
	prompt += `\nCurrent date and time: ${dateTime}`;
	prompt += `\nCurrent working directory: ${resolvedCwd}`;

	return prompt;
}
