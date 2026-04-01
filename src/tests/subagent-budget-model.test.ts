import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfiguredSubagentModel } from '../resources/extensions/subagent/configured-model.ts'
import type { AgentConfig } from '../resources/extensions/subagent/agents.ts'

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    name: 'scout',
    description: 'Scout agent',
    systemPrompt: 'test',
    source: 'user',
    filePath: '/tmp/scout.md',
    ...overrides,
  }
}

describe('resolveConfiguredSubagentModel', () => {
  it('resolves $budget_model from preferences', () => {
    const result = resolveConfiguredSubagentModel(
      agent({ model: '$budget_model' }),
      { subagent: { budget_model: 'claude-haiku-4-5-20250414' } },
      'claude-haiku-4-5-20250414',
    )

    assert.equal(result, 'claude-haiku-4-5-20250414')
  })

  it('falls back to undefined when budget model is not configured', () => {
    const result = resolveConfiguredSubagentModel(agent({ model: '$budget_model' }), {}, undefined)
    assert.equal(result, undefined)
  })

  it('keeps explicit non-placeholder models unchanged', () => {
    const result = resolveConfiguredSubagentModel(
      agent({ model: 'claude-sonnet-4-6' }),
      { subagent: { budget_model: 'claude-haiku-4-5-20250414' } },
      'claude-haiku-4-5-20250414',
    )

    assert.equal(result, 'claude-sonnet-4-6')
  })
})
