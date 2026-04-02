import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";
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

type UsageRow = {
	key: string;
	project: string;
	model: string;
	messages: number;
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	cost: number;
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

	throw new Error(`Invalid usage range "${trimmed}". Use: today, 7d, or YYYY-MM-DD.`);
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
	let filesScanned = 0;
	let matchedMessages = 0;

	for (const file of sessionFiles) {
		filesScanned++;
		let projectLabel = basename(file);
		let headerResolved = false;

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

			const message = parsed?.type === "message" ? (parsed.message as AssistantMessageLike | undefined) : undefined;
			if (!message || message.role !== "assistant") continue;

			const timestamp = Number(message.timestamp ?? 0);
			if (!timestamp || timestamp < startMs || timestamp >= endMs) continue;

			matchedMessages++;
			const model = makeModelLabel(message);
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
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				total: 0,
				cost: 0,
			};

			existing.messages += 1;
			existing.input += input;
			existing.output += output;
			existing.cacheRead += cacheRead;
			existing.cacheWrite += cacheWrite;
			existing.total += total;
			existing.cost += cost;
			rows.set(key, existing);
		}
	}

	const orderedRows = [...rows.values()].sort((left, right) => {
		if (right.total !== left.total) return right.total - left.total;
		return left.key.localeCompare(right.key);
	});

	const totals = orderedRows.reduce(
		(acc, row) => {
			acc.messages += row.messages;
			acc.input += row.input;
			acc.output += row.output;
			acc.cacheRead += row.cacheRead;
			acc.cacheWrite += row.cacheWrite;
			acc.total += row.total;
			acc.cost += row.cost;
			return acc;
		},
		{ messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0, cost: 0 },
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

function renderTable(report: UsageReport): string {
	const firstColumnHeader = report.groupBy === "project"
		? "project"
		: report.groupBy === "project-model"
			? "project :: model"
			: "model";

	const displayRows = report.rows.map((row) => ({
		label: row.key,
		msgs: String(row.messages),
		input: formatInt(row.input),
		output: formatInt(row.output),
		read: formatInt(row.cacheRead),
		write: formatInt(row.cacheWrite),
		total: formatInt(row.total),
		cost: formatCost(row.cost),
	}));

	const widths = {
		label: Math.max(firstColumnHeader.length, ...displayRows.map((row) => row.label.length), 5),
		msgs: Math.max(4, ...displayRows.map((row) => row.msgs.length), String(report.totals.messages).length),
		input: Math.max(5, ...displayRows.map((row) => row.input.length), formatInt(report.totals.input).length),
		output: Math.max(6, ...displayRows.map((row) => row.output.length), formatInt(report.totals.output).length),
		read: Math.max(4, ...displayRows.map((row) => row.read.length), formatInt(report.totals.cacheRead).length),
		write: Math.max(5, ...displayRows.map((row) => row.write.length), formatInt(report.totals.cacheWrite).length),
		total: Math.max(5, ...displayRows.map((row) => row.total.length), formatInt(report.totals.total).length),
		cost: Math.max(7, ...displayRows.map((row) => row.cost.length), formatCost(report.totals.cost).length),
	};

	const header = [
		firstColumnHeader.padEnd(widths.label),
		"msgs".padStart(widths.msgs),
		"input".padStart(widths.input),
		"output".padStart(widths.output),
		"read".padStart(widths.read),
		"write".padStart(widths.write),
		"total".padStart(widths.total),
		"cost".padStart(widths.cost),
	].join("  ");

	const divider = "-".repeat(header.length);
	const body = displayRows.map((row) => [
		row.label.padEnd(widths.label),
		row.msgs.padStart(widths.msgs),
		row.input.padStart(widths.input),
		row.output.padStart(widths.output),
		row.read.padStart(widths.read),
		row.write.padStart(widths.write),
		row.total.padStart(widths.total),
		row.cost.padStart(widths.cost),
	].join("  "));

	const totalsLine = [
		"TOTAL".padEnd(widths.label),
		String(report.totals.messages).padStart(widths.msgs),
		formatInt(report.totals.input).padStart(widths.input),
		formatInt(report.totals.output).padStart(widths.output),
		formatInt(report.totals.cacheRead).padStart(widths.read),
		formatInt(report.totals.cacheWrite).padStart(widths.write),
		formatInt(report.totals.total).padStart(widths.total),
		formatCost(report.totals.cost).padStart(widths.cost),
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
		`Assistant messages matched: ${report.matchedMessages}`,
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
					`${message}\nUsage: /usage [today|7d|YYYY-MM-DD] [--project-current|--all-projects] [--by model|project|project-model] [--json]`,
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
};
