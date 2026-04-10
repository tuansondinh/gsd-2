export type AgentSwitchTargetKind = "parent" | "subagent";
export type AgentSwitchTargetState = "running" | "completed" | "failed";
export type AgentSwitchTargetSelectionAction = "switch_saved" | "attach_live" | "blocked";

export interface AgentSwitchTarget {
	id: string;
	kind: AgentSwitchTargetKind;
	sessionFile: string;
	parentSessionFile?: string;
	agentName: string;
	taskPreview: string;
	state: AgentSwitchTargetState;
	isCurrent: boolean;
	isLiveAttachCapable: boolean;
	selectionAction: AgentSwitchTargetSelectionAction;
	blockedReason?: string;
	runningJobId?: string;
	sortTime: number;
}

export interface AgentSwitchSessionLinkRecord {
	id: string;
	agentName: string;
	task: string;
	parentSessionFile: string;
	subagentSessionFile: string;
	updatedAt: number;
	state: AgentSwitchTargetState;
}

export interface AgentSwitchRunningJobRecord {
	id: string;
	agentName: string;
	task: string;
	startedAt: number;
	parentSessionFile?: string;
	sessionFile?: string;
	cwd?: string;
}

export interface BuildAgentSwitchTargetsInput {
	currentSessionFile: string;
	rootParentSessionFile: string;
	currentCwd?: string;
	trackedLinks: AgentSwitchSessionLinkRecord[];
	runningJobs: AgentSwitchRunningJobRecord[];
}

function summarizeTask(task: string, max = 72): string {
	const trimmed = task.replace(/\s+/g, " ").trim();
	if (!trimmed) return "(no task)";
	return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

function stateRank(state: AgentSwitchTargetState): number {
	if (state === "running") return 0;
	if (state === "completed") return 1;
	return 2;
}

function shouldIncludeRunningJob(
	job: AgentSwitchRunningJobRecord,
	rootParentSessionFile: string,
	currentCwd?: string,
): boolean {
	if (job.parentSessionFile) return job.parentSessionFile === rootParentSessionFile;
	if (currentCwd && job.cwd) return currentCwd === job.cwd;
	return false;
}

export function buildAgentSwitchTargets(input: BuildAgentSwitchTargetsInput): AgentSwitchTarget[] {
	const targetsBySessionFile = new Map<string, AgentSwitchTarget>();

	for (const link of input.trackedLinks) {
		const canAttachLive = link.state === "running";
		targetsBySessionFile.set(link.subagentSessionFile, {
			id: link.id,
			kind: "subagent",
			sessionFile: link.subagentSessionFile,
			parentSessionFile: link.parentSessionFile,
			agentName: link.agentName,
			taskPreview: summarizeTask(link.task),
			state: link.state,
			isCurrent: link.subagentSessionFile === input.currentSessionFile,
			isLiveAttachCapable: canAttachLive,
			selectionAction: link.state === "running" ? (canAttachLive ? "attach_live" : "blocked") : "switch_saved",
			blockedReason: link.state === "running" && !canAttachLive
				? "Live attach is not implemented yet for running subagents."
				: undefined,
			sortTime: link.updatedAt,
		});
	}

	const runningExtras: AgentSwitchTarget[] = [];
	for (const job of input.runningJobs) {
		if (!shouldIncludeRunningJob(job, input.rootParentSessionFile, input.currentCwd)) continue;

		if (job.sessionFile && targetsBySessionFile.has(job.sessionFile)) {
			const existing = targetsBySessionFile.get(job.sessionFile)!;
			existing.state = "running";
			existing.isLiveAttachCapable = true;
			existing.selectionAction = "attach_live";
			existing.blockedReason = undefined;
			existing.runningJobId = job.id;
			existing.sortTime = Math.max(existing.sortTime, job.startedAt);
			continue;
		}

		const canAttachLive = Boolean(job.sessionFile);
		const syntheticSessionFile = job.sessionFile ?? `${input.rootParentSessionFile}#${job.id}`;
		runningExtras.push({
			id: job.id,
			kind: "subagent",
			sessionFile: syntheticSessionFile,
			parentSessionFile: job.parentSessionFile ?? input.rootParentSessionFile,
			agentName: job.agentName,
			taskPreview: summarizeTask(job.task),
			state: "running",
			isCurrent: Boolean(job.sessionFile && job.sessionFile === input.currentSessionFile),
			isLiveAttachCapable: canAttachLive,
			selectionAction: canAttachLive ? "attach_live" : "blocked",
			blockedReason: canAttachLive ? undefined : "Live attach is not implemented yet for running subagents.",
			runningJobId: job.id,
			sortTime: job.startedAt,
		});
	}

	const parentTarget: AgentSwitchTarget = {
		id: "parent",
		kind: "parent",
		sessionFile: input.rootParentSessionFile,
		agentName: "parent",
		taskPreview: "Main session",
		state: "completed",
		isCurrent: input.currentSessionFile === input.rootParentSessionFile,
		isLiveAttachCapable: false,
		selectionAction: input.currentSessionFile === input.rootParentSessionFile ? "blocked" : "switch_saved",
		blockedReason: input.currentSessionFile === input.rootParentSessionFile
			? "You are already in the parent/main session."
			: undefined,
		sortTime: Number.MAX_SAFE_INTEGER,
	};

	const targets = [
		parentTarget,
		...targetsBySessionFile.values(),
		...runningExtras,
	];

	targets.sort((a, b) => {
		if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
		if (a.kind !== b.kind) return a.kind === "parent" ? -1 : 1;
		const stateDiff = stateRank(a.state) - stateRank(b.state);
		if (stateDiff !== 0) return stateDiff;
		if (a.sortTime !== b.sortTime) return b.sortTime - a.sortTime;
		return a.agentName.localeCompare(b.agentName);
	});

	return targets;
}
