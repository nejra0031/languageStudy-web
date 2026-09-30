/* Reading a grader's JSON out of whatever came back with it, and the one
   shape every graded mode reports your cards in. A reply that cannot be read
   has to come back as null, never as half an answer, so the garbage cases
   matter as much as the good ones. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractTrailingJson, extractJsonArray, cardVerdicts } from '../js/json-reply.js';
import * as shadowing from '../js/shadowing.js';
import { withFeedbackBlock, shadowSystem, fillTemplate } from '../js/gemini.js';
import { GRADER_FEEDBACK_BLOCK, withDefaults } from '../js/defaults.js';

/* ── extractTrailingJson ─────────────────────────────────────────────── */

test('the object reader is the one shadowing always had, still importable from there', () => {
  assert.equal(shadowing.extractTrailingJson, extractTrailingJson);
  assert.deepEqual(extractTrailingJson('Here you go:\n{"a":{"b":1}}\nThanks'), { a: { b: 1 } });
  assert.equal(extractTrailingJson('no json here'), null);
  assert.equal(extractTrailingJson(null), null);
});

/* ── extractJsonArray ────────────────────────────────────────────────── */

test('a bare array parses', () => {
  assert.deepEqual(extractJsonArray('[{"id":"0","correct":true}]'), [{ id: '0', correct: true }]);
});

test('an array wrapped in prose or a code fence parses', () => {
  const reply = 'Sure! Here are the grades:\n```json\n[{"id":"1","correct":false,"cards":[2]},\n {"id":"0","correct":true}]\n```\nLet me know.';
  assert.deepEqual(extractJsonArray(reply), [{ id: '1', correct: false, cards: [2] }, { id: '0', correct: true }]);
});

test('nested arrays are matched by depth, not by the first ]', () => {
  assert.deepEqual(extractJsonArray('x [[1,2],[3]] y [4]'), [[1, 2], [3]]);
});

test('garbage is null, never a guess', () => {
  assert.equal(extractJsonArray('nothing to see'), null);
  assert.equal(extractJsonArray('[1, 2,'), null, 'never closed');
  assert.equal(extractJsonArray('[not json]'), null);
  assert.equal(extractJsonArray(undefined), null);
  assert.equal(extractJsonArray(42), null);
});

/* ── cardVerdicts ────────────────────────────────────────────────────── */

const cards = [{ front: 'a' }, { front: 'b' }, { front: 'c' }];

test('verdicts are kept for the numbers the prompt gave, in list order', () => {
  const out = cardVerdicts({ cards: [
    { number: 3, verdict: 'absent', note: '' },
    { number: 1, verdict: 'right', note: ' Used well. ' },
    { number: 2, verdict: 'wrong', note: 'Wrong sense.' },
  ] }, cards);
  assert.deepEqual(out, [
    { number: 1, index: 0, verdict: 'right', note: 'Used well.' },
    { number: 2, index: 1, verdict: 'wrong', note: 'Wrong sense.' },
    { number: 3, index: 2, verdict: 'absent', note: '' },
  ]);
});

test('a number the list does not have, or a verdict that is not one of the three, is dropped', () => {
  const out = cardVerdicts({ cards: [
    { number: 0, verdict: 'right' },
    { number: 4, verdict: 'right' },
    { number: 1.5, verdict: 'right' },
    { number: 'two', verdict: 'right' },
    { number: 2, verdict: 'partly' },
    { number: '3', verdict: 'WRONG' },
    null,
    'nonsense',
  ] }, cards);
  assert.deepEqual(out, [{ number: 3, index: 2, verdict: 'wrong', note: '' }]);
});

test('a card named twice keeps its first verdict', () => {
  const out = cardVerdicts({ cards: [{ number: 1, verdict: 'wrong' }, { number: 1, verdict: 'right' }] }, cards);
  assert.deepEqual(out.map((v) => v.verdict), ['wrong']);
});

test('no cards list, or no cards given, is no verdicts rather than an error', () => {
  assert.deepEqual(cardVerdicts({}, cards), []);
  assert.deepEqual(cardVerdicts(null, cards), []);
  assert.deepEqual(cardVerdicts({ cards: [{ number: 1, verdict: 'right' }] }, []), []);
});

/* ── the feedback block ──────────────────────────────────────────────── */

test('a grading prompt without {feedback} gets the block, and one with it is left alone', () => {
  assert.ok(withFeedbackBlock('Grade this.').endsWith(GRADER_FEEDBACK_BLOCK));
  assert.equal(withFeedbackBlock('Grade this. {feedback}'), 'Grade this. {feedback}');
  const filled = fillTemplate(withFeedbackBlock('Grade this.'), { feedback: 'Dutch, briefly', language: 'Spanish' });
  assert.match(filled, /<feedback_request>\nDutch, briefly\n<\/feedback_request>/);
  assert.match(filled, /every Spanish word you quote, correct or suggest stays in Spanish/);
});

test('shadowing still appends its own block, not the grader\'s', () => {
  const s = withDefaults(null);
  const custom = { ...s, prompts: { ...s.prompts, shadowing: 'Listen to {count} lines.' } };
  const out = shadowSystem(custom, 3, null);
  assert.match(out, /"comment", "overall" and "focusNote"/);
  assert.doesNotMatch(out, /correct or suggest/);
});

/* ── where the graded modes keep things ──────────────────────────────── */

test('writing and conversations are part of the data layout, so a backup carries them', async () => {
  const { dataPath } = await import('../js/storage.js');
  for (const path of [
    'writing/manifest.json', 'writing/w_20260927_0001.json',
    'conversation/manifest.json', 'conversation/c_20260927_0001.json',
    'conversation/c_20260927_0001_3.webm', 'conversation/c_20260927_0001_5.mp4',
    'conversation/c_20260927_0001_1.ogg', 'translate/open.json',
  ]) {
    assert.equal(dataPath(path), path, `${path} would be left out of a backup`);
  }
  assert.equal(dataPath('writing/notes.txt'), null, 'only what the app writes');
  assert.equal(dataPath('conversation/.DS_Store'), null);
  assert.equal(dataPath('translate/open.txt'), null);
});

test('records are named by date and a count within the day, like reading texts', async () => {
  const { nextDatedId, nextReadingId } = await import('../js/reading.js');
  const now = new Date('2026-09-27T10:00:00Z');
  assert.equal(nextDatedId('w', [], now), 'w_20260927_0001');
  assert.equal(nextDatedId('c', [{ id: 'c_20260927_0001' }, { id: 'c_20260926_0001' }], now), 'c_20260927_0002');
  assert.equal(nextReadingId([], now), 'r_20260927_0001');
});
