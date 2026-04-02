import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { describe } from 'node:test';
import {
    __testing,
    buildConsolidationPrompt,
    readAutoDreamSettings,
    setProjectAutoDreamEnabled,
} from '../dream.js';

function makeTempDir(): string {
    const dir = join(tmpdir(), `memory-dream-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(dir, { recursive: true });
    return dir;
}

describe('buildConsolidationPrompt', () => {
    test('includes the dream consolidation framing and paths', () => {
        const prompt = buildConsolidationPrompt('/tmp/memory', '/tmp/sessions');
        assert.match(prompt, /Dream: Memory Consolidation/);
        assert.match(prompt, /reflective pass over existing memory files/);
        assert.match(prompt, /Validate every MEMORY\.md link and repair or remove broken pointers/);
        assert.match(prompt, /always target absolute paths inside \/tmp\/memory/);
        assert.match(prompt, /\/tmp\/memory/);
        assert.match(prompt, /\/tmp\/sessions/);
    });
});

describe('auto-dream settings', () => {
    test('writes and reads project auto-dream state', () => {
        const cwd = makeTempDir();
        const agentDir = makeTempDir();
        const previous = process.env.LSD_CODING_AGENT_DIR;
        process.env.LSD_CODING_AGENT_DIR = agentDir;

        try {
            const before = readAutoDreamSettings(cwd);
            assert.equal(before.enabled, false);
            assert.equal(before.minHours, 24);
            assert.equal(before.minSessions, 5);

            const after = setProjectAutoDreamEnabled(cwd, true);
            assert.equal(after.enabled, true);
            assert.equal(after.minHours, 24);
            assert.equal(after.minSessions, 5);
        } finally {
            if (previous === undefined) {
                delete process.env.LSD_CODING_AGENT_DIR;
            } else {
                process.env.LSD_CODING_AGENT_DIR = previous;
            }
            rmSync(cwd, { recursive: true, force: true });
            rmSync(agentDir, { recursive: true, force: true });
        }
    });
});

describe('listBrokenMemoryIndexEntries', () => {
    test('reports broken MEMORY.md pointers and ignores valid ones', () => {
        const memoryDir = makeTempDir();
        const validFile = join(memoryDir, 'feedback.md');
        const nestedDir = join(memoryDir, 'nested');
        const entrypoint = join(memoryDir, 'MEMORY.md');

        try {
            mkdirSync(nestedDir, { recursive: true });
            writeFileSync(validFile, 'ok\n', 'utf-8');
            writeFileSync(join(nestedDir, 'present.md'), 'ok\n', 'utf-8');
            writeFileSync(
                entrypoint,
                [
                    '- [Valid](feedback.md) — ok',
                    '- [Nested](nested/present.md) — ok',
                    '- [Missing](missing.md) — missing',
                    '- [Escapes](../outside.md) — invalid',
                    '- [External](https://example.com) — ignore',
                ].join('\n') + '\n',
                'utf-8',
            );

            const broken = __testing.listBrokenMemoryIndexEntries(memoryDir);
            assert.deepEqual(broken, ['../outside.md', 'missing.md']);
        } finally {
            rmSync(memoryDir, { recursive: true, force: true });
        }
    });

    test('prunes broken MEMORY.md pointers and keeps valid lines', () => {
        const memoryDir = makeTempDir();
        const entrypoint = join(memoryDir, 'MEMORY.md');
        const validFile = join(memoryDir, 'feedback.md');

        try {
            writeFileSync(validFile, 'ok\n', 'utf-8');
            writeFileSync(
                entrypoint,
                [
                    '- [Valid](feedback.md) — ok',
                    '- [Missing](missing.md) — missing',
                    '- [Escapes](../outside.md) — invalid',
                ].join('\n') + '\n',
                'utf-8',
            );

            const pruned = __testing.pruneBrokenMemoryIndexEntries(memoryDir);
            assert.deepEqual(pruned, ['../outside.md', 'missing.md']);
            assert.equal(readFileSync(entrypoint, 'utf-8'), '- [Valid](feedback.md) — ok\n');
        } finally {
            rmSync(memoryDir, { recursive: true, force: true });
        }
    });
});

describe('listSessionsTouchedSince', () => {
    test('counts touched session files and excludes the current session file', () => {
        const sessionDir = makeTempDir();
        const older = join(sessionDir, 'older.jsonl');
        const newer = join(sessionDir, 'newer.jsonl');
        const current = join(sessionDir, 'current.jsonl');

        try {
            writeFileSync(older, '{}\n', 'utf-8');
            writeFileSync(newer, '{}\n', 'utf-8');
            writeFileSync(current, '{}\n', 'utf-8');

            const olderTime = Date.now() - 10 * 60 * 1000;
            const newerTime = Date.now() - 60 * 1000;
            utimesSync(older, olderTime / 1000, olderTime / 1000);
            utimesSync(newer, newerTime / 1000, newerTime / 1000);
            utimesSync(current, newerTime / 1000, newerTime / 1000);

            const sinceMs = statSync(older).mtimeMs + 1000;
            const touched = __testing.listSessionsTouchedSince(sessionDir, sinceMs, current);
            assert.equal(touched.length, 1);
            assert.equal(touched[0], newer);
        } finally {
            rmSync(sessionDir, { recursive: true, force: true });
        }
    });
});
