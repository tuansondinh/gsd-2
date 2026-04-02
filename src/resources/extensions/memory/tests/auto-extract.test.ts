import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildTranscriptSummary, buildExtractionPrompt } from '../auto-extract.js';

function makeTempDir(): string {
  const dir = join(tmpdir(), `mem-extract-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe('buildTranscriptSummary', () => {
  test('returns transcript even for a short conversation when there is user-authored content', () => {
    const entries = [
      { type: 'message', message: { role: 'user', content: 'hello' } },
      { type: 'message', message: { role: 'assistant', content: 'hi' } },
    ];
    const summary = buildTranscriptSummary(entries);
    assert.ok(summary.includes('User: hello'));
    assert.ok(summary.includes('Assistant: hi'));
  });

  test('returns empty string for empty array', () => {
    assert.equal(buildTranscriptSummary([]), '');
  });

  test('returns empty string when there is no user-authored content', () => {
    const entries = [
      { type: 'message', message: { role: 'assistant', content: 'hi' } },
    ];
    assert.equal(buildTranscriptSummary(entries), '');
  });

  test('extracts user and assistant text messages', () => {
    const entries = [
      { type: 'message', message: { role: 'user', content: 'hello' } },
      { type: 'message', message: { role: 'assistant', content: 'hi there' } },
      { type: 'message', message: { role: 'user', content: 'how are you' } },
    ];
    const summary = buildTranscriptSummary(entries);
    assert.ok(summary.includes('User: hello'));
    assert.ok(summary.includes('Assistant: hi there'));
    assert.ok(summary.includes('User: how are you'));
  });

  test('skips entries where type !== message', () => {
    const entries = [
      { type: 'other', data: 'ignored' },
      { type: 'message', message: { role: 'user', content: 'hello' } },
      { type: 'tool_result', id: '1', content: 'ignored' },
      { type: 'message', message: { role: 'assistant', content: 'hi' } },
      { type: 'message', message: { role: 'user', content: 'test' } },
    ];
    const summary = buildTranscriptSummary(entries);
    assert.ok(summary.includes('User: hello'));
    assert.ok(summary.includes('Assistant: hi'));
    assert.ok(summary.includes('User: test'));
  });

  test('handles array content (multi-part), includes only text', () => {
    const entries = [
      { type: 'message', message: { role: 'user', content: [{ type: 'text', text: 'hello' }, { type: 'tool_use', id: '1', name: 'bash', input: {} }] } },
      { type: 'message', message: { role: 'assistant', content: 'response' } },
      { type: 'message', message: { role: 'user', content: 'end' } },
    ];
    const summary = buildTranscriptSummary(entries);
    assert.ok(summary.includes('User: hello'));
    assert.ok(!summary.includes('tool_use'));
    assert.ok(summary.includes('Assistant: response'));
    assert.ok(summary.includes('User: end'));
  });

  test('truncates messages over 2000 chars', () => {
    const longText = 'a'.repeat(3000);
    const entries = [
      { type: 'message', message: { role: 'user', content: 'start' } },
      { type: 'message', message: { role: 'assistant', content: longText } },
      { type: 'message', message: { role: 'user', content: 'end' } },
    ];
    const summary = buildTranscriptSummary(entries);
    assert.ok(summary.includes('…'));
    assert.ok(summary.length < 4000); // Should be truncated
  });

  test('labels user messages with User: and assistant with Assistant:', () => {
    const entries = [
      { type: 'message', message: { role: 'user', content: 'question' } },
      { type: 'message', message: { role: 'assistant', content: 'answer' } },
      { type: 'message', message: { role: 'user', content: 'thanks' } },
    ];
    const summary = buildTranscriptSummary(entries);
    assert.ok(summary.includes('User:'));
    assert.ok(summary.includes('Assistant:'));
  });
});

describe('buildExtractionPrompt', () => {
  test('contains the memory directory path in output', () => {
    const memoryDir = '/tmp/test-memory';
    const entries = [
      { type: 'message', message: { role: 'user', content: 'test1' } },
      { type: 'message', message: { role: 'assistant', content: 'test2' } },
      { type: 'message', message: { role: 'user', content: 'test3' } },
    ];
    const prompt = buildExtractionPrompt(memoryDir, buildTranscriptSummary(entries));
    assert.ok(prompt.includes(memoryDir));
  });

  test('contains the transcript in output', () => {
    const memoryDir = '/tmp/test-memory';
    const entries = [
      { type: 'message', message: { role: 'user', content: 'hello world' } },
      { type: 'message', message: { role: 'assistant', content: 'response' } },
      { type: 'message', message: { role: 'user', content: 'end' } },
    ];
    const prompt = buildExtractionPrompt(memoryDir, buildTranscriptSummary(entries));
    assert.ok(prompt.includes('User: hello world'));
    assert.ok(prompt.includes('Assistant: response'));
  });

  test('contains "None yet" when memory dir is empty', () => {
    const memoryDir = makeTempDir();
    const cleanup = () => rmSync(memoryDir, { recursive: true, force: true });

    try {
      const entries = [
        { type: 'message', message: { role: 'user', content: 'test1' } },
        { type: 'message', message: { role: 'assistant', content: 'test2' } },
        { type: 'message', message: { role: 'user', content: 'test3' } },
      ];
      const prompt = buildExtractionPrompt(memoryDir, buildTranscriptSummary(entries));
      assert.ok(prompt.includes('None yet'));
    } finally {
      cleanup();
    }
  });

  test('contains extraction rules (Save ONLY)', () => {
    const memoryDir = '/tmp/test-memory';
    const entries = [
      { type: 'message', message: { role: 'user', content: 'test1' } },
      { type: 'message', message: { role: 'assistant', content: 'test2' } },
      { type: 'message', message: { role: 'user', content: 'test3' } },
    ];
    const prompt = buildExtractionPrompt(memoryDir, buildTranscriptSummary(entries));
    assert.ok(prompt.includes('Save ONLY'));
  });
});
