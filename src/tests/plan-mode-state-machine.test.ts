import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { setPermissionMode, getPermissionMode } from '@gsd/pi-coding-agent'

interface MockPi {
  handlers: Record<string, Function>
  commands: Record<string, { handler: (args: string, ctx: any) => Promise<void> }>
  entries: Array<{ type: string; data: unknown }>
  sentMessages: string[]
  sentUserMessageDeliveries: Array<{ text: string; deliverAs?: 'steer' | 'followUp' }>
  customMessages: Array<{ customType: string; content: string; display?: boolean }>
  modelSwitches: string[]
  flagValue: boolean
  on(event: string, handler: Function): void
  registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }): void
  registerFlag(_name: string, _config: unknown): void
  appendEntry<T>(type: string, data?: T): void
  sendMessage(message: { customType: string; content: string; display?: boolean }): void
  sendUserMessage(
    content: string | Array<{ type: string; text?: string }>,
    options?: { deliverAs?: 'steer' | 'followUp' },
  ): void
  getFlag(_name: string): boolean
  setModel(model: { provider: string; id: string }): Promise<boolean>
}

function makeMockPi(): MockPi {
  return {
    handlers: {},
    commands: {},
    entries: [],
    sentMessages: [],
    sentUserMessageDeliveries: [],
    customMessages: [],
    modelSwitches: [],
    flagValue: false,
    on(event, handler) {
      this.handlers[event] = handler
    },
    registerCommand(name, command) {
      this.commands[name] = command
    },
    registerFlag() {},
    appendEntry(type, data) {
      this.entries.push({ type, data })
    },
    sendMessage(message) {
      this.customMessages.push(message)
    },
    sendUserMessage(content, options) {
      const text =
        typeof content === 'string'
          ? content
          : content.map((item) => item.text ?? '').join('\n')
      this.sentMessages.push(text)
      this.sentUserMessageDeliveries.push({ text, deliverAs: options?.deliverAs })
    },
    getFlag() {
      return this.flagValue
    },
    async setModel(model) {
      this.modelSwitches.push(`${model.provider}/${model.id}`)
      return true
    },
  }
}

function makeCtx(overrides: Partial<any> = {}): any {
  const models = overrides.models ?? [
    { provider: 'openai', id: 'gpt-5.4' },
    { provider: 'openai', id: 'gpt-5.4-mini' },
    { provider: 'anthropic', id: 'claude-sonnet-4-6' },
    { provider: 'google', id: 'gemini-2.5-pro' },
  ]

  const ctx: any = {
    hasUI: true,
    model: overrides.model,
    modelRegistry: {
      getAll: () => models,
    },
    ui: {
      notifyCalls: [] as Array<{ message: string; type?: string }>,
      notify(message: string, type?: string) {
        this.notifyCalls.push({ message, type })
      },
    },
    sessionManager: {
      getEntries: () => [],
    },
    ...overrides,
  }

  return ctx
}

function makeAskUserDetails(
  action?: string | string[],
  permission?: string | string[],
  cancelled = false,
  actionNotes?: string,
) {
  if (cancelled) return { cancelled: true }
  if (!action && !permission) return { response: { answers: {} } }
  return {
    response: {
      answers: {
        ...(action
          ? {
              plan_mode_approval_action: {
                selected: action,
                ...(actionNotes ? { notes: actionNotes } : {}),
              },
            }
          : {}),
        ...(permission
          ? {
              plan_mode_approval_permission: {
                selected: permission,
              },
            }
          : {}),
      },
    },
  }
}

test('plan mode presents the saved plan and approval options before approval', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'plan-mode-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const oldAgentDir = process.env.LSD_CODING_AGENT_DIR
  process.env.LSD_CODING_AGENT_DIR = tmp
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(tmp, 'settings.json'), JSON.stringify({}))
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.LSD_CODING_AGENT_DIR
    else process.env.LSD_CODING_AGENT_DIR = oldAgentDir
  })

  const planModule = await import('../resources/extensions/slash-commands/plan.ts')
  const planCommand = planModule.default
  const testing = planModule.__testing
  testing.resetState()
  setPermissionMode('accept-on-edit')

  const pi = makeMockPi()
  planCommand(pi as any)

  const preplanModel = { provider: 'openai', id: 'gpt-5.4' }
  const ctx = makeCtx({ model: preplanModel })
  await pi.commands.plan.handler('Ship phase 4', ctx)

  const planPath = '.lsd/plan/PLAN-3.md'
  mkdirSync('.lsd/plan', { recursive: true })
  writeFileSync(planPath, '# Plan\n\n- Step 1\n- Step 2\n')

  await pi.handlers.tool_result(
    { toolName: 'write', input: { path: planPath } },
    ctx,
  )

  assert.equal(pi.customMessages.length, 1)
  assert.equal(pi.customMessages[0]?.customType, 'plan-mode-preview')
  assert.match(pi.customMessages[0]?.content ?? '', /Current plan artifact: \.lsd\/plan\/PLAN-3\.md/)
  assert.match(pi.customMessages[0]?.content ?? '', /# Plan/)
  assert.match(pi.customMessages[0]?.content ?? '', /run \/execute to approve/i)

  const lastMessage = pi.sentMessages.at(-1) ?? ''
  assert.match(lastMessage, /do not restate the plan in a normal assistant response/i)
  assert.match(lastMessage, /ask for plan approval now via.*ask_user_questions/i)
  assert.match(lastMessage, /Approve plan \(Recommended\)/)
  assert.match(lastMessage, /Let other agent review/)
  assert.match(lastMessage, /Revise plan/)
  assert.match(lastMessage, /Auto mode \(Recommended\)/)
  assert.match(lastMessage, /Bypass mode/)
  assert.doesNotMatch(lastMessage, /# Plan/)
  assert.doesNotMatch(lastMessage, /4\./)
  assert.deepEqual(ctx.ui.notifyCalls.at(-1), {
    message: '/plan to show plan',
    type: 'info',
  })
})

test('re-running /plan while plan mode is active re-shows the saved plan instead of disabling plan mode', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'plan-mode-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const oldAgentDir = process.env.LSD_CODING_AGENT_DIR
  process.env.LSD_CODING_AGENT_DIR = tmp
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(tmp, 'settings.json'), JSON.stringify({}))
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.LSD_CODING_AGENT_DIR
    else process.env.LSD_CODING_AGENT_DIR = oldAgentDir
  })

  const planModule = await import('../resources/extensions/slash-commands/plan.ts')
  const planCommand = planModule.default
  const testing = planModule.__testing
  testing.resetState()
  setPermissionMode('accept-on-edit')

  const pi = makeMockPi()
  planCommand(pi as any)

  const preplanModel = { provider: 'openai', id: 'gpt-5.4' }
  const ctx = makeCtx({ model: preplanModel })
  await pi.commands.plan.handler('Ship phase 4', ctx)

  const planPath = '.lsd/plan/PLAN-7.md'
  mkdirSync('.lsd/plan', { recursive: true })
  writeFileSync(planPath, '# Current Plan\n\n- Step A\n')

  await pi.handlers.tool_result(
    { toolName: 'write', input: { path: planPath } },
    ctx,
  )

  const messageCountBefore = pi.sentMessages.length
  await pi.commands.plan.handler('', ctx)

  assert.equal(getPermissionMode(), 'plan')
  assert.equal(testing.getState().active, true)
  assert.equal(pi.sentMessages.length, messageCountBefore)
  assert.equal(pi.customMessages.length, 2)
  assert.equal(pi.customMessages[0]?.customType, 'plan-mode-preview')
  assert.match(pi.customMessages[0]?.content ?? '', /# Current Plan/)
  assert.equal(pi.customMessages[1]?.customType, 'plan-mode-preview')
  assert.match(pi.customMessages[1]?.content ?? '', /# Current Plan/)
  assert.match(pi.customMessages[1]?.content ?? '', /run \/execute to approve/i)
  assert.deepEqual(ctx.ui.notifyCalls.at(-1), { message: 'Presented the current plan again.', type: 'info' })
})

test('plan mode enters with immediate reasoning-model switch when auto-switch is enabled', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'plan-mode-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const oldAgentDir = process.env.LSD_CODING_AGENT_DIR
  process.env.LSD_CODING_AGENT_DIR = tmp
  mkdirSync(tmp, { recursive: true })
  writeFileSync(
    join(tmp, 'settings.json'),
    JSON.stringify({
      autoSwitchPlanModel: true,
      planModeReasoningModel: 'anthropic/claude-sonnet-4-6',
    }),
  )
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.LSD_CODING_AGENT_DIR
    else process.env.LSD_CODING_AGENT_DIR = oldAgentDir
  })

  const planModule = await import('../resources/extensions/slash-commands/plan.ts')
  const planCommand = planModule.default
  const testing = planModule.__testing
  testing.resetState()
  setPermissionMode('accept-on-edit')

  const pi = makeMockPi()
  planCommand(pi as any)

  const preplanModel = { provider: 'openai', id: 'gpt-5.4' }
  const ctx = makeCtx({ model: preplanModel })

  await pi.commands.plan.handler('Immediate switch', ctx)
  assert.deepEqual(pi.modelSwitches, ['anthropic/claude-sonnet-4-6'])
  assert.equal(getPermissionMode(), 'plan')

  await pi.handlers.before_agent_start({}, makeCtx({ model: preplanModel }))
  assert.deepEqual(
    pi.modelSwitches,
    ['anthropic/claude-sonnet-4-6'],
    'before_agent_start should not perform the first switch redundantly when entry switch already happened',
  )
})

test('plan mode pending → approved switches to configured reasoning model and auto mode', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'plan-mode-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const oldAgentDir = process.env.LSD_CODING_AGENT_DIR
  process.env.LSD_CODING_AGENT_DIR = tmp
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ planModeReasoningModel: 'anthropic/claude-sonnet-4-6' }))
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.LSD_CODING_AGENT_DIR
    else process.env.LSD_CODING_AGENT_DIR = oldAgentDir
  })

  const planModule = await import('../resources/extensions/slash-commands/plan.ts')
  const planCommand = planModule.default
  const testing = planModule.__testing
  testing.resetState()
  setPermissionMode('accept-on-edit')

  const pi = makeMockPi()
  planCommand(pi as any)

  const preplanModel = { provider: 'openai', id: 'gpt-5.4' }
  await pi.commands.plan.handler('Ship phase 4', makeCtx({ model: preplanModel }))
  assert.equal(getPermissionMode(), 'plan')
  assert.deepEqual(testing.getState().preplanModel, preplanModel)

  const planPath = '.lsd/plan/PLAN-3.md'
  mkdirSync('.lsd/plan', { recursive: true })
  writeFileSync(planPath, '# Plan\n')

  await pi.handlers.tool_result(
    { toolName: 'write', input: { path: planPath } },
    makeCtx({ model: preplanModel }),
  )

  await pi.handlers.tool_result(
    {
      toolName: 'ask_user_questions',
      details: makeAskUserDetails('Approve plan', 'Auto mode'),
    },
    makeCtx({ model: preplanModel }),
  )

  assert.deepEqual(pi.modelSwitches, ['anthropic/claude-sonnet-4-6'])
  assert.equal(getPermissionMode(), 'auto')
  assert.equal(testing.getState().active, false)
  assert.equal(testing.getState().approvalStatus, 'approved')
  assert.equal(testing.getState().targetPermissionMode, 'auto')
  assert.match(pi.sentMessages.at(-1) ?? '', /Plan approved\. Exit plan mode and start implementation immediately\./)
  assert.match(pi.sentMessages.at(-1) ?? '', /Original task: Ship phase 4/)
  assert.match(pi.sentMessages.at(-1) ?? '', /\.lsd\/plan\/PLAN-3\.md/)
  assert.equal(
    pi.sentMessages.some((m) => m.includes('Now ask which execution mode to use via ask_user_questions')),
    false,
    'execution mode question should not be steered as a second ask_user_questions call',
  )
})

test('plan mode review option delegates to another agent with configured review model', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'plan-mode-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const oldAgentDir = process.env.LSD_CODING_AGENT_DIR
  process.env.LSD_CODING_AGENT_DIR = tmp
  mkdirSync(tmp, { recursive: true })
  writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ planModeReviewModel: 'google/gemini-2.5-pro' }))
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.LSD_CODING_AGENT_DIR
    else process.env.LSD_CODING_AGENT_DIR = oldAgentDir
  })

  const planModule = await import('../resources/extensions/slash-commands/plan.ts')
  const planCommand = planModule.default
  const testing = planModule.__testing
  testing.resetState()
  setPermissionMode('accept-on-edit')

  const pi = makeMockPi()
  planCommand(pi as any)

  const preplanModel = { provider: 'openai', id: 'gpt-5.4-mini' }
  await pi.commands.plan.handler('Review plan flow', makeCtx({ model: preplanModel }))

  const planPath = '.lsd/plan/PLAN-9.md'
  mkdirSync('.lsd/plan', { recursive: true })
  writeFileSync(planPath, '# Review Plan\n\n- Validate steps\n')

  await pi.handlers.tool_result(
    { toolName: 'write', input: { path: planPath } },
    makeCtx({ model: preplanModel }),
  )

  await pi.handlers.tool_result(
    {
      toolName: 'ask_user_questions',
      details: makeAskUserDetails('Let other agent review'),
    },
    makeCtx({ model: preplanModel }),
  )

  const lastMessage = pi.sentMessages.at(-1) ?? ''
  assert.equal(getPermissionMode(), 'plan')
  assert.equal(testing.getState().approvalStatus, 'pending')
  assert.match(lastMessage, /Delegate a read-only plan review to another agent now\./)
  assert.match(lastMessage, /agent "generic" and set model to "google\/gemini-2\.5-pro"/)
  assert.match(lastMessage, /# Review Plan/)
  assert.match(lastMessage, /ask for approval again/i)
})

test('plan mode pending → revising → pending → approved keeps preplan model and switches to bypass mode', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'plan-mode-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const oldAgentDir = process.env.LSD_CODING_AGENT_DIR
  process.env.LSD_CODING_AGENT_DIR = tmp
  writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ planModeReasoningModel: 'anthropic/claude-sonnet-4-6' }))
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.LSD_CODING_AGENT_DIR
    else process.env.LSD_CODING_AGENT_DIR = oldAgentDir
  })

  const planModule = await import('../resources/extensions/slash-commands/plan.ts')
  const planCommand = planModule.default
  const testing = planModule.__testing
  testing.resetState()
  setPermissionMode('accept-on-edit')

  const pi = makeMockPi()
  planCommand(pi as any)

  const preplanModel = { provider: 'openai', id: 'gpt-5.4-mini' }
  await pi.commands.plan.handler('Revise plan flow', makeCtx({ model: preplanModel }))

  const planPath = '.lsd/plan/PLAN-3.md'
  mkdirSync('.lsd/plan', { recursive: true })
  writeFileSync(planPath, '# Plan\n')

  await pi.handlers.tool_result(
    { toolName: 'write', input: { path: planPath } },
    makeCtx({ model: preplanModel }),
  )
  await pi.handlers.tool_result(
    {
      toolName: 'ask_user_questions',
      details: makeAskUserDetails('Revise plan'),
    },
    makeCtx({ model: preplanModel }),
  )

  assert.equal(testing.getState().approvalStatus, 'revising')
  assert.deepEqual(testing.getState().preplanModel, preplanModel)
  assert.equal(getPermissionMode(), 'plan')

  await pi.handlers.tool_result(
    { toolName: 'edit', input: { path: planPath } },
    makeCtx({ model: preplanModel }),
  )
  assert.equal(testing.getState().approvalStatus, 'pending')

  await pi.handlers.tool_result(
    {
      toolName: 'ask_user_questions',
      details: makeAskUserDetails('Approve plan', 'Bypass mode'),
    },
    makeCtx({ model: preplanModel }),
  )

  assert.deepEqual(pi.modelSwitches, ['anthropic/claude-sonnet-4-6'])
  assert.equal(getPermissionMode(), 'danger-full-access')
  assert.equal(testing.getState().approvalStatus, 'approved')
  assert.equal(testing.getState().targetPermissionMode, 'danger-full-access')
  assert.match(pi.sentMessages.at(-1) ?? '', /Plan approved\. Exit plan mode and start implementation immediately\./)
})

test('plan mode pending → cancelled restores preplan model and original permission mode', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'plan-mode-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const oldAgentDir = process.env.LSD_CODING_AGENT_DIR
  process.env.LSD_CODING_AGENT_DIR = tmp
  writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ planModeReasoningModel: 'anthropic/claude-sonnet-4-6' }))
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.LSD_CODING_AGENT_DIR
    else process.env.LSD_CODING_AGENT_DIR = oldAgentDir
  })

  const planModule = await import('../resources/extensions/slash-commands/plan.ts')
  const planCommand = planModule.default
  const testing = planModule.__testing
  testing.resetState()
  setPermissionMode('auto')

  const pi = makeMockPi()
  planCommand(pi as any)

  const preplanModel = { provider: 'openai', id: 'gpt-5.4' }
  await pi.commands.plan.handler('Cancel plan', makeCtx({ model: preplanModel }))

  const planPath = '.lsd/plan/PLAN-3.md'
  mkdirSync('.lsd/plan', { recursive: true })
  writeFileSync(planPath, '# Plan\n')

  await pi.handlers.tool_result(
    { toolName: 'write', input: { path: planPath } },
    makeCtx({ model: preplanModel }),
  )

  await pi.handlers.tool_result(
    {
      toolName: 'ask_user_questions',
      details: makeAskUserDetails(['None of the above'], undefined, false, 'Cancel'),
    },
    makeCtx({ model: { provider: 'anthropic', id: 'claude-sonnet-4-6' } }),
  )

  assert.equal(getPermissionMode(), 'auto')
  assert.deepEqual(pi.modelSwitches, ['openai/gpt-5.4'])
  assert.equal(testing.getState().active, false)
  assert.equal(testing.getState().approvalStatus, 'cancelled')
  assert.equal(testing.getState().task, '')
})

test('plan mode non-interactive plan write auto-approves with default auto mode and skips duplicate model switch', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'plan-mode-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const oldAgentDir = process.env.LSD_CODING_AGENT_DIR
  process.env.LSD_CODING_AGENT_DIR = tmp
  writeFileSync(join(tmp, 'settings.json'), JSON.stringify({ planModeReasoningModel: 'openai/gpt-5.4' }))
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.LSD_CODING_AGENT_DIR
    else process.env.LSD_CODING_AGENT_DIR = oldAgentDir
  })

  const planModule = await import('../resources/extensions/slash-commands/plan.ts')
  const planCommand = planModule.default
  const testing = planModule.__testing
  testing.resetState()
  setPermissionMode('accept-on-edit')

  const pi = makeMockPi()
  planCommand(pi as any)

  const currentModel = { provider: 'openai', id: 'gpt-5.4' }
  await pi.commands.plan.handler('Headless approve', makeCtx({ model: currentModel }))

  const planPath = '.lsd/plan/PLAN-3.md'
  mkdirSync('.lsd/plan', { recursive: true })
  writeFileSync(planPath, '# Plan\n')

  await pi.handlers.tool_result(
    { toolName: 'write', input: { path: planPath } },
    makeCtx({ hasUI: false, model: currentModel }),
  )

  assert.deepEqual(pi.modelSwitches, [])
  assert.equal(getPermissionMode(), 'auto')
  assert.equal(testing.getState().approvalStatus, 'approved')
  assert.match(pi.sentMessages.at(-1) ?? '', /Plan approved\. Exit plan mode and start implementation immediately\./)
})

test('plan mode subagent-auto approval uses configured planModeCodingSubagent with planModeCodingModel', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'plan-mode-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const oldAgentDir = process.env.LSD_CODING_AGENT_DIR
  process.env.LSD_CODING_AGENT_DIR = tmp
  mkdirSync(tmp, { recursive: true })
  writeFileSync(
    join(tmp, 'settings.json'),
    JSON.stringify({
      planModeCodingModel: 'anthropic/claude-sonnet-4-6',
      planModeCodingSubagent: 'generic',
    }),
  )
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.LSD_CODING_AGENT_DIR
    else process.env.LSD_CODING_AGENT_DIR = oldAgentDir
  })

  const planModule = await import('../resources/extensions/slash-commands/plan.ts')
  const planCommand = planModule.default
  const testing = planModule.__testing
  testing.resetState()
  setPermissionMode('accept-on-edit')

  const pi = makeMockPi()
  planCommand(pi as any)

  const preplanModel = { provider: 'openai', id: 'gpt-5.4' }
  await pi.commands.plan.handler('Implement sum function', makeCtx({ model: preplanModel }))

  const planPath = '.lsd/plan/PLAN-subagent-auto.md'
  mkdirSync('.lsd/plan', { recursive: true })
  writeFileSync(planPath, '# Plan\n\n- Step 1\n')

  await pi.handlers.tool_result(
    { toolName: 'write', input: { path: planPath } },
    makeCtx({ model: preplanModel }),
  )

  await pi.handlers.tool_result(
    {
      toolName: 'ask_user_questions',
      details: makeAskUserDetails('Approve plan', 'Execute with subagent in auto mode'),
    },
    makeCtx({ model: preplanModel }),
  )

  assert.equal(getPermissionMode(), 'auto')
  assert.equal(testing.getState().active, false)
  assert.equal(testing.getState().approvalStatus, 'approved')
  assert.equal(testing.getState().targetPermissionMode, 'auto')

  const kickoff = pi.sentMessages.at(-1) ?? ''
  assert.match(kickoff, /Plan approved\. Exit plan mode and execute the approved plan with a subagent now\./)
  // codingModel must be embedded directly in the invocation instruction as a tool parameter
  assert.match(kickoff, /agent "generic" and model="anthropic\/claude-sonnet-4-6"/)
  // must NOT fall back to the old loose "Set model to" pattern
  assert.doesNotMatch(kickoff, /Set model to/)
  assert.match(kickoff, /Execution permission mode is now "auto"/)
  assert.match(kickoff, /PLAN-subagent-auto\.md/)
  assert.ok(pi.sentMessages.some(m => m.includes('generic')))
  // The kickoff MUST be steered (not delivered as a follow-up). Otherwise the
  // LLM continues the same turn after the dialog answer and calls the
  // subagent tool with the default session model BEFORE it ever sees the
  // explicit model="<planModeCodingModel>" instruction in the kickoff.
  const lastDelivery = pi.sentUserMessageDeliveries.at(-1)
  assert.equal(lastDelivery?.deliverAs, 'steer', 'plan-mode kickoff must be delivered as a steer message so the configured planModeCodingModel reaches the subagent invocation before the LLM calls the tool')
})

test('plan mode subagent-bypass approval honors configured planModeCodingAgent alias with planModeCodingModel', async (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'plan-mode-test-'))
  t.after(() => rmSync(tmp, { recursive: true, force: true }))

  const oldAgentDir = process.env.LSD_CODING_AGENT_DIR
  process.env.LSD_CODING_AGENT_DIR = tmp
  mkdirSync(tmp, { recursive: true })
  writeFileSync(
    join(tmp, 'settings.json'),
    JSON.stringify({
      planModeCodingModel: 'anthropic/claude-sonnet-4-6',
      planModeCodingAgent: 'generic',
    }),
  )
  t.after(() => {
    if (oldAgentDir === undefined) delete process.env.LSD_CODING_AGENT_DIR
    else process.env.LSD_CODING_AGENT_DIR = oldAgentDir
  })

  const planModule = await import('../resources/extensions/slash-commands/plan.ts')
  const planCommand = planModule.default
  const testing = planModule.__testing
  testing.resetState()
  setPermissionMode('accept-on-edit')

  const pi = makeMockPi()
  planCommand(pi as any)

  const preplanModel = { provider: 'openai', id: 'gpt-5.4' }
  await pi.commands.plan.handler('Implement sum function', makeCtx({ model: preplanModel }))

  const planPath = '.lsd/plan/PLAN-subagent-bypass.md'
  mkdirSync('.lsd/plan', { recursive: true })
  writeFileSync(planPath, '# Plan\n\n- Step 1\n')

  await pi.handlers.tool_result(
    { toolName: 'write', input: { path: planPath } },
    makeCtx({ model: preplanModel }),
  )

  await pi.handlers.tool_result(
    {
      toolName: 'ask_user_questions',
      details: makeAskUserDetails('Approve plan', 'Execute with subagent in bypass mode'),
    },
    makeCtx({ model: preplanModel }),
  )

  assert.equal(getPermissionMode(), 'danger-full-access')
  assert.equal(testing.getState().active, false)
  assert.equal(testing.getState().approvalStatus, 'approved')
  assert.equal(testing.getState().targetPermissionMode, 'danger-full-access')

  const kickoff = pi.sentMessages.at(-1) ?? ''
  assert.match(kickoff, /Plan approved\. Exit plan mode and execute the approved plan with a subagent now\./)
  // codingModel must be embedded directly in the invocation instruction as a tool parameter
  assert.match(kickoff, /agent "generic" and model="anthropic\/claude-sonnet-4-6"/)
  // must NOT fall back to the old loose "Set model to" pattern
  assert.doesNotMatch(kickoff, /Set model to/)
  assert.match(kickoff, /Execution permission mode is now "danger-full-access"/)
  assert.match(kickoff, /PLAN-subagent-bypass\.md/)
  assert.ok(pi.sentMessages.some(m => m.includes('generic')))
})

// ─── Auto-suggest plan mode tests (system-prompt approach) ────────────────────

test('auto-suggest plan mode off: buildAutoSuggestPlanModeSystemPrompt returns correct wording', async () => {
  const { buildAutoSuggestPlanModeSystemPrompt } = (await import('../resources/extensions/slash-commands/plan.ts')).__testing
  const prompt = buildAutoSuggestPlanModeSystemPrompt()
  assert.match(prompt, /plan mode/i)
  assert.match(prompt, /\/plan/)
  assert.match(prompt, /large|multi-step|refactor|migration/i)
})

test('auto-suggest readAutoSuggestPlanModeSetting returns false when settings file is missing', async () => {
  const { readAutoSuggestPlanModeSetting } = (await import('../resources/extensions/slash-commands/plan.ts')).__testing
  const tmp = mkdtempSync(join(tmpdir(), 'lsd-plan-test-'))
  const oldAgentDir = process.env.LSD_CODING_AGENT_DIR
  process.env.LSD_CODING_AGENT_DIR = join(tmp, 'nonexistent')
  try {
    assert.equal(readAutoSuggestPlanModeSetting(), false)
  } finally {
    if (oldAgentDir !== undefined) process.env.LSD_CODING_AGENT_DIR = oldAgentDir
    else delete process.env.LSD_CODING_AGENT_DIR
    rmSync(tmp, { recursive: true, force: true })
  }
})
