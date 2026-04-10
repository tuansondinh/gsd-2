import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = join(fileURLToPath(import.meta.url), '..', '..', '..')

test('background subagent jobs retain session metadata for /agent switching', () => {
  const typesSrc = readFileSync(
    join(projectRoot, 'src', 'resources', 'extensions', 'subagent', 'background-types.ts'),
    'utf-8',
  )
  const managerSrc = readFileSync(
    join(projectRoot, 'src', 'resources', 'extensions', 'subagent', 'background-job-manager.ts'),
    'utf-8',
  )

  assert.ok(typesSrc.includes('sessionFile?: string;'), 'background job type includes session file')
  assert.ok(typesSrc.includes('parentSessionFile?: string;'), 'background job type includes parent session file')
  assert.ok(managerSrc.includes('job.sessionFile = sessionFile;'), 'manager persists session file from result payload')
  assert.ok(managerSrc.includes('job.parentSessionFile = parentSessionFile;'), 'manager persists parent session file from result payload')
})

test('background runner forwards session metadata from runSingleAgent', () => {
  const runnerSrc = readFileSync(
    join(projectRoot, 'src', 'resources', 'extensions', 'subagent', 'background-runner.ts'),
    'utf-8',
  )

  assert.ok(runnerSrc.includes('sessionFile: result.sessionFile,'), 'runner forwards sessionFile')
  assert.ok(runnerSrc.includes('parentSessionFile: result.parentSessionFile,'), 'runner forwards parentSessionFile')
})

test('subagent extension captures explicit session-info events and can backfill /agent links from persisted sessions', () => {
  const indexSrc = readFileSync(join(projectRoot, 'src', 'resources', 'extensions', 'subagent', 'index.ts'), 'utf-8')
  const printModeSrc = readFileSync(join(projectRoot, 'packages', 'pi-coding-agent', 'src', 'modes', 'print-mode.ts'), 'utf-8')

  assert.ok(printModeSrc.includes('type: "subagent_session_info"'), 'print mode emits explicit subagent session metadata')
  assert.ok(indexSrc.includes('if (event.type === "subagent_session_info") {'), 'subagent runner captures explicit session-info events')
  assert.ok(indexSrc.includes('applyCurrentSessionSubagentTools(ctx);'), 'subagent extension reapplies subagent tool context on session start/switch')
  assert.ok(indexSrc.includes('Do not spawn or delegate to another subagent with the same name as yourself.'), 'subagent extension prevents recursive self-spawning on resumed subagent sessions')
  assert.ok(indexSrc.includes('Attached to running subagent'), 'subagent switching supports live attach messaging for running targets')
  assert.ok(indexSrc.includes('Prompts in this session are routed live (busy => steer, idle => prompt).'), 'live attach explains input routing semantics')
  assert.ok(indexSrc.includes('pi.on("input", async (event, ctx) => {'), 'extension intercepts input events for live-attached sessions')
  assert.ok(indexSrc.includes('if (runtime.isBusy()) {'), 'live routing chooses steer while subagent is busy')
  assert.ok(indexSrc.includes('await runtime.sendPrompt(text, event.images);'), 'live routing sends prompt while subagent is idle')
  assert.ok(indexSrc.includes('readSessionHeader(sessionFile)'), 'backfill reads persisted session headers')
})

test('session headers support persisted subagent metadata for switched sessions', () => {
  const sessionManagerSrc = readFileSync(
    join(projectRoot, 'packages', 'pi-coding-agent', 'src', 'core', 'session-manager.ts'),
    'utf-8',
  )

  assert.ok(sessionManagerSrc.includes('subagentName?: string;'), 'session header supports subagent name')
  assert.ok(sessionManagerSrc.includes('subagentTask?: string;'), 'session header supports subagent task')
  assert.ok(sessionManagerSrc.includes('subagentSystemPrompt?: string;'), 'session header supports persisted subagent prompt')
  assert.ok(sessionManagerSrc.includes('subagentTools?: string[];'), 'session header supports persisted subagent tools')
})

test('subagent extension registers background-complete sessions for /agent command', () => {
  const indexSrc = readFileSync(join(projectRoot, 'src', 'resources', 'extensions', 'subagent', 'index.ts'), 'utf-8')

  assert.ok(indexSrc.includes('if (job.sessionFile && job.parentSessionFile) {'), 'onJobComplete checks session metadata')
  assert.ok(indexSrc.includes('registerAgentSessionLink({'), 'onJobComplete can register session link for /agent')
  assert.ok(indexSrc.includes('updateAgentSessionLinkState(job.sessionFile'), 'onJobComplete updates tracked state for existing links')
  assert.ok(indexSrc.includes('invokingSessionFile,'), 'subagent execution captures invoking parent session file')
})

