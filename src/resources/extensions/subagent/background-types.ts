/**
 * Background Subagent Types
 *
 * Types for detached/background subagent execution.
 * Jobs are identified with a `sa_` prefix to distinguish from
 * async bash jobs (`bg_` prefix).
 */

export type BackgroundJobStatus = "running" | "completed" | "failed" | "cancelled";

export interface BackgroundSubagentJob {
	/** Unique job ID, prefixed with `sa_` */
	id: string;
	/** Agent name that was invoked */
	agentName: string;
	/** Full task string passed to the agent */
	task: string;
	/** Working directory the agent ran in */
	cwd: string;
	/** Current job status */
	status: BackgroundJobStatus;
	/** Epoch ms when the job started */
	startedAt: number;
	/** Epoch ms when the job finished (undefined while running) */
	completedAt?: number;
	/** Exit code of the subagent process */
	exitCode?: number;
	/** Concise summary of the agent's final output */
	resultSummary?: string;
	/** Stderr captured from the subagent process */
	stderr?: string;
	/** Model used by the subagent (if known) */
	model?: string;
	/** Session file created by the subagent run (if sessions are enabled) */
	sessionFile?: string;
	/** Parent session file this subagent was launched from (if known) */
	parentSessionFile?: string;
	/**
	 * Set by await_job-style consumers when they've already consumed the result.
	 * Suppresses the follow-up delivery.
	 */
	awaited?: boolean;
	/** Abort controller — used to cancel the running job */
	abortController: AbortController;
	/** The underlying promise (resolves when the job finishes) */
	promise: Promise<void>;
}

export interface BackgroundJobManagerOptions {
	/** Max concurrent running jobs. Default: 10 */
	maxRunning?: number;
	/** Max total tracked jobs (completed + running). Default: 50 */
	maxTotal?: number;
	/** TTL in ms before a completed job is evicted. Default: 5 minutes */
	evictionMs?: number;
	/** Called when a job transitions to completed/failed/cancelled */
	onJobComplete?: (job: BackgroundSubagentJob) => void;
}
