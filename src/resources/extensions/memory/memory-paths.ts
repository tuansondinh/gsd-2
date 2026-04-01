import { mkdirSync } from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';

/**
 * Sanitize a project's absolute cwd into a safe directory name.
 * Returns `<basename>-<8char-sha256-hex>` where non-alphanumeric
 * characters in the basename are replaced with underscores.
 *
 * @example sanitizeProjectPath('/Users/me/projects/my-app') → 'my_app-a1b2c3d4'
 */
export function sanitizeProjectPath(cwd: string): string {
  const base = path.basename(cwd).replace(/[^a-zA-Z0-9]/g, '_');
  const hash = createHash('sha256').update(cwd).digest('hex').slice(0, 8);
  return `${base}-${hash}`;
}

/**
 * Return the global LSD base directory (~/.lsd).
 */
export function getMemoryBaseDir(): string {
  return path.join(homedir(), '.lsd');
}

/**
 * Return the NFC-normalized memory directory for a given project cwd,
 * with a trailing path separator appended.
 */
export function getMemoryDir(cwd: string): string {
  const dir = path.join(getMemoryBaseDir(), 'projects', sanitizeProjectPath(cwd), 'memory');
  return (dir + path.sep).normalize('NFC');
}

/**
 * Return the path to the project's MEMORY.md entrypoint file.
 */
export function getMemoryEntrypoint(cwd: string): string {
  return path.join(getMemoryDir(cwd), 'MEMORY.md');
}

/**
 * Ensure the memory directory exists on disk.
 * Uses sync I/O because prompt building is synchronous.
 */
export function ensureMemoryDir(cwd: string): void {
  mkdirSync(getMemoryDir(cwd), { recursive: true });
}

/**
 * Check whether an absolute path resides inside the project's memory directory.
 */
export function isMemoryPath(absolutePath: string, cwd: string): boolean {
  return path.normalize(absolutePath).startsWith(getMemoryDir(cwd));
}
