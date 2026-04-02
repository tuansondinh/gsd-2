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
  modelSwitches: string[]
  flagValue: boolean
  on(event: string, handler: Function): void
  registerCommand(name: string, command: { handler: (args: string, ctx: any) => Promise<void> }): void
  registerFlag(_name: string, _config: unknown): void
  appendEntry<T>(type: string, data?: T): void
  sendUserMessage(content: string | Array<{ type: string; text?: string }>): void
  getFlag(_name: string): boolean
  setModel(model: { provider: string; id: string }): Promise<boolean>
}

function makeMockPi(): MockPi {
  return {
    handlers: {},
    commands: {},
    entries: [],
    sentMessages: [],
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
    sendUserMessage(content) {
      if (typeof content === 'string') {
        this.sentMessages.push(content)
        return
      }
      this.sentMessages.push(content.map((item) => item.text ?? '').join('\n'))
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
  ]

  return {
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
}

function makeAskUserDetails(selected?: string | string[], cancelled = false) {
  if (cancelled) return { cancelled: true }
  if (!selected) return { response: { answers: {} } }
  return {
    response: {
      answers: {
        plan_mode_approval: {
          selected,
        },
      },
    },
  }
}

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

  await pi.handlers.tool_result(
    { toolName: 'write', input: { path: '.lsd/plan/PLAN-3.md' } },
    makeCtx({ model: preplanModel }),
  )
  assert.match(pi.sentMessages.at(-1) ?? '', /Approve & switch to Auto mode/)
  assert.match(pi.sentMessages.at(-1) ?? '', /ask_user_questions/)
  assert.match(pi.sentMessages.at(-1) ?? '', /single-select supports only 2-3 explicit options/)
  assert.doesNotMatch(pi.sentMessages.at(-1) ?? '', /4\. Cancel/)

  await pi.handlers.tool_result(
    { toolName: 'ask_user_questions', details: makeAskUserDetails('Approve & switch to Auto mode') },
    makeCtx({ model: preplanModel }),
  )

  assert.deepEqual(pi.modelSwitches, ['anthropic/claude-sonnet-4-6'])
  assert.equal(getPermissionMode(), 'auto')
  assert.equal(testing.getState().active, false)
  assert.equal(testing.getState().approvalStatus, 'approved')
  assert.equal(testing.getState().targetPermissionMode, 'auto')
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
  await pi.handlers.tool_result(
    { toolName: 'write', input: { path: '.lsd/plan/PLAN-3.md' } },
    makeCtx({ model: preplanModel }),
  )
  await pi.handlers.tool_result(
    { toolName: 'ask_user_questions', details: makeAskUserDetails('Revise plan') },
    makeCtx({ model: preplanModel }),
  )

  assert.equal(testing.getState().approvalStatus, 'revising')
  assert.deepEqual(testing.getState().preplanModel, preplanModel)
  assert.equal(getPermissionMode(), 'plan')

  await pi.handlers.tool_result(
    { toolName: 'edit', input: { path: '.lsd/plan/PLAN-3.md' } },
    makeCtx({ model: preplanModel }),
  )
  assert.equal(testing.getState().approvalStatus, 'pending')

  await pi.handlers.tool_result(
    { toolName: 'ask_user_questions', details: makeAskUserDetails('Approve & switch to Bypass mode') },
    makeCtx({ model: preplanModel }),
  )

  assert.deepEqual(pi.modelSwitches, ['anthropic/claude-sonnet-4-6'])
  assert.equal(getPermissionMode(), 'danger-full-access')
  assert.equal(testing.getState().approvalStatus, 'approved')
  assert.equal(testing.getState().targetPermissionMode, 'danger-full-access')
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
  await pi.handlers.tool_result(
    { toolName: 'write', input: { path: '.lsd/plan/PLAN-3.md' } },
    makeCtx({ model: preplanModel }),
  )

  await pi.handlers.tool_result(
    { toolName: 'ask_user_questions', details: makeAskUserDetails(['None of the above', 'user_note: Cancel']) },
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
  await pi.handlers.tool_result(
    { toolName: 'write', input: { path: '.lsd/plan/PLAN-3.md' } },
    makeCtx({ hasUI: false, model: currentModel }),
  )

  assert.deepEqual(pi.modelSwitches, [])
  assert.equal(getPermissionMode(), 'auto')
  assert.equal(testing.getState().approvalStatus, 'approved')
})
