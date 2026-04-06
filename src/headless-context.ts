/**
 * Headless Context Loading — stdin reading, file context, and project bootstrapping
 *
 * Handles loading context from files or stdin for headless new-milestone,
 * and bootstraps the LSD project state directory when needed.
 */

import { readFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { resolveProjectStateRoot } from './shared-paths.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ContextOptions {
  context?: string       // file path or '-' for stdin
  contextText?: string   // inline text
}

// ---------------------------------------------------------------------------
// Stdin Reader
// ---------------------------------------------------------------------------

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString('utf-8')
}

// ---------------------------------------------------------------------------
// Context Loading
// ---------------------------------------------------------------------------

export async function loadContext(options: ContextOptions): Promise<string> {
  // Prefer --context file over --context-text when both are provided,
  // so callers (e.g. memory auto-extract) can pass a file for the main
  // content and --context-text as a trailing instruction.
  if (options.context === '-') {
    return readStdin()
  }
  if (options.context) {
    return readFileSync(resolve(options.context), 'utf-8')
  }
  if (options.contextText) return options.contextText
  throw new Error('No context provided. Use --context <file> or --context-text <text>')
}

// ---------------------------------------------------------------------------
// Project Bootstrap
// ---------------------------------------------------------------------------

/**
 * Bootstrap LSD project state for headless new-milestone.
 * Creates `.lsd/` by default; legacy `.gsd/` projects are discovered elsewhere.
 * Mirrors the bootstrap logic from guided-flow.ts showSmartEntry().
 */
export function bootstrapGsdProject(basePath: string): void {
  const stateDir = resolveProjectStateRoot(basePath)
  mkdirSync(join(stateDir, 'milestones'), { recursive: true })
  mkdirSync(join(stateDir, 'runtime'), { recursive: true })
}
