import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { getAgentDir, getPermissionMode, isToolCallEventType, setPermissionMode, type ExtensionAPI, type ExtensionCommandContext, type PermissionMode } from "@gsd/pi-coding-agent";
import { join } from "node:path";

const PLAN_ENTRY_TYPE = "plan-mode-state";
const PLAN_APPROVAL_QUESTION_ID = "plan_mode_approval";
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
const APPROVE_AUTO_LABEL = "Approve & switch to Auto mode";
const APPROVE_BYPASS_LABEL = "Approve & switch to Bypass mode";
const REVISE_LABEL = "Revise plan";
const CANCEL_LABEL = "Cancel";

type PlanApprovalStatus = "pending" | "approved" | "revising" | "cancelled";
type RestorablePermissionMode = Exclude<PermissionMode, "plan">;
type ModelRef = { provider: string; id: string };

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

export function readPlanModeReasoningModel(): string | undefined {
  try {
    const settingsPath = join(getAgentDir(), "settings.json");
    if (!existsSync(settingsPath)) return undefined;
    const raw = readFileSync(settingsPath, "utf-8");
    const parsed = JSON.parse(raw) as { planModeReasoningModel?: unknown };
    const model = parseQualifiedModelRef(parsed.planModeReasoningModel);
    return model ? `${model.provider}/${model.id}` : undefined;
  } catch {
    return undefined;
  }
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

async function setModelIfNeeded(pi: ExtensionAPI, ctx: any, modelRef: ModelRef | undefined): Promise<void> {
  if (!modelRef) return;
  const currentModel = parseQualifiedModelRef(ctx?.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
  if (sameModel(currentModel, modelRef)) return;
  const model = resolveModelFromContext(ctx, modelRef);
  if (!model) return;
  await pi.setModel(model, { persist: false });
}

async function approvePlan(pi: ExtensionAPI, ctx: any, permissionMode: RestorablePermissionMode): Promise<void> {
  const reasoningModel = parseQualifiedModelRef(readPlanModeReasoningModel());
  if (reasoningModel) {
    await setModelIfNeeded(pi, ctx, reasoningModel);
  }

  state = {
    ...state,
    targetPermissionMode: permissionMode,
  };
  leavePlanMode(pi, "approved", permissionMode);
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
    "Do not modify source files or run side-effect commands while plan mode is active.",
    "Persist plan artifacts under .lsd/plan/.",
  ];
  if (state.task) details.push(`Current task: ${state.task}`);
  if (state.latestPlanPath) details.push(`Latest plan artifact: ${state.latestPlanPath}`);
  return details.join(" ");
}

function buildApprovalSteeringMessage(planPath: string): string {
  return [
    `Plan artifact saved at ${planPath}.`,
    "Present approval options now using ask_user_questions with exactly one single-select question.",
    `Use question id \"${PLAN_APPROVAL_QUESTION_ID}\" and ask the user what to do next.`,
    "Important: ask_user_questions single-select supports only 2-3 explicit options.",
    "Use exactly these 3 options:",
    `1. ${APPROVE_AUTO_LABEL} (Recommended)`,
    `2. ${APPROVE_BYPASS_LABEL}`,
    `3. ${REVISE_LABEL}`,
    `Do not include \"${CANCEL_LABEL}\" as an explicit option. If the user wants to cancel, they should choose \"None of the above\" and type \"${CANCEL_LABEL}\" in the free-text note.`,
    "If the dialog is dismissed or the user gives no answer, continue planning.",
  ].join(" ");
}

function approvalSelectionToPermissionMode(selected: string): RestorablePermissionMode | undefined {
  if (selected.includes(APPROVE_AUTO_LABEL)) return "auto";
  if (selected.includes(APPROVE_BYPASS_LABEL)) return "danger-full-access";
  return undefined;
}

function selectionRequestsCancel(selected: string | string[]): boolean {
  const values = Array.isArray(selected) ? selected : [selected];
  return values.some((value) => {
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
};

export default function planCommand(pi: ExtensionAPI) {
  pi.registerFlag("plan", {
    description: "Start the session in plan mode and require a persisted .lsd/plan markdown plan before execution",
    type: "boolean",
  });

  pi.on("session_start", async (_event, ctx) => {
    restoreStateFromSession(ctx);
    startedFromFlag = false;
    if (state.active) {
      setPermissionModeAndEnv("plan");
    }
  });

  pi.on("before_agent_start", async () => {
    if (!isPlanModeActive()) return;
    return {
      systemPrompt: buildPlanModeSystemPrompt(),
    };
  });

  pi.on("input", async (event, ctx) => {
    const planFlag = pi.getFlag("plan");
    if (startedFromFlag || planFlag !== true || event.source !== "interactive") {
      return { action: "continue" as const };
    }

    startedFromFlag = true;
    ensurePlanDir();
    enablePlanMode(pi, ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined, {
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

        pi.sendUserMessage(buildApprovalSteeringMessage(path), { deliverAs: "steer" });
      }
      return;
    }

    if (!isPlanModeActive() || event.toolName !== "ask_user_questions") return;

    const details = event.details as {
      cancelled?: boolean;
      response?: { answers?: Record<string, { selected: string | string[]; notes?: string }> };
    } | undefined;
    if (details?.cancelled || !details?.response?.answers) return;

    const answer = details.response.answers[PLAN_APPROVAL_QUESTION_ID];
    if (!answer) return;

    const selected = Array.isArray(answer.selected) ? answer.selected : [answer.selected];
    if (!selected.every((value) => typeof value === "string")) return;

    const targetPermissionMode = approvalSelectionToPermissionMode(selected[0]);
    if (targetPermissionMode) {
      state = {
        ...state,
        targetPermissionMode,
      };
      await approvePlan(pi, ctx, targetPermissionMode);
      return;
    }

    if (selected.some((value) => value.includes(REVISE_LABEL))) {
      enablePlanMode(pi, ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined, {
        approvalStatus: "revising",
      });
      return;
    }

    if (selectionRequestsCancel(selected)) {
      await cancelPlan(pi, ctx, true);
    }
  });

  pi.registerCommand("plan", {
    description: "Toggle plan mode. While active, only investigative tools and writes under .lsd/plan/ are allowed",
    async handler(args: string, ctx: ExtensionCommandContext) {
      if (isPlanModeActive()) {
        await cancelPlan(pi, ctx, true);
        ctx.ui.notify("Plan mode disabled.", "info");
        return;
      }

      ensurePlanDir();
      const task = args.trim();
      enablePlanMode(pi, ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined, {
        task,
        latestPlanPath: undefined,
        approvalStatus: "pending",
        targetPermissionMode: undefined,
      });
      ctx.ui.notify(
        task
          ? `Plan mode enabled. Current task: ${task}`
          : "Plan mode enabled. Investigation is allowed; source changes stay blocked until you exit plan mode.",
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
}
