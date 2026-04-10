/**
 * BackgroundJobManager — manages detached/background subagent jobs.
 *
 * Each job runs a subagent process asynchronously and delivers its result
 * via a callback when complete. Jobs are evicted after a configurable TTL.
 *
 * Modeled after AsyncJobManager in async-jobs/job-manager.ts.
 */

import { randomUUID } from "node:crypto";
import type {
    BackgroundSubagentJob,
    BackgroundJobManagerOptions,
    BackgroundJobStatus,
} from "./background-types.js";

export type { BackgroundSubagentJob, BackgroundJobStatus };

type BackgroundJobResult = {
    summary: string;
    stderr: string;
    exitCode: number;
    model?: string;
    sessionFile?: string;
    parentSessionFile?: string;
};

type BackgroundJobMetadata = {
    parentSessionFile?: string;
    sessionFile?: string;
    model?: string;
};

export class BackgroundJobManager {
    private jobs = new Map<string, BackgroundSubagentJob>();
    private evictionTimers = new Map<string, ReturnType<typeof setTimeout>>();

    private maxRunning: number;
    private maxTotal: number;
    private evictionMs: number;
    private onJobComplete?: (job: BackgroundSubagentJob) => void;

    constructor(options: BackgroundJobManagerOptions = {}) {
        this.maxRunning = options.maxRunning ?? 10;
        this.maxTotal = options.maxTotal ?? 50;
        this.evictionMs = options.evictionMs ?? 5 * 60 * 1000;
        this.onJobComplete = options.onJobComplete;
    }

    /**
     * Register a new background subagent job.
     * @param agentName  The agent name being invoked
     * @param task       The task string
     * @param cwd        Working directory
     * @param runFn      Async function that runs the agent and returns a result summary
     * @returns          Job ID prefixed with `sa_`
     */
    register(
        agentName: string,
        task: string,
        cwd: string,
        runFn: (signal: AbortSignal) => Promise<BackgroundJobResult>,
        metadata?: BackgroundJobMetadata,
    ): string {
        const abortController = new AbortController();
        return this.attachJob(agentName, task, cwd, abortController, runFn(abortController.signal), metadata);
    }

    /**
     * Adopt an already-running foreground subagent into background tracking.
     */
    adoptRunning(
        agentName: string,
        task: string,
        cwd: string,
        abortController: AbortController,
        resultPromise: Promise<BackgroundJobResult>,
        metadata?: BackgroundJobMetadata,
    ): string {
        return this.attachJob(agentName, task, cwd, abortController, resultPromise, metadata);
    }

    /**
     * Cancel a running job.
     */
    cancel(id: string): "cancelled" | "not_found" | "already_done" {
        const job = this.jobs.get(id);
        if (!job) return "not_found";
        if (job.status !== "running") return "already_done";

        job.status = "cancelled";
        job.completedAt = Date.now();
        job.abortController.abort();
        this.scheduleEviction(id);
        return "cancelled";
    }

    getJob(id: string): BackgroundSubagentJob | undefined {
        return this.jobs.get(id);
    }

    getRunningJobs(): BackgroundSubagentJob[] {
        return [...this.jobs.values()].filter((j) => j.status === "running");
    }

    getRecentJobs(limit = 10): BackgroundSubagentJob[] {
        return [...this.jobs.values()]
            .sort((a, b) => b.startedAt - a.startedAt)
            .slice(0, limit);
    }

    getAllJobs(): BackgroundSubagentJob[] {
        return [...this.jobs.values()];
    }

    /**
     * Cancel all running jobs and clean up timers.
     */
    shutdown(): void {
        for (const timer of this.evictionTimers.values()) {
            clearTimeout(timer);
        }
        this.evictionTimers.clear();

        for (const job of this.jobs.values()) {
            if (job.status === "running") {
                job.status = "cancelled";
                job.completedAt = Date.now();
                job.abortController.abort();
            }
        }
    }

    // ── Private ──────────────────────────────────────────────────────────────

    private attachJob(
        agentName: string,
        task: string,
        cwd: string,
        abortController: AbortController,
        resultPromise: Promise<BackgroundJobResult>,
        metadata?: BackgroundJobMetadata,
    ): string {
        const running = this.getRunningJobs();
        if (running.length >= this.maxRunning) {
            throw new Error(
                `Maximum concurrent background subagents reached (${this.maxRunning}). ` +
                `Use /subagents cancel <id> to free a slot.`,
            );
        }
        if (this.jobs.size >= this.maxTotal) {
            this.evictOldest();
            if (this.jobs.size >= this.maxTotal) {
                throw new Error(
                    `Maximum total background subagent jobs reached (${this.maxTotal}). ` +
                    `Use /subagents cancel <id> to remove jobs.`,
                );
            }
        }

        const id = `sa_${randomUUID().slice(0, 8)}`;
        const job: BackgroundSubagentJob = {
            id,
            agentName,
            task,
            cwd,
            status: "running",
            startedAt: Date.now(),
            model: metadata?.model,
            sessionFile: metadata?.sessionFile,
            parentSessionFile: metadata?.parentSessionFile,
            abortController,
            promise: undefined as unknown as Promise<void>,
        };

        job.promise = resultPromise
            .then(({ summary, stderr, exitCode, model, sessionFile, parentSessionFile }) => {
                job.status = exitCode === 0 ? "completed" : "failed";
                job.completedAt = Date.now();
                job.resultSummary = summary;
                job.stderr = stderr;
                job.exitCode = exitCode;
                job.model = model;
                job.sessionFile = sessionFile;
                job.parentSessionFile = parentSessionFile;
                this.scheduleEviction(id);
                this.deliverResult(job);
            })
            .catch((err) => {
                if (job.status === "cancelled") {
                    this.scheduleEviction(id);
                    return;
                }
                job.status = "failed";
                job.completedAt = Date.now();
                job.exitCode = 1;
                job.stderr = err instanceof Error ? err.message : String(err);
                this.scheduleEviction(id);
                this.deliverResult(job);
            });

        this.jobs.set(id, job);
        return id;
    }

    private deliverResult(job: BackgroundSubagentJob): void {
        if (!this.onJobComplete) return;
        const cb = this.onJobComplete;
        queueMicrotask(() => cb(job));
    }

    private scheduleEviction(id: string): void {
        const existing = this.evictionTimers.get(id);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(() => {
            this.evictionTimers.delete(id);
            this.jobs.delete(id);
        }, this.evictionMs);

        this.evictionTimers.set(id, timer);
    }

    private evictOldest(): void {
        let oldest: BackgroundSubagentJob | undefined;
        for (const job of this.jobs.values()) {
            if (job.status !== "running") {
                if (!oldest || job.startedAt < oldest.startedAt) {
                    oldest = job;
                }
            }
        }
        if (oldest) {
            const timer = this.evictionTimers.get(oldest.id);
            if (timer) clearTimeout(timer);
            this.evictionTimers.delete(oldest.id);
            this.jobs.delete(oldest.id);
        }
    }
}
