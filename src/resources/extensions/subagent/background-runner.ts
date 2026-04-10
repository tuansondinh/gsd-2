/**
 * Background Subagent Runner
 *
 * Bridges BackgroundJobManager with the existing runSingleAgent logic.
 * Fires off a subagent process detached from the current turn so the
 * main session can continue immediately.
 */

import type { BackgroundJobManager } from "./background-job-manager.js";
import type { AgentConfig } from "./agents.js";

/** Subset of ctx needed to launch a background agent */
export interface BackgroundLaunchContext {
	defaultCwd: string;
	model?: { provider: string; id: string };
	parentSessionFile?: string;
}

/**
 * Run a subagent in background mode.
 *
 * Returns the job ID immediately. The underlying process runs independently
 * and the BackgroundJobManager's onJobComplete callback fires when done.
 */
export function runSubagentInBackground(
	manager: BackgroundJobManager,
	agents: AgentConfig[],
	agentName: string,
	task: string,
	cwd: string | undefined,
	modelOverride: string | undefined,
	ctx: BackgroundLaunchContext,
	/**
	 * The actual blocking runner — passed in from index.ts so we don't
	 * duplicate the spawn logic. Should resolve with the final output text.
	 */
	runFn: (signal: AbortSignal) => Promise<{
		exitCode: number;
		finalOutput: string;
		stderr: string;
		model?: string;
		sessionFile?: string;
		parentSessionFile?: string;
	}>,
): string {
	const effectiveCwd = cwd ?? ctx.defaultCwd;

	const jobId = manager.register(
		agentName,
		task,
		effectiveCwd,
		async (signal) => {
			const result = await runFn(signal);

			// Truncate summary to keep follow-up messages readable
			const MAX_SUMMARY = 300;
			const summary =
				result.finalOutput.length > MAX_SUMMARY
					? `${result.finalOutput.slice(0, MAX_SUMMARY)}…`
					: result.finalOutput || "(no output)";

			return {
				summary,
				stderr: result.stderr,
				exitCode: result.exitCode,
				model: result.model,
				sessionFile: result.sessionFile,
				parentSessionFile: result.parentSessionFile,
			};
		},
		{
			parentSessionFile: ctx.parentSessionFile,
		},
	);

	return jobId;
}
