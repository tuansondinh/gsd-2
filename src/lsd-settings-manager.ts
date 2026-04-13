import { SettingsManager } from '@gsd/pi-coding-agent'
import { agentDir as defaultAgentDir } from './app-paths.js'

export function createLsdSettingsManager(
  cwd: string = process.cwd(),
  agentDir: string = defaultAgentDir,
): SettingsManager {
  return SettingsManager.create(cwd, agentDir)
}
