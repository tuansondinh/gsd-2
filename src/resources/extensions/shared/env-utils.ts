import { readFile } from 'node:fs/promises'

export async function checkExistingEnvKeys(keys: string[], envFilePath: string): Promise<string[]> {
  let fileContent = ''
  try {
    fileContent = await readFile(envFilePath, 'utf8')
  } catch {}

  const existing: string[] = []
  for (const key of keys) {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const regex = new RegExp(`^${escaped}\\s*=`, 'm')
    if (regex.test(fileContent) || key in process.env) {
      existing.push(key)
    }
  }
  return existing
}
