import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryAgeDays, memoryAge, memoryFreshnessNote } from '../memory-age.js';

describe('memoryAgeDays', () => {
  test('returns 0 for Date.now()', () => {
    const age = memoryAgeDays(Date.now());
    assert.equal(age, 0);
  });

  test('returns 1 for 24 hours ago', () => {
    const age = memoryAgeDays(Date.now() - 86_400_000);
    assert.equal(age, 1);
  });

  test('returns 0 for future timestamp (clamped)', () => {
    const age = memoryAgeDays(Date.now() + 100_000);
    assert.equal(age, 0);
  });

  test('returns correct value for 30 days ago', () => {
    const age = memoryAgeDays(Date.now() - 30 * 86_400_000);
    assert.equal(age, 30);
  });
});

describe('memoryAge', () => {
  test('returns "today" for now', () => {
    const age = memoryAge(Date.now());
    assert.equal(age, 'today');
  });

  test('returns "yesterday" for 24h ago', () => {
    const age = memoryAge(Date.now() - 86_400_000);
    assert.equal(age, 'yesterday');
  });

  test('returns "30 days ago" for 30 days', () => {
    const age = memoryAge(Date.now() - 30 * 86_400_000);
    assert.equal(age, '30 days ago');
  });
});

describe('memoryFreshnessNote', () => {
  test('returns empty string for now', () => {
    const note = memoryFreshnessNote(Date.now());
    assert.equal(note, '');
  });

  test('returns empty string for yesterday', () => {
    const note = memoryFreshnessNote(Date.now() - 86_400_000);
    assert.equal(note, '');
  });

  test('returns non-empty string containing "days old" for 5 days ago', () => {
    const note = memoryFreshnessNote(Date.now() - 5 * 86_400_000);
    assert.ok(note.length > 0);
    assert.ok(note.includes('days old'));
  });
});
