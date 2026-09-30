/* Translate's decisions: which banked sentences make a set, what the
   grader is sent, how an array keyed by id is read back, and which cards
   move. The reader must never put a grade on the wrong sentence, so the
   out-of-order and missing-id cases matter as much as the tidy one. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pickTranslationItems, orderForTranslation, translationGradeUser, translationGradeSystem,
  readTranslationGrade, translationScores, cleanAnswer, TRANSLATION_ITEMS, MAX_ANSWER,
  translationDraft, restoreDraft,
} from '../js/translation.js';
import { withDefaults, DEFAULT_TRANSLATION_GRADE_PROMPT } from '../js/defaults.js';

const entry = (id, extra = {}) => ({
  id, sentence: `sentence ${id}`, english: `english ${id}`, terms: [], deck: 'default', ...extra,
});

const decks = {
  default: [{ front: 'đi', back: 'to go' }, { front: 'nếu … thì …', back: 'if … then …', type: 'pattern' }],
};
const findCard = (front, preferred) => {
  for (const name of [preferred, 'default']) {
    const hit = (decks[name] || []).find((c) => c.front === front);
    if (hit) return { card: hit, deck: name };
  }
  return null;
};

/* ── building a set ──────────────────────────────────────────────────── */

test('sentences already dictated come first, as in Shadowing, since a checked set shows each sentence', () => {
  const bank = [entry('new', { times_practiced: 0 }), entry('typed', { times_practiced: 2 }), entry('new2')];
  assert.equal(orderForTranslation(bank)[0].id, 'typed');
});

test('a set takes six, skips sentences with no English, and numbers the items from 0', () => {
  const bank = [...Array.from({ length: 8 }, (_, i) => entry(`e${i}`)), entry('bare', { english: '' })];
  const items = pickTranslationItems(bank, TRANSLATION_ITEMS, findCard);
  assert.equal(items.length, 6);
  assert.deepEqual(items.map((it) => it.id), ['0', '1', '2', '3', '4', '5']);
  assert.ok(items.every((it) => it.bankId !== 'bare'));
});

test('a short bank gives the set it has', () => {
  assert.equal(pickTranslationItems([entry('a'), entry('b')], 6, findCard).length, 2);
  assert.deepEqual(pickTranslationItems([], 6, findCard), []);
});

test('target words become the item\'s cards, and a word no deck has is dropped', () => {
  const [it] = pickTranslationItems([entry('a', { terms: ['đi', 'gone', 'nếu … thì …'] })], 6, findCard);
  assert.deepEqual(it.cards, [
    { front: 'đi', back: 'to go', deck: 'default' },
    { front: 'nếu … thì …', back: 'if … then …', deck: 'default', type: 'pattern' },
  ]);
  assert.equal(it.sentence, 'sentence a');
  assert.equal(it.english, 'english a');
});

/* ── the request ─────────────────────────────────────────────────────── */

/* In a fixed order: the picker's order is random at ties. */
const items = [
  entry('a', { terms: ['đi'] }),
  entry('b', { terms: ['đi', 'nếu … thì …'] }),
  entry('c'),
].map((e) => pickTranslationItems([e], 1, findCard)[0]).map((it, index) => ({ ...it, index, id: String(index) }));

test('every item is sent, blanks included, with its id and its own numbered words', () => {
  const user = translationGradeUser(items, ['Tôi đi.', '', '  lots   of   space  '], 'Vietnamese');
  assert.match(user, /^Grade each translation:\n\n\[1\] id: "0"\nEnglish: "english a"\nReference Vietnamese: "sentence a"\nLearner: "Tôi đi\."\nTarget words:\n1\. "đi" \(to go\)/);
  assert.match(user, /\[2\] id: "1"\n[\s\S]*Learner: ""\nTarget words:\n1\. "đi" \(to go\)\n2\. the grammar pattern "nếu … thì …"/);
  assert.match(user, /\[3\] id: "2"\n[\s\S]*Learner: "lots of space"\nTarget words:\n\(none\)$/);
});

test('an answer is capped', () => {
  assert.equal(cleanAnswer('x'.repeat(900)).length, MAX_ANSWER);
});

test('the system instruction names the language and carries the feedback request', () => {
  const sys = translationGradeSystem(withDefaults({ targetLanguage: 'Spanish', feedbackRequest: 'Deutsch' }));
  assert.match(sys, /grading Spanish-language learner sentence translations/);
  assert.match(sys, /<feedback_request>\nDeutsch\n<\/feedback_request>/);
  assert.doesNotMatch(sys, /Dutch/);
  assert.ok(DEFAULT_TRANSLATION_GRADE_PROMPT.includes('"cards"'));
});

/* ── the reply ───────────────────────────────────────────────────────── */

test('grades are keyed by id, whatever order they come back in', () => {
  const reply = 'Here:\n[{"id":"2","correct":true,"explanation":"Fine."},{"id":"0","correct":false,"explanation":"Wrong verb.","cards":[1,1,5]},{"id":"1","correct":true,"explanation":"Good.","cards":[2]}]';
  const out = readTranslationGrade(reply, items);
  assert.deepEqual(out, [
    { index: 0, graded: true, correct: false, explanation: 'Wrong verb.', cards: [1] },
    { index: 1, graded: true, correct: true, explanation: 'Good.', cards: [] },
    { index: 2, graded: true, correct: true, explanation: 'Fine.', cards: [] },
  ]);
});

test('a missing id, or one with no true or false, is ungraded', () => {
  const out = readTranslationGrade('[{"id":"0","correct":"yes"},{"id":"2","correct":false}]', items);
  assert.deepEqual(out.map((r) => r.graded), [false, false, true]);
  assert.equal(out[1].correct, false);
});

test('a reply that is not an array is a failure', () => {
  assert.equal(readTranslationGrade('{"id":"0","correct":true}', items), null);
  assert.equal(readTranslationGrade('I could not grade these.', items), null);
  assert.equal(readTranslationGrade('[{"id":"0",', items), null);
});

/* ── the cards ───────────────────────────────────────────────────────── */

test('correct scores every card right, incorrect only the named ones, a blank every one wrong', () => {
  const results = [
    { index: 0, graded: true, correct: true, explanation: '', cards: [] },
    { index: 1, graded: true, correct: false, explanation: '', cards: [2] },
    { index: 2, graded: true, correct: false, explanation: '', cards: [] },
  ];
  assert.deepEqual(translationScores(results, items, ['Tôi đi.', 'Nếu…', 'x']), [
    { item: 0, card: 0, ok: true },
    { item: 1, card: 1, ok: false },
  ]);
  /* A blank is wrong whatever the grader said. */
  assert.deepEqual(translationScores([{ ...results[1], correct: true }], items, ['', '', '']), [
    { item: 1, card: 0, ok: false },
    { item: 1, card: 1, ok: false },
  ]);
});

test('an ungraded answer scores nothing, but an ungraded blank is still a blank', () => {
  const ungraded = [{ index: 1, graded: false, correct: false, explanation: '', cards: [] }];
  assert.deepEqual(translationScores(ungraded, items, ['', 'something', '']), []);
  assert.equal(translationScores(ungraded, items, ['', '', '']).length, 2);
});

/* ── the options ─────────────────────────────────────────────────────── */

test('the order can put sentences not yet dictated first, or ignore dictation', () => {
  const bank = [entry('typed', { times_practiced: 2 }), entry('new')];
  assert.equal(orderForTranslation(bank, 'dictated')[0].id, 'typed');
  assert.equal(orderForTranslation(bank, 'fresh')[0].id, 'new');
  const flip = [0.9, 0.1];
  assert.deepEqual(orderForTranslation(bank, 'random', () => flip.shift()).map((e) => e.id), ['new', 'typed']);
});

test('a set takes as many sentences as asked, up to what the bank has', () => {
  const bank = Array.from({ length: 12 }, (_, i) => entry(`e${i}`));
  assert.equal(pickTranslationItems(bank, 10, findCard).length, 10);
  assert.equal(pickTranslationItems(bank, 20, findCard).length, 12);
});

test('with blank answers not counted, a blank scores nothing', () => {
  const results = [{ index: 1, graded: true, correct: false, explanation: '', cards: [1] }];
  assert.deepEqual(translationScores(results, items, ['', '', ''], { blankWrong: false }), []);
  assert.equal(translationScores(results, items, ['', '', '']).length, 2, 'counted by default');
});

/* ── a set not checked yet ───────────────────────────────────────────── */

test('the set being worked on is kept with its answers, and comes back as it was', () => {
  const bank = [entry('a'), entry('b'), entry('c')];
  const items = pickTranslationItems(bank, 3, findCard);
  const kept = translationDraft(items, ['Tôi đi', undefined]);
  assert.deepEqual(kept.answers, ['Tôi đi', '', ''], 'one answer per item, blank where nothing was typed');
  /* Through the file and back. */
  const back = restoreDraft(JSON.parse(JSON.stringify(kept)), bank);
  assert.deepEqual(back.items, items);
  assert.deepEqual(back.answers, ['Tôi đi', '', '']);
  assert.deepEqual(back.items.map((it) => it.id), ['0', '1', '2']);
});

test('a kept set whose sentences the bank no longer has is not resumed, nor anything that is not a set', () => {
  const bank = [entry('a'), entry('b')];
  const kept = translationDraft(pickTranslationItems(bank, 2, findCard), ['x', 'y']);
  assert.equal(restoreDraft(kept, [entry('a')]), null, 'a sentence was deleted from the bank');
  assert.equal(restoreDraft(kept, []), null);
  for (const bad of [null, {}, { items: [], answers: [] }, { items: 'x', answers: [] }, { items: [{}], answers: [''] },
    { items: kept.items }, { items: [{ ...kept.items[0], english: ' ' }], answers: [''] }]) {
    assert.equal(restoreDraft(bad, bank), null, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(restoreDraft({ items: kept.items, answers: ['x'.repeat(MAX_ANSWER + 50)] }, bank).answers[0].length, MAX_ANSWER);
});
