import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
import type { AutocompleteItem } from "@gsd/pi-tui";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";

type GroupBy = "model" | "project" | "project-model";
type Scope = "all-projects" | "current-project";

function getSessionsRoot(): string {
	const appRoot = process.env.LSD_HOME || join(homedir(), ".lsd");
	return join(appRoot, "sessions");
}

function getCurrentProjectSessionsDir(cwd: string): string {
	const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(getSessionsRoot(), safePath);
}

const USAGE_ARGUMENTS: AutocompleteItem[] = [
	// Time ranges
	{ value: "today", label: "today", description: "Today's usage" },
	{ value: "month", label: "month", description: "This month's usage" },
	{ value: "this-month", label: "this-month", description: "This month's usage (alias)" },
	{ value: "last-month", label: "last-month", description: "Last month's usage" },
	{ value: "7d", label: "7d", description: "Last 7 days" },
	{ value: "30d", label: "30d", description: "Last 30 days" },
	{ value: "90d", label: "90d", description: "Last 90 days" },
	// Examples for specific months (recent past and current)
	...generateRecentMonths(),
	// Flags
	{ value: "--project-current", label: "--project-current", description: "Show only current project usage" },
	{ value: "--all-projects", label: "--all-projects", description: "Show all projects usage (default)" },
	{ value: "--by model", label: "--by model", description: "Group by model (default)" },
	{ value: "--by project", label: "--by project", description: "Group by project" },
	{ value: "--by project-model", label: "--by project-model", description: "Group by project and model" },
	{ value: "--json", label: "--json", description: "Output as JSON" },
];

function generateRecentMonths(): AutocompleteItem[] {
	const now = new Date();
	const items: AutocompleteItem[] = [];

	// Generate last 6 months including current
	for (let i = 0; i < 6; i++) {
		const date = new Date(now.getFullYear(), now.getMonth() - i, 1);
		const year = date.getFullYear();
		const month = (date.getMonth() + 1).toString().padStart(2, '0');
		const value = `${year}-${month}`;
		items.push({
			value,
			label: value,
			description: `${date.toLocaleString('default', { month: 'long' })} ${year}`,
		});
	}
	return items;
}

function filterArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const normalized = prefix.toLowerCase().replace(/\s+/g, " ").trimStart();
	const query = normalized.trimEnd();
	const filtered = USAGE_ARGUMENTS.filter((item) => item.value.startsWith(query));
	return filtered.length > 0 ? filtered : null;
}

type UsageRow = {
	key: string;
	project: string;
	model: string;
	messages: number;
	userPrompts: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
	totalDurationMs: number;
	totalOutputForSpeed: number;
};

type UsageReport = {
	label: string;
	scope: Scope;
	groupBy: GroupBy;
	sessionsRoot: string;
	filesScanned: number;
	matchedMessages: number;
	rows: UsageRow[];
	totals: Omit<UsageRow, "key" | "project" | "model">;
};

type ParsedArgs = {
	label: string;
	startMs: number;
	endMs: number;
	scope: Scope;
	groupBy: GroupBy;
	json: boolean;
};

type SessionHeaderLike = {
	type?: string;
	cwd?: string;
};

type AssistantMessageLike = {
	role?: string;
	provider?: string;
	model?: string;
	timestamp?: number;
	usage?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
	};
};

function startOfLocalDay(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function endOfLocalDay(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
}

function formatInt(value: number): string {
	return Math.round(value).toLocaleString();
}

function formatCost(value: number): string {
	return `$${value.toFixed(4)}`;
}

function startOfLocalMonth(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
}

function endOfLocalMonth(date: Date): number {
	return new Date(date.getFullYear(), date.getMonth() + 1, 1).getTime();
}

function parseRangeToken(token: string | undefined): { label: string; startMs: number; endMs: number } {
	const trimmed = token?.trim();
	if (!trimmed || trimmed === "today") {
		const now = new Date();
		return {
			label: "today",
			startMs: startOfLocalDay(now),
			endMs: endOfLocalDay(now),
		};
	}

	if (trimmed === "month" || trimmed === "this-month") {
		const now = new Date();
		return {
			label: "month",
			startMs: startOfLocalMonth(now),
			endMs: endOfLocalMonth(now),
		};
	}

	if (trimmed === "last-month") {
		const now = new Date();
		const lastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
		return {
			label: "last-month",
			startMs: startOfLocalMonth(lastMonth),
			endMs: endOfLocalMonth(lastMonth),
		};
	}

	const rollingMatch = trimmed.match(/^(\d+)d$/i);
	if (rollingMatch) {
		const days = Math.max(1, Number.parseInt(rollingMatch[1] ?? "1", 10));
		const now = new Date();
		return {
			label: `${days}d`,
			startMs: startOfLocalDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (days - 1))),
			endMs: endOfLocalDay(now),
		};
	}

	const monthMatch = trimmed.match(/^(\d{4})-(\d{1,2})$/);
	if (monthMatch) {
		const year = Number.parseInt(monthMatch[1] ?? "0", 10);
		const month = Number.parseInt(monthMatch[2] ?? "1", 10) - 1;
		const monthStart = new Date(year, month, 1);
		if (!Number.isNaN(monthStart.getTime())) {
			return {
				label: trimmed,
				startMs: startOfLocalMonth(monthStart),
				endMs: endOfLocalMonth(monthStart),
			};
		}
	}

	const dateMatch = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
	if (dateMatch) {
		const year = Number.parseInt(dateMatch[1] ?? "0", 10);
		const month = Number.parseInt(dateMatch[2] ?? "1", 10) - 1;
		const day = Number.parseInt(dateMatch[3] ?? "1", 10);
		const date = new Date(year, month, day);
		if (!Number.isNaN(date.getTime())) {
			return {
				label: trimmed,
				startMs: startOfLocalDay(date),
				endMs: endOfLocalDay(date),
			};
		}
	}

	throw new Error(`Invalid usage range "${trimmed}". Use: today, 7d, month, last-month, YYYY-MM, or YYYY-MM-DD.`);
}

function parseArgs(rawArgs: string): ParsedArgs {
	const tokens = rawArgs.trim().split(/\s+/).filter(Boolean);
	let rangeToken: string | undefined;
	let scope: Scope = "all-projects";
	let groupBy: GroupBy = "model";
	let json = false;

	for (let i = 0; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--project-current") {
			scope = "current-project";
			continue;
		}
		if (token === "--all-projects") {
			scope = "all-projects";
			continue;
		}
		if (token === "--json") {
			json = true;
			continue;
		}
		if (token === "--by") {
			const next = tokens[i + 1];
			if (next !== "model" && next !== "project" && next !== "project-model") {
				throw new Error('Invalid --by value. Use: model, project, or project-model.');
			}
			groupBy = next;
			i++;
			continue;
		}
		if (token.startsWith("--")) {
			throw new Error(`Unknown flag: ${token}`);
		}
		if (!rangeToken) {
			rangeToken = token;
			continue;
		}
		throw new Error(`Unexpected argument: ${token}`);
	}

	const range = parseRangeToken(rangeToken);
	return {
		...range,
		scope,
		groupBy,
		json,
	};
}

function walkJsonlFiles(dir: string): string[] {
	if (!existsSync(dir)) return [];
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...walkJsonlFiles(fullPath));
			continue;
		}
		if (entry.isFile() && fullPath.endsWith(".jsonl")) {
			out.push(fullPath);
		}
	}
	return out;
}

function normalizeProjectLabel(cwd: string | undefined, fallbackPath: string): string {
	if (cwd && cwd.trim()) return cwd;
	return basename(fallbackPath);
}

function makeModelLabel(message: AssistantMessageLike): string {
	if (message.provider && message.model) return `${message.provider}/${message.model}`;
	if (message.model) return message.model;
	return "unknown";
}

function makeGroupKey(groupBy: GroupBy, project: string, model: string): string {
	switch (groupBy) {
		case "project":
			return project;
		case "project-model":
			return `${project} :: ${model}`;
		case "model":
		default:
			return model;
	}
}

function collectUsage(sessionFiles: string[], startMs: number, endMs: number, scope: Scope, groupBy: GroupBy): UsageReport {
	const rows = new Map<string, UsageRow>();
	const userPromptRows = new Map<string, UsageRow>();
	let filesScanned = 0;
	let matchedMessages = 0;
	let matchedUserPrompts = 0;

	for (const file of sessionFiles) {
		filesScanned++;
		let projectLabel = basename(file);
		let headerResolved = false;
		let currentModel = "";
		let lastUserTimestamp = 0;

		const raw = readFileSync(file, "utf-8");
		for (const line of raw.split("\n")) {
			if (!line.trim()) continue;
			let parsed: any;
			try {
				parsed = JSON.parse(line);
			} catch {
				continue;
			}

			if (!headerResolved) {
				const header = parsed as SessionHeaderLike;
				if (header.type === "session") {
					projectLabel = normalizeProjectLabel(header.cwd, file);
					headerResolved = true;
				}
			}

			// Track model changes
			if (parsed?.type === "model_change" && parsed.provider && parsed.modelId) {
				currentModel = `${parsed.provider}/${parsed.modelId}`;
			}

			const message = parsed?.type === "message" ? (parsed.message as AssistantMessageLike | undefined) : undefined;
			if (!message) continue;

			if (message.role === "assistant") {
				const timestamp = Number(message.timestamp ?? 0);
				if (!timestamp || timestamp < startMs || timestamp >= endMs) continue;

				matchedMessages++;
				const model = message.provider && message.model ? `${message.provider}/${message.model}` : currentModel;
				const key = makeGroupKey(groupBy, projectLabel, model);
				const usage = message.usage ?? {};
				const input = Number(usage.input ?? 0);
				const output = Number(usage.output ?? 0);
				const cacheRead = Number(usage.cacheRead ?? 0);
				const cacheWrite = Number(usage.cacheWrite ?? 0);
				const cost = Number(usage.cost?.total ?? 0);
				const total = input + output + cacheRead + cacheWrite;

				const existing = rows.get(key) ?? {
					key,
					project: groupBy === "model" ? "—" : projectLabel,
					model: groupBy === "project" ? "—" : model,
					messages: 0,
					userPrompts: 0,
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
					cost: 0,
					totalDurationMs: 0,
					totalOutputForSpeed: 0,
				};

				existing.messages += 1;
				existing.input += input;
				existing.output += output;
				existing.cacheRead += cacheRead;
				existing.cacheWrite += cacheWrite;
				existing.total += total;
				existing.cost += cost;

				// Track tok/sec: use preceding user message timestamp
				if (output > 0 && lastUserTimestamp > 0) {
					const durationMs = timestamp - lastUserTimestamp;
					if (durationMs > 0) {
						existing.totalDurationMs += durationMs;
						existing.totalOutputForSpeed += output;
					}
				}

				rows.set(key, existing);
			} else if (message.role === "user") {
				const timestamp = Number(message.timestamp ?? 0);
				if (!timestamp) continue;

				// Always track last user timestamp for tok/sec calculation,
				// even if this user message is outside the time range
				// (the assistant response may still be within range).
				lastUserTimestamp = timestamp;

				if (timestamp < startMs || timestamp >= endMs) continue;

				matchedUserPrompts++;
				const model = currentModel;
				const key = makeGroupKey(groupBy, projectLabel, model);

				const existing = userPromptRows.get(key) ?? {
					key,
					project: groupBy === "model" ? "—" : projectLabel,
					model: groupBy === "project" ? "—" : model,
					messages: 0,
					userPrompts: 0,
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0,
					cost: 0,
					totalDurationMs: 0,
					totalOutputForSpeed: 0,
				};

				existing.userPrompts += 1;
				userPromptRows.set(key, existing);
			}
		}
	}

	// Merge user prompt counts into the main rows
	for (const [key, userRow] of userPromptRows.entries()) {
		const existing = rows.get(key);
		if (existing) {
			existing.userPrompts = userRow.userPrompts;
		} else {
			// User prompts without assistant responses (edge case)
			rows.set(key, userRow);
		}
	}

	const orderedRows = [...rows.values()].sort((left, right) => {
		if (right.total !== left.total) return right.total - left.total;
		return left.key.localeCompare(right.key);
	});

	const totals = orderedRows.reduce(
		(acc, row) => {
			acc.messages += row.messages;
			acc.userPrompts += row.userPrompts;
			acc.input += row.input;
			acc.output += row.output;
			acc.cacheRead += row.cacheRead;
			acc.cacheWrite += row.cacheWrite;
			acc.total += row.total;
			acc.cost += row.cost;
			acc.totalDurationMs += row.totalDurationMs;
			acc.totalOutputForSpeed += row.totalOutputForSpeed;
			return acc;
		},
		{ messages: 0, userPrompts: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0, totalDurationMs: 0, totalOutputForSpeed: 0 },
	);

	return {
		label: "",
		scope,
		groupBy,
		sessionsRoot: getSessionsRoot(),
		filesScanned,
		matchedMessages,
		rows: orderedRows,
		totals,
	};
}

function formatSpeed(totalDurationMs: number, totalOutputForSpeed: number): string {
	if (totalDurationMs <= 0) return "—";
	return Math.round(totalOutputForSpeed / (totalDurationMs / 1000)).toLocaleString();
}

function renderTable(report: UsageReport): string {
	const firstColumnHeader = report.groupBy === "project"
		? "project"
		: report.groupBy === "project-model"
			? "project :: model"
			: "model";

	const displayRows = report.rows.map((row) => ({
		label: row.key,
		userPrompts: String(row.userPrompts),
		msgs: String(row.messages),
		input: formatInt(row.input),
		output: formatInt(row.output),
		read: formatInt(row.cacheRead),
		write: formatInt(row.cacheWrite),
		total: formatInt(row.total),
		cost: formatCost(row.cost),
		speed: formatSpeed(row.totalDurationMs, row.totalOutputForSpeed),
	}));

	const totalsSpeed = formatSpeed(report.totals.totalDurationMs, report.totals.totalOutputForSpeed);

	const widths = {
		label: Math.max(firstColumnHeader.length, ...displayRows.map((row) => row.label.length), 5),
		userPrompts: Math.max(11, ...displayRows.map((row) => row.userPrompts.length), String(report.totals.userPrompts).length),
		msgs: Math.max(4, ...displayRows.map((row) => row.msgs.length), String(report.totals.messages).length),
		input: Math.max(5, ...displayRows.map((row) => row.input.length), formatInt(report.totals.input).length),
		output: Math.max(6, ...displayRows.map((row) => row.output.length), formatInt(report.totals.output).length),
		read: Math.max(4, ...displayRows.map((row) => row.read.length), formatInt(report.totals.cacheRead).length),
		write: Math.max(5, ...displayRows.map((row) => row.write.length), formatInt(report.totals.cacheWrite).length),
		total: Math.max(5, ...displayRows.map((row) => row.total.length), formatInt(report.totals.total).length),
		cost: Math.max(7, ...displayRows.map((row) => row.cost.length), formatCost(report.totals.cost).length),
		speed: Math.max(5, ...displayRows.map((row) => row.speed.length), totalsSpeed.length),
	};

	const header = [
		firstColumnHeader.padEnd(widths.label),
		"user prompts".padStart(widths.userPrompts),
		"msgs".padStart(widths.msgs),
		"input".padStart(widths.input),
		"output".padStart(widths.output),
		"read".padStart(widths.read),
		"write".padStart(widths.write),
		"total".padStart(widths.total),
		"cost".padStart(widths.cost),
		"tok/s".padStart(widths.speed),
	].join("  ");

	const divider = "-".repeat(header.length);
	const body = displayRows.map((row) => [
		row.label.padEnd(widths.label),
		row.userPrompts.padStart(widths.userPrompts),
		row.msgs.padStart(widths.msgs),
		row.input.padStart(widths.input),
		row.output.padStart(widths.output),
		row.read.padStart(widths.read),
		row.write.padStart(widths.write),
		row.total.padStart(widths.total),
		row.cost.padStart(widths.cost),
		row.speed.padStart(widths.speed),
	].join("  "));

	const totalsLine = [
		"TOTAL".padEnd(widths.label),
		String(report.totals.userPrompts).padStart(widths.userPrompts),
		String(report.totals.messages).padStart(widths.msgs),
		formatInt(report.totals.input).padStart(widths.input),
		formatInt(report.totals.output).padStart(widths.output),
		formatInt(report.totals.cacheRead).padStart(widths.read),
		formatInt(report.totals.cacheWrite).padStart(widths.write),
		formatInt(report.totals.total).padStart(widths.total),
		formatCost(report.totals.cost).padStart(widths.cost),
		totalsSpeed.padStart(widths.speed),
	].join("  ");

	return [header, divider, ...body, divider, totalsLine].join("\n");
}

function renderReport(report: UsageReport): string {
	const scopeLabel = report.scope === "all-projects" ? "all projects" : "current project";
	const summary = [
		`Usage report: ${report.label}`,
		`Scope: ${scopeLabel}`,
		`Grouped by: ${report.groupBy}`,
		`Sessions root: ${report.sessionsRoot}`,
		`Session files scanned: ${report.filesScanned}`,
		`User prompts: ${report.totals.userPrompts}`,
		`Assistant messages: ${report.matchedMessages}`,
	].join("\n");

	if (report.rows.length === 0) {
		return `${summary}\n\nNo assistant usage found for that range.`;
	}

	return `${summary}\n\n\
\`\`\`text\n${renderTable(report)}\n\`\`\``;
}

function buildUsageReport(ctx: ExtensionCommandContext, args: ParsedArgs): UsageReport {
	const sessionFiles = args.scope === "current-project"
		? walkJsonlFiles(getCurrentProjectSessionsDir(ctx.cwd))
		: walkJsonlFiles(getSessionsRoot());
	const report = collectUsage(sessionFiles, args.startMs, args.endMs, args.scope, args.groupBy);
	report.label = args.label;
	return report;
}

export default function usageExtension(pi: ExtensionAPI) {
	pi.registerCommand("usage", {
		description: "Show token and cost usage from LSD sessions (today by model by default)",
		getArgumentCompletions: filterArgumentCompletions,
		async handler(rawArgs: string, ctx: ExtensionCommandContext) {
			try {
				const parsed = parseArgs(rawArgs);
				const report = buildUsageReport(ctx, parsed);
				const content = parsed.json
					? `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\``
					: renderReport(report);

				pi.sendMessage({
					customType: "usage-report",
					content,
					display: true,
				});
			} catch (error) {
				const message = error instanceof Error ? error.message : "Unknown error";
				ctx.ui.notify(
					`${message}\nUsage: /usage [today|7d|month|last-month|YYYY-MM|YYYY-MM-DD] [--project-current|--all-projects] [--by model|project|project-model] [--json]`,
					"error",
				);
			}
		},
	});
}

export const __testing = {
	parseArgs,
	parseRangeToken,
	renderTable,
	collectUsage,
	filterArgumentCompletions,
};
