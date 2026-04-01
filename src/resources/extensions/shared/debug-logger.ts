import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { resolveProjectStateRoot } from './paths.js'

let _enabled = false
let _logPath: string | null = null
let _startTime = 0

const _counters = {
  deriveStateCalls: 0,
  deriveStateTotalMs: 0,
  ttsrChecks: 0,
  ttsrTotalMs: 0,
  ttsrPeakBuffer: 0,
  parseRoadmapCalls: 0,
  parseRoadmapTotalMs: 0,
  parsePlanCalls: 0,
  parsePlanTotalMs: 0,
  dispatches: 0,
  renders: 0,
}

const MAX_DEBUG_LOGS = 5

export function enableDebug(basePath: string): void {
  const debugDir = join(resolveProjectStateRoot(basePath), 'debug')
  mkdirSync(debugDir, { recursive: true })
  try {
    const files = readdirSync(debugDir)
      .filter(f => f.startsWith('debug-') && f.endsWith('.log'))
      .sort()
    while (files.length >= MAX_DEBUG_LOGS) {
      const oldest = files.shift()!
      try { unlinkSync(join(debugDir, oldest)) } catch {}
    }
  } catch {}
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
  _logPath = join(debugDir, `debug-${timestamp}.log`)
  _startTime = Date.now()
  _enabled = true
  for (const key of Object.keys(_counters) as (keyof typeof _counters)[]) {
    _counters[key] = 0
  }
}

export function disableDebug(): string | null {
  const path = _logPath
  _enabled = false
  _logPath = null
  _startTime = 0
  return path
}

export function isDebugEnabled(): boolean { return _enabled }
export function getDebugLogPath(): string | null { return _logPath }

export function debugLog(event: string, data?: Record<string, unknown>): void {
  if (!_enabled || !_logPath) return
  try { appendFileSync(_logPath, JSON.stringify({ ts: new Date().toISOString(), event, ...data }) + '\n') } catch {}
}

export function debugTime(event: string): (data?: Record<string, unknown>) => void {
  if (!_enabled) return _noop
  const start = performance.now()
  return (data?: Record<string, unknown>) => {
    const elapsed_ms = Math.round((performance.now() - start) * 100) / 100
    debugLog(event, { elapsed_ms, ...data })
  }
}

export function debugCount(counter: keyof typeof _counters, value = 1): void {
  if (!_enabled) return
  _counters[counter] += value
}

export function debugPeak(counter: keyof typeof _counters, value: number): void {
  if (!_enabled) return
  if (value > _counters[counter]) _counters[counter] = value
}

export function writeDebugSummary(): string | null {
  if (!_enabled || !_logPath) return null
  const totalElapsed_ms = Date.now() - _startTime
  const avgDeriveState_ms = _counters.deriveStateCalls > 0 ? Math.round((_counters.deriveStateTotalMs / _counters.deriveStateCalls) * 100) / 100 : 0
  const avgTtsrCheck_ms = _counters.ttsrChecks > 0 ? Math.round((_counters.ttsrTotalMs / _counters.ttsrChecks) * 100) / 100 : 0
  debugLog('debug-summary', {
    totalElapsed_ms,
    dispatches: _counters.dispatches,
    deriveStateCalls: _counters.deriveStateCalls,
    avgDeriveState_ms,
    parseRoadmapCalls: _counters.parseRoadmapCalls,
    avgParseRoadmap_ms: _counters.parseRoadmapCalls > 0 ? Math.round((_counters.parseRoadmapTotalMs / _counters.parseRoadmapCalls) * 100) / 100 : 0,
    parsePlanCalls: _counters.parsePlanCalls,
    ttsrChecks: _counters.ttsrChecks,
    avgTtsrCheck_ms,
    ttsrPeakBuffer: _counters.ttsrPeakBuffer,
    renders: _counters.renders,
  })
  return disableDebug()
}

function _noop(_data?: Record<string, unknown>): void {}
