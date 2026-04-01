import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

export function resolveProjectStateRoot(basePath: string): string {
  let current = resolve(basePath)
  while (true) {
    const lsdDir = join(current, '.lsd')
    if (existsSync(lsdDir)) return lsdDir
    const legacyDir = join(current, '.gsd')
    if (existsSync(legacyDir)) return legacyDir
    const parent = dirname(current)
    if (parent === current) return join(resolve(basePath), '.lsd')
    current = parent
  }
}
