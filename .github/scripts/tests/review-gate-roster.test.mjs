import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRoster, hasKey, isAuthorOnly } from '../review-gate-roster.mjs';

// ── parseRoster ─────────────────────────────────────────────────────────────

test('parseRoster: bare key gets authorOnly=false (backward compatible)', () => {
  const roster = parseRoster('ada\nlinus\n');
  assert.equal(roster.size, 2);
  assert.deepEqual(roster.get('ada'), { authorOnly: false });
  assert.deepEqual(roster.get('linus'), { authorOnly: false });
});

test('parseRoster: author-only marker sets authorOnly=true', () => {
  const roster = parseRoster('coo  author-only\n');
  assert.equal(roster.size, 1);
  assert.deepEqual(roster.get('coo'), { authorOnly: true });
});

test('parseRoster: mixed bare and author-only keys', () => {
  const raw = [
    '# header comment',
    'ada',
    'grace',
    'coo  author-only',
    'cto',
  ].join('\n');
  const roster = parseRoster(raw);
  assert.equal(roster.size, 4);
  assert.equal(roster.get('ada').authorOnly, false);
  assert.equal(roster.get('grace').authorOnly, false);
  assert.equal(roster.get('coo').authorOnly, true);
  assert.equal(roster.get('cto').authorOnly, false);
});

test('parseRoster: keys are lowercased', () => {
  const roster = parseRoster('Ada\nCOO  author-only\n');
  assert.ok(roster.has('ada'));
  assert.ok(roster.has('coo'));
  assert.ok(!roster.has('Ada'));
});

test('parseRoster: comment lines and blank lines are ignored', () => {
  const raw = [
    '# This is a comment',
    '',
    '   ',
    'ada',
    '# coo authors docs',
    'coo  author-only',
  ].join('\n');
  const roster = parseRoster(raw);
  assert.equal(roster.size, 2);
});

test('parseRoster: multiple spaces between key and marker', () => {
  const roster = parseRoster('coo    author-only\n');
  assert.deepEqual(roster.get('coo'), { authorOnly: true });
});

test('parseRoster: tabs between key and marker', () => {
  const roster = parseRoster('coo\tauthor-only\n');
  assert.deepEqual(roster.get('coo'), { authorOnly: true });
});

test('parseRoster: empty input produces empty map', () => {
  const roster = parseRoster('');
  assert.equal(roster.size, 0);
});

test('parseRoster: comment-only input produces empty map', () => {
  const roster = parseRoster('# just a comment\n# another\n');
  assert.equal(roster.size, 0);
});

// ── hasKey ──────────────────────────────────────────────────────────────────

test('hasKey: returns true for existing key (case-insensitive)', () => {
  const roster = parseRoster('ada\ncoo  author-only\n');
  assert.equal(hasKey('ada', roster), true);
  assert.equal(hasKey('ADA', roster), true);
  assert.equal(hasKey('Ada', roster), true);
});

test('hasKey: returns false for missing key', () => {
  const roster = parseRoster('ada\n');
  assert.equal(hasKey('linus', roster), false);
});

// ── isAuthorOnly ────────────────────────────────────────────────────────────

test('isAuthorOnly: returns true for author-only key', () => {
  const roster = parseRoster('coo  author-only\n');
  assert.equal(isAuthorOnly('coo', roster), true);
});

test('isAuthorOnly: returns false for bare key', () => {
  const roster = parseRoster('ada\n');
  assert.equal(isAuthorOnly('ada', roster), false);
});

test('isAuthorOnly: returns false for key not in roster', () => {
  const roster = parseRoster('ada\n');
  assert.equal(isAuthorOnly('linus', roster), false);
});

test('isAuthorOnly: case-insensitive', () => {
  const roster = parseRoster('coo  author-only\n');
  assert.equal(isAuthorOnly('COO', roster), true);
  assert.equal(isAuthorOnly('Coo', roster), true);
});

// ── Integration: realistic roster ───────────────────────────────────────────

test('realistic roster: full fleet with coo author-only', () => {
  const raw = [
    '# Paperclip agent roster',
    '# Both Author-agent and Reviewer-agent must appear here.',
    '# coo is author-only — must never review.',
    'ada',
    'grace',
    'linus',
    'tim',
    'ceo',
    'cto',
    'coo  author-only',
  ].join('\n');
  const roster = parseRoster(raw);

  // All keys present
  for (const key of ['ada', 'grace', 'linus', 'tim', 'ceo', 'cto', 'coo']) {
    assert.equal(hasKey(key, roster), true, `${key} should be in roster`);
  }

  // Only coo is author-only
  for (const key of ['ada', 'grace', 'linus', 'tim', 'ceo', 'cto']) {
    assert.equal(isAuthorOnly(key, roster), false, `${key} should not be author-only`);
  }
  assert.equal(isAuthorOnly('coo', roster), true, 'coo should be author-only');
});
