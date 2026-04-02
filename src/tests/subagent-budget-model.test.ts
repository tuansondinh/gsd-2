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
	it('resolves $budget_model from settings and normalizes it to provider/id', () => {
		const result = resolveConfiguredSubagentModel(
			agent({ model: '$budget_model' }),
			{ subagent: { budget_model: 'google/gemini-2.5-flash' } },
			'claude-haiku-4-5',
		)

		assert.equal(result, 'anthropic/claude-haiku-4-5')
	})

	it('falls back to preferences when settings are empty', () => {
		const result = resolveConfiguredSubagentModel(
			agent({ model: '$budget_model' }),
			{ subagent: { budget_model: 'gemini-2.5-flash' } },
			'   ',
		)
		assert.equal(result, 'google/gemini-2.5-flash')
	})

	it('falls back to undefined when budget model is not configured', () => {
		const result = resolveConfiguredSubagentModel(agent({ model: '$budget_model' }), {}, undefined)
		assert.equal(result, undefined)
	})

	it('returns undefined for malformed configured budget models', () => {
		const result = resolveConfiguredSubagentModel(agent({ model: '$budget_model' }), {}, 'not/a/valid/model')
		assert.equal(result, undefined)
	})

	it('normalizes explicit non-placeholder models', () => {
		const result = resolveConfiguredSubagentModel(
			agent({ model: 'claude-sonnet-4-6' }),
			{ subagent: { budget_model: 'claude-haiku-4-5' } },
			'claude-haiku-4-5',
		)

		assert.equal(result, 'anthropic/claude-sonnet-4-6')
	})
})
