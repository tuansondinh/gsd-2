import { existsSync, mkdirSync, readFileSync } from "node:fs";
import {
  getAgentDir,
  getPermissionMode,
  isToolCallEventType,
  setPermissionMode,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type PermissionMode,
} from "@gsd/pi-coding-agent";
import { join } from "node:path";

const PLAN_ENTRY_TYPE = "plan-mode-state";
const PLAN_APPROVAL_ACTION_QUESTION_ID = "plan_mode_approval_action";
const PLAN_APPROVAL_PERMISSION_QUESTION_ID = "plan_mode_approval_permission";
const PLAN_SUGGEST_QUESTION_ID = "plan_mode_suggest_switch";
const PLAN_DIR_RE = /(^|[/\\])\.(?:lsd|gsd)[/\\]plan([/\\]|$)/;
const BASH_READ_ONLY_RE = /^\s*(cat|head|tail|less|more|wc|file|stat|du|df|which|type|echo|printf|ls|find|grep|rg|awk|sed\b(?!.*-i)|sort|uniq|diff|comm|tr|cut|tee\s+-a\s+\/dev\/null|git\s+(log|show|diff|status|branch|tag|remote|rev-parse|ls-files|blame|shortlog|describe|stash\s+list|config\s+--get|cat-file)|gh\s+(issue|pr|api|repo|release)\s+(view|list|diff|status|checks)|mkdir\s+-p\s+\.(?:lsd|gsd)(?:[\\/]+plan)?|rtk\s)/;
const SAFE_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  "lsp",
  "ask_user_questions",
  "resolve_library",
  "get_library_docs",
  "search-the-web",
  "fetch_page",
  "search_and_read",
  "google_search",
  "mcp_servers",
  "mcp_discover",
]);
const BLOCKED_TOOLS = new Set([
  "async_bash",
  "bg_shell",
  "browser_navigate",
  "browser_go_back",
  "browser_go_forward",
  "browser_reload",
  "browser_click",
  "browser_drag",
  "browser_type",
  "browser_upload_file",
  "browser_scroll",
  "browser_hover",
  "browser_key_press",
  "browser_select_option",
  "browser_set_checked",
  "browser_set_viewport",
  "browser_click_ref",
  "browser_hover_ref",
  "browser_fill_ref",
  "browser_act",
  "browser_batch",
  "browser_fill_form",
  "browser_mock_route",
  "browser_block_urls",
  "browser_clear_routes",
  "browser_emulate_device",
  "browser_save_state",
  "browser_restore_state",
  "browser_generate_test",
  "browser_verify",
  "write",
  "edit",
]);
const DEFAULT_APPROVAL_PERMISSION_MODE: RestorablePermissionMode = "auto";
const APPROVE_LABEL = "Approve plan";
const APPROVE_AUTO_LABEL = "Auto mode";
const APPROVE_BYPASS_LABEL = "Bypass mode";
const APPROVE_AUTO_SUBAGENT_LABEL = "Execute with subagent in auto mode";
const APPROVE_BYPASS_SUBAGENT_LABEL = "Execute with subagent in bypass mode";
const APPROVE_NEW_SESSION_LABEL = "New session with coding model"; // shown in second question when autoSwitchPlanModel is on
const REVIEW_LABEL = "Let other agent review";
const REVISE_LABEL = "Revise plan";
const CANCEL_LABEL = "Cancel";
const DEFAULT_PLAN_REVIEW_AGENT = "generic";
const DEFAULT_PLAN_CODING_AGENT = "worker";

type PlanApprovalStatus = "pending" | "approved" | "revising" | "cancelled";
type RestorablePermissionMode = Exclude<PermissionMode, "plan">;
type ModelRef = { provider: string; id: string };

type AskUserAnswer = {
  selected: string | string[];
  notes?: string;
};

interface PlanModeState {
  active: boolean;
  task: string;
  latestPlanPath?: string;
  approvalStatus: PlanApprovalStatus;
  previousMode?: RestorablePermissionMode;
  preplanModel?: ModelRef;
  targetPermissionMode?: PermissionMode;
}

const INITIAL_STATE: PlanModeState = {
  active: false,
  task: "",
  latestPlanPath: undefined,
  approvalStatus: "cancelled",
  previousMode: undefined,
  preplanModel: undefined,
  targetPermissionMode: undefined,
};

let state: PlanModeState = { ...INITIAL_STATE };
let startedFromFlag = false;
let reasoningModelSwitchDone = false;

function isPlanModeActive(): boolean {
  return getPermissionMode() === "plan";
}

function parseQualifiedModelRef(value: unknown): ModelRef | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const parts = trimmed.split("/");
  if (parts.length !== 2) return undefined;
  const [provider, id] = parts.map((part) => part.trim());
  if (!provider || !id) return undefined;
  return { provider, id };
}

function parseSubagentName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readPlanModeSettings(): { reasoningModel?: string; reviewModel?: string; codingModel?: string; codingSubagent?: string } {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (!existsSync(settingsPath)) return {};
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as {
      planModeReasoningModel?: unknown;
      planModeReviewModel?: unknown;
      planModeCodingModel?: unknown;
      planModeCodingSubagent?: unknown;
      planModeCodingAgent?: unknown;
    };
    const reasoningModel = parseQualifiedModelRef(parsed.planModeReasoningModel);
    const reviewModel = parseQualifiedModelRef(parsed.planModeReviewModel);
    const codingModel = parseQualifiedModelRef(parsed.planModeCodingModel);
    const codingSubagent = parseSubagentName(parsed.planModeCodingSubagent)
      ?? parseSubagentName(parsed.planModeCodingAgent);
    return {
      reasoningModel: reasoningModel ? `${reasoningModel.provider}/${reasoningModel.id}` : undefined,
      reviewModel: reviewModel ? `${reviewModel.provider}/${reviewModel.id}` : undefined,
      codingModel: codingModel ? `${codingModel.provider}/${codingModel.id}` : undefined,
      codingSubagent,
    };
  } catch {
    return {};
  }
}

export function readPlanModeReasoningModel(): string | undefined {
  return readPlanModeSettings().reasoningModel;
}

export function readPlanModeReviewModel(): string | undefined {
  return readPlanModeSettings().reviewModel;
}

export function readPlanModeCodingModel(): string | undefined {
  return readPlanModeSettings().codingModel;
}

export function readPlanModeCodingSubagent(): string | undefined {
  return readPlanModeSettings().codingSubagent;
}

function readAutoSuggestPlanModeSetting(): boolean {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (!existsSync(settingsPath)) return false;
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as { autoSuggestPlanMode?: unknown };
    return parsed.autoSuggestPlanMode === true;
  } catch {
    return false;
  }
}

function readAutoSwitchPlanModelSetting(): boolean {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (!existsSync(settingsPath)) return false;
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as { autoSwitchPlanModel?: unknown };
    return parsed.autoSwitchPlanModel === true;
  } catch {
    return false;
  }
}

function buildAutoSuggestPlanModeSystemPrompt(): string {
  return [
    `Plan-mode suggestion: if the user's latest request describes a large, multi-step, or ambiguous task — e.g. a refactor, multi-file change, new feature, migration, or anything that benefits from upfront investigation — proactively ask whether to switch to plan mode before making any edits.`,
    `How to suggest: call ask_user_questions with a single question. Set the question id to exactly "${PLAN_SUGGEST_QUESTION_ID}". Ask: "This looks like a complex task. Would you like to switch to plan mode first?". Provide exactly two options: "Yes, switch to plan mode" (recommended) and "No, proceed directly". Do NOT call /plan yourself — wait for the user answer and the system will handle switching automatically.`,
    "Do not suggest plan mode for simple, single-file, or read-only tasks. Do not suggest it if the user is already in plan mode or in the middle of an implementation. Only suggest it once per distinct task.",
  ].join(" ");
}

function sameModel(left: ModelRef | undefined, right: ModelRef | undefined): boolean {
  return !!left && !!right && left.provider === right.provider && left.id === right.id;
}

function resolveModelFromContext(ctx: any, modelRef: ModelRef): any | undefined {
  const allModels = typeof ctx?.modelRegistry?.getAll === "function" ? ctx.modelRegistry.getAll() : [];
  return allModels.find((model: any) => model.provider === modelRef.provider && model.id === modelRef.id);
}

function setPermissionModeAndEnv(mode: PermissionMode): void {
  setPermissionMode(mode);
  try {
    const settingsManager = SettingsManager.create();
    settingsManager.setPermissionMode(mode);
  } catch {
    // Best-effort persistence; if settings manager is unavailable, proceed with in-memory only
  }
  process.env.LUCENT_CODE_PERMISSION_MODE = mode;
}

function saveState(pi: ExtensionAPI): void {
  pi.appendEntry<PlanModeState>(PLAN_ENTRY_TYPE, { ...state });
}

function setState(pi: ExtensionAPI, next: PlanModeState): void {
  state = next;
  saveState(pi);
}

function resetState(pi: ExtensionAPI, overrides: Partial<PlanModeState> = {}): void {
  setState(pi, {
    ...INITIAL_STATE,
    ...overrides,
  });
}

function ensurePlanDir(): string {
  const dir = join(process.cwd(), ".lsd", "plan");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function restoreStateFromSession(ctx: ExtensionCommandContext | any): void {
  try {
    const entries = ctx.sessionManager.getEntries();
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (entry.type === "custom" && entry.customType === PLAN_ENTRY_TYPE && entry.data) {
        state = entry.data as PlanModeState;
        return;
      }
    }
  } catch {
    // Best-effort restore only.
  }
}

async function enablePlanModeWithModelSwitch(
  pi: ExtensionAPI,
  ctx: any,
  currentModel: ModelRef | undefined,
  next: Partial<Pick<PlanModeState, "task" | "latestPlanPath" | "approvalStatus" | "previousMode" | "preplanModel" | "targetPermissionMode">> = {},
): Promise<void> {
  enablePlanMode(pi, currentModel, next);
  // Keep fallback behavior in before_agent_start for restored sessions or when
  // immediate switching cannot be completed at entry-time.
  reasoningModelSwitchDone = false;
  if (!readAutoSwitchPlanModelSetting()) return;

  const reasoningModel = parseQualifiedModelRef(readPlanModeReasoningModel());
  if (!reasoningModel) {
    ctx.ui?.notify?.(
      "OpusPlan: set a Plan reasoning model in /settings to auto-switch on entry",
      "info",
    );
    return;
  }

  reasoningModelSwitchDone = await setModelIfNeeded(pi, ctx, reasoningModel);
}

function enablePlanMode(
  pi: ExtensionAPI,
  currentModel: ModelRef | undefined,
  next: Partial<Pick<PlanModeState, "task" | "latestPlanPath" | "approvalStatus" | "previousMode" | "preplanModel" | "targetPermissionMode">> = {},
): void {
  const currentMode = getPermissionMode();
  const enteringPlanMode = currentMode !== "plan";
  const previousMode: RestorablePermissionMode = enteringPlanMode
    ? currentMode
    : (state.previousMode ?? "accept-on-edit");

  setPermissionModeAndEnv("plan");
  setState(pi, {
    active: true,
    task: next.task ?? state.task,
    latestPlanPath: next.latestPlanPath ?? state.latestPlanPath,
    approvalStatus: next.approvalStatus ?? state.approvalStatus ?? "pending",
    previousMode: next.previousMode ?? previousMode,
    preplanModel: next.preplanModel ?? (enteringPlanMode ? (currentModel ?? state.preplanModel) : state.preplanModel),
    targetPermissionMode: next.targetPermissionMode ?? state.targetPermissionMode,
  });
}

function leavePlanMode(
  pi: ExtensionAPI,
  approvalStatus: PlanApprovalStatus,
  nextPermissionMode: RestorablePermissionMode,
  clearTask = false,
): RestorablePermissionMode {
  reasoningModelSwitchDone = false;
  setPermissionModeAndEnv(nextPermissionMode);
  setState(pi, {
    active: false,
    task: clearTask ? "" : state.task,
    latestPlanPath: state.latestPlanPath,
    approvalStatus,
    previousMode: state.previousMode,
    preplanModel: state.preplanModel,
    targetPermissionMode: state.targetPermissionMode ?? nextPermissionMode,
  });
  return nextPermissionMode;
}

async function setModelIfNeeded(pi: ExtensionAPI, ctx: any, modelRef: ModelRef | undefined): Promise<boolean> {
  if (!modelRef) return false;
  const currentModel = parseQualifiedModelRef(ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  if (sameModel(currentModel, modelRef)) return true;
  const model = resolveModelFromContext(ctx, modelRef);
  if (!model) return false;
  await pi.setModel(model, { persist: false });
  return true;
}

function buildExecutionKickoffMessage(options: { permissionMode: RestorablePermissionMode; executeWithSubagent?: boolean }): string {
  const { permissionMode, executeWithSubagent = false } = options;
  const task = state.task.trim();

  if (!executeWithSubagent) {
    const details: string[] = [
      "Plan approved. Exit plan mode and start implementation immediately.",
    ];
    if (task) details.push(`Original task: ${task}`);
    if (state.latestPlanPath) details.push(`Use the approved plan artifact at ${state.latestPlanPath} as the execution plan.`);
    return details.join(" ");
  }

  const codingModel = readPlanModeCodingModel();
  const codingSubagent = readPlanModeCodingSubagent() ?? DEFAULT_PLAN_CODING_AGENT;
  const agentInvocationInstruction = codingModel
    ? `Invoke the subagent tool with exact parameters agent "${codingSubagent}" and model="${codingModel}" to implement the plan end-to-end.`
    : `Invoke the subagent tool with exact parameter agent "${codingSubagent}" to implement the plan end-to-end.`;

  const details: string[] = [
    "Plan approved. Exit plan mode and execute the approved plan with a subagent now.",
    agentInvocationInstruction,
    `Execution permission mode is now \"${permissionMode}\".`,
  ];
  if (task) details.push(`Original task: ${task}`);
  if (state.latestPlanPath) details.push(`Primary plan artifact: ${state.latestPlanPath}`);
  details.push(
    "Important: if the plan is large and you estimate it would exceed a single subagent's context window (~200k tokens), " +
    "split execution across multiple sequential subagents instead of one. " +
    "Use the subagent tool's chain mode: pass a \"chain\" array where each entry covers one self-contained phase or group of steps from the plan. " +
    "Each chain entry should include the agent name, a focused task description for that phase, and may reference {previous} to receive the prior phase's output as handoff context. " +
    "Only split when genuinely needed — prefer a single subagent for plans that fit comfortably.",
  );
  details.push(
    "After all subagents complete: (1) do a quick review of the implementation — check that the plan steps were actually carried out, spot obvious issues or missed pieces, and verify the code compiles/passes lint if applicable. " +
    "(2) Then summarize what was done, what (if anything) needs follow-up, and flag any concerns found during review.",
  );
  return details.join(" ");
}

// Pending new-session payload — set before triggering the internal command
interface PendingNewSession {
  codingModelRef: ModelRef | undefined;
  codingSubagent: string;
  planPath: string | undefined;
  planContent: string | undefined;
  task: string;
}
let pendingNewSession: PendingNewSession | null = null;

function scheduleNewSession(pi: ExtensionAPI, ctx: any): void {
  const codingModelRef = parseQualifiedModelRef(readPlanModeCodingModel());
  const codingSubagent = readPlanModeCodingSubagent() ?? DEFAULT_PLAN_CODING_AGENT;
  const planPath = state.latestPlanPath;
  const planContent = planPath ? readPlanArtifact(planPath) : undefined;

  pendingNewSession = {
    codingModelRef,
    codingSubagent,
    planPath,
    planContent,
    task: state.task,
  };

  leavePlanMode(pi, "approved", "auto");
  ctx.ui?.notify?.("Plan approved. Starting new session…", "info");

  // Trigger the internal command which has ExtensionCommandContext (ctx.newSession available).
  // Must use the /prefix so tryExecuteExtensionCommand parses the name correctly.
  pi.executeSlashCommand("/plan-execute-new-session");
}

async function approvePlan(
  pi: ExtensionAPI,
  ctx: any,
  permissionMode: RestorablePermissionMode,
  executeWithSubagent = false,
): Promise<void> {
  const reasoningModel = parseQualifiedModelRef(readPlanModeReasoningModel());
  if (reasoningModel) {
    await setModelIfNeeded(pi, ctx, reasoningModel);
  }

  state = {
    ...state,
    targetPermissionMode: permissionMode,
  };
  leavePlanMode(pi, "approved", permissionMode);
  // Deliver the kickoff as a steering message so it is injected BEFORE the LLM
  // produces its next assistant turn. Using "followUp" would defer delivery
  // until the agent has no more tool calls, which lets the LLM call the
  // subagent tool with the default session model BEFORE it ever sees the
  // explicit model="<planModeCodingModel>" instruction. Steering ensures the
  // configured plan-mode coding model reaches the subagent invocation.
  await pi.sendUserMessage(buildExecutionKickoffMessage({ permissionMode, executeWithSubagent }), { deliverAs: "steer" });
}

async function cancelPlan(pi: ExtensionAPI, ctx: any, clearTask = true): Promise<RestorablePermissionMode> {
  const restoreMode = state.previousMode ?? "accept-on-edit";
  await setModelIfNeeded(pi, ctx, state.preplanModel);
  leavePlanMode(pi, "cancelled", restoreMode, clearTask);
  resetState(pi, { approvalStatus: "cancelled" });
  return restoreMode;
}

function buildPlanModeSystemPrompt(): string {
  const details: string[] = [
    "You are currently in plan mode.",
    "Investigate, clarify scope, and produce a persisted execution plan before making source changes.",
    "If requirements are ambiguous or constraints are missing, ask concise clarifying questions before drafting or saving a plan.",
    "Do not modify source files or run side-effect commands while plan mode is active.",
    "Persist plan artifacts under .lsd/plan/.",
  ];
  if (state.task) details.push(`Current task: ${state.task}`);
  if (state.latestPlanPath) details.push(`Latest plan artifact: ${state.latestPlanPath}`);
  return details.join(" ");
}

function readPlanArtifact(planPath: string): string | undefined {
  try {
    if (!existsSync(planPath)) return undefined;
    return readFileSync(planPath, "utf-8").trim();
  } catch {
    return undefined;
  }
}

function buildNewSessionOptionLabel(): string {
  const codingModel = readPlanModeCodingModel();
  const codingSubagent = readPlanModeCodingSubagent() ?? DEFAULT_PLAN_CODING_AGENT;
  const modelSuffix = codingModel ? codingModel.split("/")[1] ?? codingModel : null;
  // e.g. "Approve plan — new session (worker · claude-sonnet-4-6)"
  //      "Approve plan — new session (worker)"
  const suffix = modelSuffix ? `${codingSubagent} · ${modelSuffix}` : codingSubagent;
  return `${APPROVE_LABEL} — ${APPROVE_NEW_SESSION_LABEL} (${suffix})`;
}

function buildApprovalActionInstructions(): string {
  const autoSwitchEnabled = readAutoSwitchPlanModelSetting();
  const showNewSessionOption = autoSwitchEnabled;
  const newSessionLabel = buildNewSessionOptionLabel();

  return [
    "Ask for plan approval now via exactly one ask_user_questions tool call.",
    `Question 1 (single-select) id \"${PLAN_APPROVAL_ACTION_QUESTION_ID}\": ask what to do next with the plan.`,
    `Question 1 options: ${APPROVE_LABEL}, ${REVIEW_LABEL}, ${REVISE_LABEL}. Put "${APPROVE_LABEL}" first with a "(Recommended)" suffix in the description, not in the label.`,
    `Do not include \"${CANCEL_LABEL}\" as an explicit option — if the user wants to cancel they should choose \"None of the above\" and type \"${CANCEL_LABEL}\" in the note.`,
    `Question 2 (single-select) id \"${PLAN_APPROVAL_PERMISSION_QUESTION_ID}\": ask which execution mode to use.`,
    `Question 2 options: ${APPROVE_AUTO_LABEL} (Recommended), ${APPROVE_BYPASS_LABEL}, ${APPROVE_AUTO_SUBAGENT_LABEL}, ${APPROVE_BYPASS_SUBAGENT_LABEL}${showNewSessionOption ? `, ${newSessionLabel}` : ""}.`,
    `Set question 2 showWhen.questionId to \"${PLAN_APPROVAL_ACTION_QUESTION_ID}\" and showWhen.selectedAnyOf to [\"${APPROVE_LABEL}\"] so it appears only when the user selects Approve plan.`,
    "Do not restate the plan in a normal assistant response. Just call ask_user_questions.",
  ].join(" ");
}

// Keep for external callers that reference the combined form (headless path)
function buildApprovalDialogInstructions(): string {
  return buildApprovalActionInstructions();
}

function buildApprovalSteeringMessage(planPath: string): string {
  return [
    `Plan artifact saved at ${planPath}.`,
    buildApprovalActionInstructions(),
  ].join("\n\n");
}

function buildPlanPreviewMessage(planPath: string, planMarkdown?: string): string {
  const details = [
    `Current plan artifact: ${planPath}`,
    "Here is the current saved plan:",
  ];

  if (planMarkdown) {
    // Render markdown directly so the plan preview UI can display headings/lists/code blocks.
    details.push(planMarkdown);
  } else {
    details.push(`Unable to read ${planPath} right now.`);
  }

  details.push("Hint: run /execute to approve and start implementation, or keep planning and revise the file.");
  return details.join("\n\n");
}

function buildReviewSteeringMessage(planPath: string, planMarkdown?: string): string {
  const reviewModel = readPlanModeReviewModel();
  const modelInstruction = reviewModel
    ? `Use the subagent tool with agent \"${DEFAULT_PLAN_REVIEW_AGENT}\" and set model to \"${reviewModel}\".`
    : `Use the subagent tool with agent \"${DEFAULT_PLAN_REVIEW_AGENT}\" and do not pass a model override so it uses the default/current model.`;

  const details = [
    `The user selected \"${REVIEW_LABEL}\" for ${planPath}.`,
    "Delegate a read-only plan review to another agent now.",
    modelInstruction,
    "Subagent task requirements: review the proposed plan only, identify missing steps, risks, edge cases, sequencing issues, and unclear acceptance criteria, and do not edit files or implement anything.",
  ];

  if (planMarkdown) {
    details.push(
      "Provide the subagent this exact plan markdown as context:",
      "```markdown",
      planMarkdown,
      "```",
    );
  } else {
    details.push(`Have the subagent read ${planPath} before reviewing it.`);
  }

  details.push(
    "After the subagent responds, summarize its feedback for the user, present the current plan again, and then ask for approval again.",
    buildApprovalActionInstructions(),
  );

  return details.join("\n\n");
}

function approvalSelectionToExecutionMode(
  selected: string | undefined,
): { permissionMode: RestorablePermissionMode; executeWithSubagent: boolean } | undefined {
  if (!selected) return undefined;
  if (selected.includes(APPROVE_AUTO_SUBAGENT_LABEL)) return { permissionMode: "auto", executeWithSubagent: true };
  if (selected.includes(APPROVE_BYPASS_SUBAGENT_LABEL)) {
    return { permissionMode: "danger-full-access", executeWithSubagent: true };
  }
  if (selected.includes(APPROVE_AUTO_LABEL)) return { permissionMode: "auto", executeWithSubagent: false };
  if (selected.includes(APPROVE_BYPASS_LABEL)) {
    return { permissionMode: "danger-full-access", executeWithSubagent: false };
  }
  return undefined;
}

function approvalSelectionToPermissionMode(selected: string | undefined): RestorablePermissionMode | undefined {
  return approvalSelectionToExecutionMode(selected)?.permissionMode;
}

function getAnswerValues(answer: AskUserAnswer | undefined): string[] {
  if (!answer) return [];
  const selected = Array.isArray(answer.selected) ? answer.selected : [answer.selected];
  const values = selected.filter((value): value is string => typeof value === "string");
  if (typeof answer.notes === "string" && answer.notes.trim()) {
    values.push(`user_note: ${answer.notes.trim()}`);
  }
  return values;
}

function selectionRequestsCancel(selected: string[]): boolean {
  return selected.some((value) => {
    if (typeof value !== "string") return false;
    if (value.includes(CANCEL_LABEL)) return true;
    const normalized = value.replace(/^user_note:\s*/i, "").trim().toLowerCase();
    return normalized === "cancel" || normalized.includes("cancel plan");
  });
}

export const __testing = {
  getState(): PlanModeState {
    return { ...state };
  },
  resetState(): void {
    state = { ...INITIAL_STATE };
    startedFromFlag = false;
  },
  parseQualifiedModelRef,
  approvalSelectionToPermissionMode,
  approvalSelectionToExecutionMode,
  buildApprovalSteeringMessage,
  buildPlanPreviewMessage,
  buildReviewSteeringMessage,
  buildAutoSuggestPlanModeSystemPrompt,
  readAutoSuggestPlanModeSetting,
  PLAN_SUGGEST_QUESTION_ID,
};

export default function planCommand(pi: ExtensionAPI) {
  pi.registerFlag("plan", {
    description: "Start the session in plan mode and require a persisted .lsd/plan markdown plan before execution",
    type: "boolean",
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreStateFromSession(ctx);
    startedFromFlag = false;
    reasoningModelSwitchDone = false;
    if (state.active) {
      setPermissionModeAndEnv("plan");
    }
  });

  pi.on("before_agent_start", async (_event, ctx) => {
    if (isPlanModeActive()) {
      // Switch to reasoning model once per plan mode activation
      if (!reasoningModelSwitchDone && readAutoSwitchPlanModelSetting()) {
        const reasoningModel = parseQualifiedModelRef(readPlanModeReasoningModel());
        if (reasoningModel) {
          reasoningModelSwitchDone = await setModelIfNeeded(pi, ctx, reasoningModel);
        }
      }
      return { systemPrompt: buildPlanModeSystemPrompt() };
    }
    if (readAutoSuggestPlanModeSetting()) {
      return { systemPrompt: buildAutoSuggestPlanModeSystemPrompt() };
    }
    return;
  });

  pi.on("input", async (event, ctx) => {
    const planFlag = pi.getFlag("plan");
    if (startedFromFlag || planFlag !== true || event.source !== "interactive") {
      return { action: "continue" as const };
    }

    startedFromFlag = true;
    ensurePlanDir();
    await enablePlanModeWithModelSwitch(pi, ctx, ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined, {
      task: event.text.trim(),
      approvalStatus: "pending",
      latestPlanPath: undefined,
      targetPermissionMode: undefined,
    });

    return { action: "continue" as const };
  });

  pi.on("tool_call", async (event) => {
    if (!isPlanModeActive()) return;

    if (SAFE_TOOLS.has(event.toolName)) return;

    if (isToolCallEventType("write", event) || isToolCallEventType("edit", event)) {
      if (PLAN_DIR_RE.test(event.input.path)) return;
      return {
        block: true,
        reason: `Plan mode is active. You may only write plan artifacts under .lsd/plan/ until the plan is approved. Blocked path: ${event.input.path}`,
      };
    }

    if (isToolCallEventType("bash", event)) {
      if (BASH_READ_ONLY_RE.test(event.input.command)) return;
      return {
        block: true,
        reason: "Plan mode is active. Only read-only investigative bash commands are allowed until plan mode is exited.",
      };
    }

    if (BLOCKED_TOOLS.has(event.toolName)) {
      return {
        block: true,
        reason: `Plan mode is active. Tool ${event.toolName} is blocked until plan mode is exited.`,
      };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    if (event.toolName === "write" || event.toolName === "edit") {
      const input = event.input as { path?: string } | undefined;
      const path = input?.path;
      if (path && PLAN_DIR_RE.test(path) && isPlanModeActive()) {
        setState(pi, {
          ...state,
          latestPlanPath: path,
          approvalStatus: "pending",
          targetPermissionMode: undefined,
        });

        if (!ctx.hasUI) {
          await approvePlan(pi, ctx, DEFAULT_APPROVAL_PERMISSION_MODE);
          return;
        }

        const planMarkdown = readPlanArtifact(path);
        pi.sendMessage({
          customType: "plan-mode-preview",
          content: buildPlanPreviewMessage(path, planMarkdown),
          display: true,
        });
        ctx.ui?.notify?.("/plan to show plan", "info");
        pi.sendUserMessage(buildApprovalSteeringMessage(path), { deliverAs: "steer" });
      }
      return;
    }

    if (event.toolName === "ask_user_questions" && !isPlanModeActive()) {
      const details = event.details as {
        cancelled?: boolean;
        response?: { answers?: Record<string, AskUserAnswer> };
      } | undefined;
      if (!details?.cancelled && details?.response?.answers) {
        const suggestAnswer = details.response.answers[PLAN_SUGGEST_QUESTION_ID];
        if (suggestAnswer) {
          const selected = Array.isArray(suggestAnswer.selected) ? suggestAnswer.selected[0] : suggestAnswer.selected;
          if (typeof selected === "string" && selected.toLowerCase().includes("yes")) {
            ensurePlanDir();
            await enablePlanModeWithModelSwitch(pi, ctx, ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined, {
              task: state.task,
              latestPlanPath: undefined,
              approvalStatus: "pending",
              targetPermissionMode: undefined,
            });
            ctx.ui?.notify?.("Plan mode enabled. Investigate and produce a plan before making changes.", "info");
            pi.sendUserMessage(
              "The user confirmed switching to plan mode. You are now in plan mode. Investigate the task and produce a persisted execution plan under .lsd/plan/ before making any source changes.",
              { deliverAs: "steer" },
            );
          }
          return;
        }
      }
      return;
    }

    if (!isPlanModeActive() || event.toolName !== "ask_user_questions") return;

    const details = event.details as {
      cancelled?: boolean;
      response?: { answers?: Record<string, AskUserAnswer> };
    } | undefined;
    if (details?.cancelled || !details?.response?.answers) return;

    const actionAnswer = details.response.answers[PLAN_APPROVAL_ACTION_QUESTION_ID];
    const permissionAnswer = details.response.answers[PLAN_APPROVAL_PERMISSION_QUESTION_ID];
    const actionValues = getAnswerValues(actionAnswer);
    const permissionValues = getAnswerValues(permissionAnswer);

    // ── Second question answered (execution mode) ─────────────────────────
    if (permissionValues.length > 0) {
      if (selectionRequestsCancel(permissionValues)) {
        await cancelPlan(pi, ctx, true);
        return;
      }

      if (permissionValues[0]?.includes(APPROVE_NEW_SESSION_LABEL)) {
        scheduleNewSession(pi, ctx);
        return;
      }

      const executionMode = approvalSelectionToExecutionMode(permissionValues[0]) ?? {
        permissionMode: DEFAULT_APPROVAL_PERMISSION_MODE,
        executeWithSubagent: false,
      };
      state = { ...state, targetPermissionMode: executionMode.permissionMode };
      if (executionMode.executeWithSubagent) {
        const modeLabel = executionMode.permissionMode === "danger-full-access" ? "bypass" : "auto";
        ctx.ui?.notify?.(`Plan approved: subagent(${modeLabel})`, "info");
      }
      await approvePlan(pi, ctx, executionMode.permissionMode, executionMode.executeWithSubagent);
      return;
    }

    // ── First question answered (action) ──────────────────────────────────
    if (actionValues.length === 0) return;

    if (selectionRequestsCancel(actionValues)) {
      await cancelPlan(pi, ctx, true);
      return;
    }

    const actionSelection = actionValues[0];
    if (!actionSelection) return;

    if (actionSelection.includes(APPROVE_LABEL)) {
      const executionMode = approvalSelectionToExecutionMode(permissionValues[0]) ?? {
        permissionMode: DEFAULT_APPROVAL_PERMISSION_MODE,
        executeWithSubagent: false,
      };
      state = { ...state, targetPermissionMode: executionMode.permissionMode };
      if (executionMode.executeWithSubagent) {
        const modeLabel = executionMode.permissionMode === "danger-full-access" ? "bypass" : "auto";
        ctx.ui?.notify?.(`Plan approved: subagent(${modeLabel})`, "info");
      }
      await approvePlan(pi, ctx, executionMode.permissionMode, executionMode.executeWithSubagent);
      return;
    }

    if (actionSelection.includes(REVIEW_LABEL)) {
      setState(pi, {
        ...state,
        approvalStatus: "pending",
        targetPermissionMode: undefined,
      });
      pi.sendUserMessage(buildReviewSteeringMessage(state.latestPlanPath ?? "the latest plan", readPlanArtifact(state.latestPlanPath ?? "")), {
        deliverAs: "steer",
      });
      return;
    }

    if (actionSelection.includes(REVISE_LABEL)) {
      enablePlanMode(pi, ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined, {
        approvalStatus: "revising",
      });
    }
  });

  pi.registerCommand("plan", {
    description: "Enable plan mode, or if already active re-show the current saved plan for review",
    async handler(args: string, ctx: ExtensionCommandContext) {
      if (isPlanModeActive()) {
        const planPath = state.latestPlanPath;
        const planMarkdown = planPath ? readPlanArtifact(planPath) : undefined;
        if (planPath && planMarkdown) {
          pi.sendMessage({
            customType: "plan-mode-preview",
            content: buildPlanPreviewMessage(planPath, planMarkdown),
            display: true,
          });
          ctx.ui.notify("Presented the current plan again.", "info");
          return;
        }

        ctx.ui.notify("Plan mode is already active. No saved plan artifact is available yet.", "info");
        return;
      }

      ensurePlanDir();
      const task = args.trim();
      await enablePlanModeWithModelSwitch(pi, ctx, ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined, {
        task,
        latestPlanPath: undefined,
        approvalStatus: "pending",
        targetPermissionMode: undefined,
      });
      const reasoningModel = readAutoSwitchPlanModelSetting() ? readPlanModeReasoningModel() : undefined;
      ctx.ui.notify(
        task
          ? `Plan mode enabled${reasoningModel ? ` · ${reasoningModel.split("/")[1] ?? reasoningModel}` : ""}. Current task: ${task}`
          : `Plan mode enabled${reasoningModel ? ` · ${reasoningModel.split("/")[1] ?? reasoningModel}` : ""}. Investigation is allowed; source changes stay blocked until you exit plan mode.`,
        "info",
      );
    },
  });

  pi.registerCommand("execute", {
    description: "Exit plan mode after review and allow execution to proceed",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      if (!isPlanModeActive()) {
        ctx.ui.notify("Plan mode is not active.", "info");
        return;
      }
      await approvePlan(pi, ctx, DEFAULT_APPROVAL_PERMISSION_MODE);
      ctx.ui.notify(`Plan approved. Permission mode switched to ${DEFAULT_APPROVAL_PERMISSION_MODE}.`, "info");
    },
  });

  pi.registerCommand("cancel-plan", {
    description: "Cancel the current plan-mode session without executing",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      if (isPlanModeActive()) {
        await cancelPlan(pi, ctx, true);
      } else {
        resetState(pi, { approvalStatus: "cancelled" });
      }
      ctx.ui.notify("Plan mode cancelled.", "info");
    },
  });

  // Internal command — called by scheduleNewSession() via pi.executeSlashCommand().
  // Runs in ExtensionCommandContext so ctx.newSession() is available.
  pi.registerCommand("plan-execute-new-session", {
    description: "Internal: execute approved plan in a new session with the coding model",
    async handler(_args: string, ctx: ExtensionCommandContext) {
      const payload = pendingNewSession;
      pendingNewSession = null;
      if (!payload) return;

      // Switch to coding model first
      if (payload.codingModelRef) {
        await setModelIfNeeded(pi, ctx, payload.codingModelRef);
      }

      const result = await ctx.newSession();
      if (result.cancelled) return;

      // Inject plan into the new session as a steer message
      const parts: string[] = [
        `Plan approved. You are acting as the ${payload.codingSubagent} agent. Implement the following plan now without re-investigating or re-planning.`,
      ];
      if (payload.task) parts.push(`Original task: ${payload.task}`);
      if (payload.planPath) parts.push(`Plan artifact: ${payload.planPath}`);
      if (payload.planContent) {
        parts.push(`Full plan:\n\`\`\`markdown\n${payload.planContent}\n\`\`\``);
      } else if (payload.planPath) {
        parts.push(`Read the plan from ${payload.planPath} before starting.`);
      }
      pi.sendUserMessage(parts.join("\n\n"), { deliverAs: "steer" });
    },
  });
}
