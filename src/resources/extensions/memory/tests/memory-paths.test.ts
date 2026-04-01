import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  sanitizeProjectPath,
  getMemoryDir,
  getMemoryEntrypoint,
  isMemoryPath,
} from '../memory-paths.js';

describe('sanitizeProjectPath', () => {
  test('returns <basename>-<8hexchars> format', () => {
    const slug = sanitizeProjectPath('/Users/me/myapp');
    const parts = slug.split('-');
    assert.equal(parts.length, 2);
    assert.equal(parts[0], 'myapp');
    assert.equal(parts[1].length, 8);
    assert.match(parts[1], /^[a-f0-9]{8}$/);
  });

  test('replaces non-alphanumeric chars with underscore', () => {
    const slug1 = sanitizeProjectPath('/Users/me/my-app.v2');
    assert.ok(slug1.startsWith('my_app_v2-'));
    const slug2 = sanitizeProjectPath('/Users/me/test.project');
    assert.ok(slug2.startsWith('test_project-'));
    const slug3 = sanitizeProjectPath('/Users/me/test project');
    assert.ok(slug3.startsWith('test_project-'));
  });

  test('produces different slugs for different cwds', () => {
    const slug1 = sanitizeProjectPath('/Users/me/project1');
    const slug2 = sanitizeProjectPath('/Users/me/project2');
    assert.notEqual(slug1, slug2);
  });

  test('is deterministic (same input = same output)', () => {
    const path = '/Users/me/test-project';
    assert.equal(sanitizeProjectPath(path), sanitizeProjectPath(path));
  });
});

describe('getMemoryDir', () => {
  test('path contains projects and memory segments', () => {
    const dir = getMemoryDir('/Users/me/test');
    assert.ok(dir.includes('projects'));
    assert.ok(dir.includes('memory'));
  });

  test('ends with path separator', () => {
    const dir = getMemoryDir('/Users/me/test');
    assert.ok(dir.endsWith('/'));
  });
});

describe('getMemoryEntrypoint', () => {
  test('ends with MEMORY.md', () => {
    const entry = getMemoryEntrypoint('/Users/me/test');
    assert.ok(entry.endsWith('MEMORY.md'));
  });

  test('includes full path from getMemoryDir', () => {
    const dir = getMemoryDir('/Users/me/test');
    const entry = getMemoryEntrypoint('/Users/me/test');
    assert.ok(entry.startsWith(dir.slice(0, -1)));
  });
});

describe('isMemoryPath', () => {
  test('returns true for a file inside the memory dir', () => {
    const cwd = '/Users/me/test';
    const memoryDir = getMemoryDir(cwd);
    const filePath = join(memoryDir.slice(0, -1), 'user.md');
    assert.ok(isMemoryPath(filePath, cwd));
  });

  test('returns false for a file outside the memory dir', () => {
    const cwd = '/Users/me/test';
    const filePath = '/Users/me/test/README.md';
    assert.ok(!isMemoryPath(filePath, cwd));
  });

  test('returns false for path traversal attempt', () => {
    const cwd = '/Users/me/test';
    const traversalPath = '../../../etc/passwd';
    assert.ok(!isMemoryPath(traversalPath, cwd));
  });
});
