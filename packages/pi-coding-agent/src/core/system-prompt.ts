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

	const hasEdit = tools.includes("edit");
	const hasWrite = tools.includes("write");
	const hasRead = tools.includes("read");
	const hasLsp = tools.includes("lsp");

	// Priority-ordered compact guidelines
	addGuideline("Be concise. Prefer short, direct answers over preamble.");
	addGuideline("For conceptual, product, or UX questions, answer first; inspect code only if implementation detail is needed.");

	const hasSubagent = tools.includes("subagent");

	if (hasLsp) {
		addGuideline(
			"Code navigation in typed codebases: use lsp first for symbols (definition, references, implementation, type info, hover, callers, diagnostics, rename, format). Do not use grep/find as a substitute for symbol navigation when LSP is available. Use grep/find/ls for raw text patterns, filenames, and non-code files. If LSP is unavailable or failing, say so briefly and then fall back to grep/read.",
		);
		addGuideline(
			"Before choosing a code navigation tool, classify intent: symbol lookup (definition/reference/implementation/type/caller/rename) → lsp; raw text or filename search → grep/find.",
		);
	} else {
		addGuideline("Use grep/find/ls for code search and file exploration (faster than bash, respects .gitignore)");
	}

	if (hasSubagent) {
		addGuideline(
			"Recon planning policy: use 0 scouts for narrow known-file work, 1 scout for one broad unfamiliar subsystem, and 2-4 parallel scouts only when the work spans multiple loosely-coupled subsystems.",
		);
		addGuideline(
			"For broad or unfamiliar codebase exploration, delegate reconnaissance to the scout subagent before reading many files yourself. After scout returns, use lsp and targeted reads for the narrowed file set.",
		);
		addGuideline(
			"Call the subagent tool directly. For one scout use { agent, task }. For several scouts use parallel mode with { tasks: [{ agent, task }, ...] }.",
		);
		addGuideline(
			"When the user names a subagent such as scout, worker, reviewer, or planner, invoke the subagent tool directly rather than the Skill tool or ad-hoc search.",
		);
		addGuideline(
			"Scout is for mapping and reconnaissance only — not for final review, audit, or ranked issue lists. Use it to identify relevant files, subsystems, and likely hotspots for later evaluation.",
		);
		addGuideline(
			"If reconnaissance spans multiple loosely-coupled areas, prefer multiple scout subagents in parallel, each covering one subsystem, instead of one model exploring everything itself.",
		);
		addGuideline(
			"For broad review or audit requests, use scout only as a prep step to map architecture and hotspots; the parent model or a reviewer should make the final judgments.",
		);
		addGuideline(
			"Skip scout only when the task is clearly narrow, the relevant file is already known, or the user explicitly asked for direct inspection of a specific file.",
		);
	}

	if (hasRead && hasEdit) {
		addGuideline("Read files before editing them. Never use cat or sed to inspect or modify files.");
	}

	if (hasEdit) {
		addGuideline("edit requires exact text match; write is for new files or full rewrites.");
	}

	if (hasWrite && !hasEdit) {
		addGuideline("write is for new files or full rewrites.");
	}

	if (hasLsp && hasEdit) {
		addGuideline("Run lsp diagnostics after edits to catch type errors.");
	}

	if (hasEdit || hasWrite) {
		addGuideline("Output plain text directly when summarizing your work — do not cat or echo to display what you did.");
	}

	addGuideline("Show file paths clearly when referencing files.");

	for (const guideline of promptGuidelines ?? []) {
		const normalized = guideline.trim();
		if (normalized.length > 0) {
			addGuideline(normalized);
		}
	}

	const guidelines = guidelinesList.map((g) => `- ${g}`).join("\n");
	const lspDecisionTable = hasLsp
		? `\n\nTool selection — code navigation quick map:\n\n| Intent | Use | Avoid |\n| --- | --- | --- |\n| Find where a symbol is defined | \`lsp definition\` | \`grep\` |\n| Find all usages of a symbol | \`lsp references\` | \`grep\` |\n| Find implementations of an interface/type | \`lsp implementation\` | \`grep\` |\n| Get type info/docs for a symbol | \`lsp hover\` | raw text search |\n| Find callers of a function | \`lsp incoming_calls\` | \`grep\` |\n| Search literal text patterns (TODO, logs, strings) | \`grep\` | \`lsp\` |\n| Search filenames/paths | \`find\` / \`ls\` | \`lsp\` |\n| Rename a symbol across codebase | \`lsp rename\` | find-and-replace |\n| Check type errors after edits | \`lsp diagnostics\` | ad-hoc grep |\n| Format a file | \`lsp format\` | external formatter guesswork |`
		: "";

	const piDocsBlock = existsSync(readmePath)
		? `\n\nPi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):
- Main documentation: ${readmePath}
- Additional docs: ${docsPath}
- Examples: ${examplesPath} (extensions, custom tools, SDK)
- When working on pi topics, read the docs and follow .md cross-references before implementing`
		: "";

	let prompt = `You are an expert coding assistant operating inside pi, a coding agent harness.

Available tools:
${toolsList}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelines}${lspDecisionTable}${piDocsBlock}`;

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
