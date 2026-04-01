import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseFrontmatter,
  scanMemoryFiles,
  formatMemoryManifest,
  type MemoryHeader,
} from '../memory-scan.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `mem-scan-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('parseFrontmatter', () => {
  test('parses valid frontmatter with all 3 fields', () => {
    const content = `---
name: test-name
description: a test description
type: user
---

content here`;
    const fm = parseFrontmatter(content);
    assert.equal(fm.name, 'test-name');
    assert.equal(fm.description, 'a test description');
    assert.equal(fm.type, 'user');
  });

  test('returns {} for content without --- delimiters', () => {
    assert.deepStrictEqual(parseFrontmatter('no frontmatter here'), {});
    assert.deepStrictEqual(parseFrontmatter(''), {});
  });

  test('returns {} for empty string', () => {
    assert.deepStrictEqual(parseFrontmatter(''), {});
  });

  test('returns {} for content with only opening --- (no closing)', () => {
    assert.deepStrictEqual(parseFrontmatter('---\nname: test\ncontent'), {});
  });

  test('handles frontmatter with extra whitespace in values', () => {
    const content = `---
name:  test name  
description:  a description  
type:  user  
---

content`;
    const fm = parseFrontmatter(content);
    assert.equal(fm.name, 'test name');
    assert.equal(fm.description, 'a description');
    assert.equal(fm.type, 'user');
  });
});

describe('scanMemoryFiles', () => {
  test('returns empty array for non-existent directory', () => {
    const memories = scanMemoryFiles('/does/not/exist');
    assert.deepStrictEqual(memories, []);
  });

  test('finds .md files in directory', () => {
    const dir = makeTempDir();
    const cleanup = () => rmSync(dir, { recursive: true, force: true });

    try {
      writeFileSync(join(dir, 'test.md'), '# test', 'utf-8');
      writeFileSync(join(dir, 'other.md'), '# other', 'utf-8');

      const memories = scanMemoryFiles(dir);
      assert.equal(memories.length, 2);
      assert.ok(memories.find((m) => m.filename === 'test.md'));
      assert.ok(memories.find((m) => m.filename === 'other.md'));
    } finally {
      cleanup();
    }
  });

  test('excludes MEMORY.md from results', () => {
    const dir = makeTempDir();
    const cleanup = () => rmSync(dir, { recursive: true, force: true });

    try {
      writeFileSync(join(dir, 'MEMORY.md'), '# index', 'utf-8');
      writeFileSync(join(dir, 'user.md'), '# user', 'utf-8');

      const memories = scanMemoryFiles(dir);
      assert.equal(memories.length, 1);
      assert.ok(memories.find((m) => m.filename === 'user.md'));
      assert.ok(!memories.find((m) => m.filename === 'MEMORY.md'));
    } finally {
      cleanup();
    }
  });

  test('parses frontmatter from found files', () => {
    const dir = makeTempDir();
    const cleanup = () => rmSync(dir, { recursive: true, force: true });

    try {
      const content = `---
name: test name
description: a test
type: user
---

content`;
      writeFileSync(join(dir, 'user.md'), content, 'utf-8');

      const memories = scanMemoryFiles(dir);
      assert.equal(memories.length, 1);
      assert.equal(memories[0].filename, 'user.md');
      assert.equal(memories[0].description, 'a test');
      assert.equal(memories[0].type, 'user');
    } finally {
      cleanup();
    }
  });

  test('sorts by mtime descending', () => {
    const dir = makeTempDir();
    const cleanup = () => rmSync(dir, { recursive: true, force: true });

    try {
      writeFileSync(join(dir, 'old.md'), '# old', 'utf-8');
      writeFileSync(join(dir, 'new.md'), '# new', 'utf-8');

      // Touch old.md to be older
      const oldTime = new Date(Date.now() - 10000);
      utimesSync(join(dir, 'old.md'), oldTime, oldTime);

      const memories = scanMemoryFiles(dir);
      assert.equal(memories.length, 2);
      assert.equal(memories[0].filename, 'new.md');
      assert.equal(memories[1].filename, 'old.md');
      assert.ok(memories[0].mtimeMs > memories[1].mtimeMs);
    } finally {
      cleanup();
    }
  });

  test('validates type field (invalid types become undefined)', () => {
    const dir = makeTempDir();
    const cleanup = () => rmSync(dir, { recursive: true, force: true });

    try {
      const invalid = `---
name: test
description: test
type: invalid_type
---

content`;
      writeFileSync(join(dir, 'invalid.md'), invalid, 'utf-8');

      const valid = `---
name: test
description: test
type: user
---

content`;
      writeFileSync(join(dir, 'valid.md'), valid, 'utf-8');

      const memories = scanMemoryFiles(dir);
      const invalidMem = memories.find((m) => m.filename === 'invalid.md');
      const validMem = memories.find((m) => m.filename === 'valid.md');

      assert.ok(invalidMem?.type === undefined);
      assert.equal(validMem?.type, 'user');
    } finally {
      cleanup();
    }
  });

  test('returns empty array for empty directory', () => {
    const dir = makeTempDir();
    const cleanup = () => rmSync(dir, { recursive: true, force: true });

    try {
      const memories = scanMemoryFiles(dir);
      assert.deepStrictEqual(memories, []);
    } finally {
      cleanup();
    }
  });
});

describe('formatMemoryManifest', () => {
  test('formats a single memory header with type and description', () => {
    const now = Date.now();
    const header: MemoryHeader = {
      filename: 'user.md',
      filePath: '/path/to/user.md',
      mtimeMs: now,
      description: 'user preferences',
      type: 'user',
    };
    const manifest = formatMemoryManifest([header]);
    assert.ok(manifest.includes('[user]'));
    assert.ok(manifest.includes('user.md'));
    assert.ok(manifest.includes(': user preferences'));
  });

  test('formats header without description', () => {
    const now = Date.now();
    const header: MemoryHeader = {
      filename: 'test.md',
      filePath: '/path/to/test.md',
      mtimeMs: now,
      description: null,
      type: 'project',
    };
    const manifest = formatMemoryManifest([header]);
    assert.ok(manifest.includes('[project]'));
    assert.ok(manifest.includes('test.md'));
    assert.ok(!manifest.includes(':'));
  });

  test('formats header without type', () => {
    const now = Date.now();
    const header: MemoryHeader = {
      filename: 'test.md',
      filePath: '/path/to/test.md',
      mtimeMs: now,
      description: 'no type',
      type: undefined,
    };
    const manifest = formatMemoryManifest([header]);
    assert.ok(!manifest.includes('['));
    assert.ok(manifest.includes('test.md'));
    assert.ok(manifest.includes(': no type'));
  });

  test('returns empty string for empty array', () => {
    assert.equal(formatMemoryManifest([]), '');
  });
});
