/* Writing's decisions: how long a piece should be, what the grader is sent,
   and how its feedback is read back. The reply reader has three outcomes and
   each has to stay what it is: feedback, "not an attempt" (a real verdict
   that scores nothing), and null (a failure, with the writing kept). */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  countWords, wordBounds, wordStatus, readBrief, readWritingGrade, normaliseWritingFeedback,
  writingGradeSystem, writingGradeUser, taskText, briefVars, writingTitle, FALLBACK_INVALID_REASON,
  TYPICAL_SOURCE_WORDS,
} from '../js/writing.js';
import { withDefaults, DEFAULT_WRITING_GRADE_PROMPT } from '../js/defaults.js';

const word = (front, back = 'meaning') => ({ front, back });
const pattern = (front, back = 'meaning') => ({ front, back, type: 'pattern' });

/* ── counting ────────────────────────────────────────────────────────── */

test('words are counted by whitespace, and nothing is nothing', () => {
  assert.equal(countWords(''), 0);
  assert.equal(countWords('   \n '), 0);
  assert.equal(countWords(null), 0);
  assert.equal(countWords('Tôi đi học.'), 3);
  assert.equal(countWords('  one\ttwo\n\nthree  '), 3);
});

test('an opinion piece gets the setting as it is', () => {
  const s = withDefaults({ writingWords: { min: 40, max: 90 } });
  assert.deepEqual(wordBounds(s, 'opinion'), { min: 40, max: 90 });
});

test('a summary of a typical text gets two thirds of the setting, rounded to fives', () => {
  const s = withDefaults({ writingWords: { min: 60, max: 120 } });
  assert.deepEqual(wordBounds(s, 'summary', TYPICAL_SOURCE_WORDS), { min: 40, max: 80 });
  assert.deepEqual(wordBounds(s, 'summary', 0), { min: 40, max: 80 }, 'unknown length counts as typical');
});

test('a summary scales with its source, but never more than 30% either way', () => {
  const s = withDefaults({ writingWords: { min: 60, max: 120 } });
  assert.deepEqual(wordBounds(s, 'summary', 5000), { min: 50, max: 105 });
  assert.deepEqual(wordBounds(s, 'summary', 10), { min: 30, max: 55 });
});

test('bounds never collapse below five words or onto each other', () => {
  const s = withDefaults({ writingWords: { min: 5, max: 10 } });
  const b = wordBounds(s, 'summary', 10);
  assert.ok(b.min >= 5);
  assert.ok(b.max > b.min);
});

test('the writing words setting is cleaned on load', () => {
  assert.deepEqual(withDefaults({ writingWords: { min: 0, max: -3 } }).writingWords, { min: 60, max: 120 });
  assert.deepEqual(withDefaults({ writingWords: { min: 80, max: 50 } }).writingWords, { min: 80, max: 85 });
  assert.deepEqual(withDefaults(null).writingWords, { min: 60, max: 120 });
});

test('the counter is red only once something is typed and out of range', () => {
  const b = { min: 40, max: 80 };
  assert.deepEqual(wordStatus(0, b), { ok: false, short: 0, over: 0, empty: true });
  assert.deepEqual(wordStatus(30, b), { ok: false, short: 10, over: 0, empty: false });
  assert.deepEqual(wordStatus(85, b), { ok: false, short: 0, over: 5, empty: false });
  assert.equal(wordStatus(40, b).ok, true);
  assert.equal(wordStatus(80, b).ok, true);
});

/* ── the question ────────────────────────────────────────────────────── */

test('the question is read from its label, or from the first line without one', () => {
  assert.equal(readBrief('QUESTION: ¿Es mejor vivir en el campo o en la ciudad?'), '¿Es mejor vivir en el campo o en la ciudad?');
  assert.equal(readBrief('**QUESTION:** "Bạn thích đọc sách không?"'), 'Bạn thích đọc sách không?');
  assert.equal(readBrief('```\nWould you rather...?\n```'), 'Would you rather...?');
  assert.equal(readBrief(''), '');
});

test('the question prompt is told the cards, numbered, patterns said as patterns', () => {
  const vars = briefVars(withDefaults({ targetLanguage: 'Spanish' }), [word('madrugar', 'to get up early'), pattern('no solo … sino también …')]);
  assert.equal(vars.language, 'Spanish');
  assert.match(vars.terms, /^1\. "madrugar" \(to get up early\)\n2\. the grammar pattern "no solo … sino también …"/);
});

/* ── the grading request ─────────────────────────────────────────────── */

test('the system instruction is the same on every call, with nothing per hand-in in it', () => {
  const s = withDefaults({ targetLanguage: 'German', feedbackRequest: 'English, briefly' });
  const a = writingGradeSystem(s);
  assert.equal(a, writingGradeSystem(s));
  assert.match(a, /a learner of German/);
  assert.match(a, /<feedback_request>\nEnglish, briefly\n<\/feedback_request>/);
  assert.doesNotMatch(a, /\{(language|feedback|languageNote)\}/, 'every setting placeholder is filled');
  assert.doesNotMatch(a, /Dutch|CEFR level for this lesson|upgrade_reference|score/i);
});

test('a customised grading prompt without {feedback} still sends the request', () => {
  const s = withDefaults({ feedbackRequest: 'Français' });
  const custom = { ...s, prompts: { ...s.prompts, writingGrade: 'Grade it. Reply with JSON.' } };
  assert.match(writingGradeSystem(custom), /<feedback_request>\nFrançais\n<\/feedback_request>/);
});

test('the user message carries the task, level, source, numbered cards and the writing', () => {
  const user = writingGradeUser({
    kind: 'summary', brief: '', sourceText: 'Érase una vez…', level: 'B1', language: 'Spanish',
    cards: [word('érase')], text: 'Mi resumen.',
  });
  assert.match(user, /^<task>Write a summary, in Spanish, of the text given below as <source_text>\.<\/task>/);
  assert.match(user, /<level>B1<\/level>/);
  assert.match(user, /<source_text>\nÉrase una vez…\n<\/source_text>/);
  assert.match(user, /<cards>\n1\. "érase" \(meaning\)\n<\/cards>/);
  assert.ok(user.endsWith('<student_text>\nMi resumen.\n</student_text>'));
});

test('an opinion piece has no source block, and no cards says so', () => {
  const user = writingGradeUser({ kind: 'opinion', brief: 'Why?', level: '', language: 'Spanish', cards: [], text: 'x' });
  assert.doesNotMatch(user, /<source_text>/);
  assert.match(user, /<cards>\n\(none\)\n<\/cards>/);
  assert.match(user, /<level>not given<\/level>/);
  assert.equal(taskText('opinion', ' Why? ', 'Spanish'), 'Write a short opinion piece, in Spanish, responding to this: "Why?"');
});

test('the default prompt asks for the shape the reader reads', () => {
  for (const key of ['"valid"', '"taskPoints"', '"vocabStyle"', '"grammarMistakes"', '"cardNumber"', '"cards"', '"verdict"']) {
    assert.ok(DEFAULT_WRITING_GRADE_PROMPT.includes(key), `${key} is asked for`);
  }
});

/* ── reading the reply ───────────────────────────────────────────────── */

const cards = [word('madrugar'), pattern('no solo … sino también …'), word('costumbre')];

const full = {
  valid: true,
  detectedLevel: 'b1',
  languageNote: 'Mostly clear Spanish.',
  contentNote: 'You gave no reason.',
  taskPoints: [
    { point: 'Say which you prefer', met: true, note: 'ignored' },
    { point: 'Give a reason', met: false, note: 'No reason given.' },
    { point: 'Undecided', met: 'maybe' },
  ],
  vocabStyle: [
    { category: 'STYLE', original: 'Es bueno. Es barato.', suggestions: ['Es bueno y, además, barato.'], reason: 'Join them.' },
    { category: 'other', original: 'cosa', suggestions: ['asunto'], reason: 'More precise.' },
    { category: 'VOCAB', original: 'no suggestions', suggestions: [] },
  ],
  grammarMistakes: [
    { description: 'Pattern needs sino', correction: 'no solo caro sino también lento', cardNumber: 2 },
    { description: 'A word is not a pattern', correction: 'x', cardNumber: 1 },
    { description: 'Out of range', correction: 'y', cardNumber: 9 },
    { description: '<b>Accent</b>', correction: 'está', cardNumber: null },
    { correction: 'no description' },
  ],
  cards: [
    { number: 1, verdict: 'right', note: 'Used well.' },
    { number: 2, verdict: 'wrong', note: 'Missing sino.' },
    { number: 3, verdict: 'absent', note: '' },
  ],
};

test('a valid grade comes back whole and tidied', () => {
  const out = readWritingGrade(`Here is my feedback:\n${JSON.stringify(full)}`, cards);
  assert.equal(out.valid, true);
  assert.equal(out.detectedLevel, 'B1');
  assert.equal(out.languageNote, 'Mostly clear Spanish.');
  assert.deepEqual(out.taskPoints, [
    { point: 'Say which you prefer', met: true, note: '' },
    { point: 'Give a reason', met: false, note: 'No reason given.' },
  ]);
  assert.deepEqual(out.vocabStyle.map((v) => v.category), ['STYLE', 'VOCAB']);
  assert.deepEqual(out.grammarMistakes.map((g) => g.cardNumber), [2, null, null, null]);
  assert.equal(out.grammarMistakes[3].description, 'Accent');
  assert.deepEqual(out.cards.map((c) => c.verdict), ['right', 'wrong', 'absent']);
});

test('"not an attempt" is a verdict with a reason, and scores nothing', () => {
  const out = readWritingGrade('{"valid": false, "reason": "This is a question to me, not a text."}', cards);
  assert.deepEqual(out, { valid: false, reason: 'This is a question to me, not a text.' });
  assert.deepEqual(readWritingGrade('{"valid": false}', cards), { valid: false, reason: FALLBACK_INVALID_REASON });
});

test('garbage is null: a failure, never half a grade', () => {
  assert.equal(readWritingGrade('I cannot help with that.', cards), null);
  assert.equal(readWritingGrade('{"detectedLevel": "B1"}', cards), null, 'no valid flag');
  assert.equal(readWritingGrade('{"valid": "yes"}', cards), null);
  assert.equal(normaliseWritingFeedback([1, 2], cards), null);
});

test('a valid grade with every list missing still reads, with empty lists', () => {
  const out = readWritingGrade('{"valid": true}', cards);
  assert.deepEqual(out, {
    valid: true, detectedLevel: null, languageNote: null, contentNote: null,
    taskPoints: [], vocabStyle: [], grammarMistakes: [], cards: [],
  });
});

test('a kept piece is listed by its question, or by the text it summarised', () => {
  assert.equal(writingTitle({ kind: 'opinion', brief: ' Why? ' }), 'Why?');
  assert.equal(writingTitle({ kind: 'summary', readingTitle: 'La tienda' }), 'Summary of La tienda');
});

test('a summary\'s share of the opinion length can be set', () => {
  const s = withDefaults({ writingWords: { min: 60, max: 120 }, writingSummaryShare: 100 });
  assert.deepEqual(wordBounds(s, 'summary', TYPICAL_SOURCE_WORDS), { min: 60, max: 120 });
  assert.deepEqual(wordBounds(withDefaults({ writingSummaryShare: 50 }), 'summary', 0), { min: 30, max: 60 });
});
