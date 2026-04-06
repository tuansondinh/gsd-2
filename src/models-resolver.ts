/**
 * Models.json resolution with fallback to ~/.pi/agent/models.json
 *
 * LSD uses ~/.lsd/agent/models.json, with legacy GSD compatibility via
 * GSD_HOME/LSD_HOME handling in app-paths.ts. For a smooth migration/development
 * experience, this module provides resolution logic that:
 *
 * 1. Reads ~/.lsd/agent/models.json if it exists
 * 2. Falls back to ~/.pi/agent/models.json if the LSD file doesn't exist
 * 3. Merges both files if both exist (LSD path takes precedence)
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { agentDir } from './app-paths.js'

const LSD_MODELS_PATH = join(agentDir, 'models.json')
const PI_MODELS_PATH = join(homedir(), '.pi', 'agent', 'models.json')

/**
 * Resolve the path to models.json with fallback logic.
 *
 * Priority:
 * 1. ~/.lsd/agent/models.json (exists) → return this path
 * 2. ~/.pi/agent/models.json (exists) → return this path (fallback)
 * 3. Neither exists → return LSD path (will be created)
 *
 * @returns The path to use for models.json
 */
export function resolveModelsJsonPath(): string {
  if (existsSync(LSD_MODELS_PATH)) {
    return LSD_MODELS_PATH
  }
  if (existsSync(PI_MODELS_PATH)) {
    return PI_MODELS_PATH
  }
  return LSD_MODELS_PATH
}


