import test from 'node:test';
import assert from 'node:assert/strict';

import {
  nextSessionId, extensionFor, takePath, orderBank, buildSet,
  attachableClips, buildGradingParts, extractTrailingJson, normalise,
  readGrading, focusFor, AUDIO_BUDGET_BYTES,
  takeOf, noteIsCurrent, pendingIndices, sessionStatus, mergeGrading,
  handinsOf, groupByHandin, lineList, takeWasHandedIn, pinTakeFile,
} from '../js/shadowing.js';

/* ── ids and filenames ───────────────────────────────────────────────── */

test('session ids do not collide with what is already in the index', () => {
  const day = new Date('2026-09-23T10:00:00Z');
  assert.equal(nextSessionId([], day), 's_20260923_0001');
  assert.equal(nextSessionId([{ id: 's_20260923_0001' }], day), 's_20260923_0002');
  /* A gap in the numbering must not hand back an id that is already taken. */
  const patchy = [{ id: 's_20260923_0001' }, { id: 's_20260923_0003' }];
  assert.equal(nextSessionId(patchy, day), 's_20260923_0004');
});

test('the extension follows the recorder mime, never the other way round', () => {
  assert.equal(extensionFor('audio/webm;codecs=opus'), 'webm');
  assert.equal(extensionFor('audio/ogg; codecs=opus'), 'ogg');
  assert.equal(extensionFor('audio/mp4'), 'mp4');
  assert.equal(extensionFor('audio/x-m4a'), 'm4a');
  assert.equal(extensionFor('audio/wav'), 'wav');
  /* Unknown or absent falls to webm rather than to no extension at all — a
     path with no suffix is outside the data layout and would not be backed up. */
  assert.equal(extensionFor(''), 'webm');
  assert.equal(extensionFor(undefined), 'webm');
  assert.equal(takePath('s_20260923_0001', 3, 'audio/ogg'), 'shadowing/s_20260923_0001_3.ogg');
});

test('every take path this makes is inside the data layout', async () => {
  const { dataPath } = await import('../js/storage.js');
  for (const mime of ['audio/webm;codecs=opus', 'audio/ogg', 'audio/mp4', 'audio/x-m4a', '']) {
    const path = takePath('s_20260923_0001', 0, mime);
    assert.equal(dataPath(path), path, `${mime} produced ${path}, which a backup would drop`);
  }
  assert.equal(dataPath('shadowing/s_20260923_0001.json'), 'shadowing/s_20260923_0001.json');
  assert.equal(dataPath('shadowing/manifest.json'), 'shadowing/manifest.json');
});

/* ── building a set ──────────────────────────────────────────────────── */

const card = (front, score) => ({ front, back: `${front} meaning`, score });
const banked = (id, sentence, extra = {}) => ({
  id, sentence, english: `${sentence} in English`, file: `audio/${id}.wav`, deck: 'verbs', ...extra,
});

test('a set alternates the two sources rather than running one dry first', () => {
  const set = buildSet({
    cards: [card('một', 1), card('hai', 1), card('ba', 1)],
    bank: [banked('d1', 'Câu một.'), banked('d2', 'Câu hai.'), banked('d3', 'Câu ba.')],
    count: 6,
  });
  assert.equal(set.length, 6);
  assert.deepEqual(set.map((i) => i.source), ['bank', 'card', 'bank', 'card', 'bank', 'card']);
  /* Indexes are the set's own positions, 0-based and gapless: they are what
     every note comes back keyed by. */
  assert.deepEqual(set.map((i) => i.index), [0, 1, 2, 3, 4, 5]);
});

test('an unticked source contributes nothing, and both unticked gives nothing', () => {
  const args = {
    cards: [card('một', 1), card('hai', 1)],
    bank: [banked('d1', 'Câu một.')],
    count: 4,
  };
  assert.deepEqual(
    buildSet({ ...args, sources: { cards: true, bank: false } }).map((i) => i.source),
    ['card', 'card']);
  assert.deepEqual(
    buildSet({ ...args, sources: { cards: false, bank: true } }).map((i) => i.source),
    ['bank']);
  /* Not "fall back to whatever is left" — nothing was asked for, so nothing
     is drawn, and the tab says so instead of quietly practising something else. */
  assert.deepEqual(buildSet({ ...args, sources: { cards: false, bank: false } }), []);
});

test('a short pool yields a short set instead of repeating itself', () => {
  const set = buildSet({ cards: [card('một', 1)], bank: [banked('d1', 'Câu một.')], count: 10 });
  assert.equal(set.length, 2);
  assert.equal(new Set(set.map((i) => i.text)).size, 2);
});

test('the same line never appears twice in one set', () => {
  /* A card whose front is also a banked sentence would otherwise come round
     once from each source. */
  const set = buildSet({
    cards: [card('Câu một.', 1), card('hai', 1)],
    bank: [banked('d1', 'Câu một.'), banked('d2', 'Câu hai.')],
    count: 6,
  });
  const texts = set.map((i) => i.text);
  assert.equal(new Set(texts).size, texts.length, `repeated a line: ${texts.join(' | ')}`);
});

test('bank lines carry their audio and their deck; card lines carry neither', () => {
  const set = buildSet({
    cards: [card('một', 1)],
    bank: [banked('d1', 'Câu một.')],
    count: 2,
    deckOf: () => 'nouns',
  });
  const fromBank = set.find((i) => i.source === 'bank');
  const fromCard = set.find((i) => i.source === 'card');
  assert.equal(fromBank.audio, 'audio/d1.wav');
  assert.equal(fromBank.bankId, 'd1');
  assert.equal(fromBank.deck, 'verbs');
  /* No model recording exists for a flashcard — the device voice reads it, and
     that is a playback decision, not a file. */
  assert.equal(fromCard.audio, '');
  assert.equal(fromCard.deck, 'nouns');
  assert.equal(fromCard.cardFront, 'một');
});

test('already-dictated bank entries are offered before never-seen ones', () => {
  const bank = [
    banked('fresh', 'Never typed.'),
    banked('used', 'Typed twice.', { times_practiced: 2 }),
  ];
  assert.equal(orderBank(bank)[0].id, 'used');
  /* But a never-typed one is still used rather than dropped — it cost real
     API calls to make. */
  assert.equal(orderBank(bank).length, 2);
});

/* ── the grading request ─────────────────────────────────────────────── */

const clip = (itemIndex, size = 8) => ({
  itemIndex, mime: 'audio/webm', bytes: new Uint8Array(size).fill(65),
});

test('parts interleave text and audio, ascending, whatever order the clips arrive in', () => {
  const items = [
    { index: 0, text: 'Câu một.' },
    { index: 1, text: 'Câu hai.' },
    { index: 2, text: 'Câu ba.' },
  ];
  const parts = buildGradingParts({
    items, clips: [clip(2), clip(0), clip(1)], language: 'Vietnamese', itemCount: 3,
  });

  assert.equal(parts.length, 1 + 3 * 2, 'one intro, then a text and an audio per clip');
  for (let i = 0; i < 3; i++) {
    const label = parts[1 + i * 2];
    const audio = parts[2 + i * 2];
    assert.ok(label.text.startsWith(`Line ${i} `), `part ${1 + i * 2} is not line ${i}`);
    assert.ok(label.text.includes(items[i].text), 'the label must carry its own line, not another');
    assert.ok(audio.inlineData, 'each label must be followed immediately by its own clip');
  }
});

test('a focus is one extra part, wrapped, before the clips and never in the system prompt', () => {
  const items = [{ index: 0, text: 'Câu một.' }];
  const withFocus = buildGradingParts({
    items, clips: [clip(0)], focus: 'the tones', itemCount: 1,
  });
  const without = buildGradingParts({ items, clips: [clip(0)], itemCount: 1 });
  assert.equal(withFocus.length, without.length + 1);
  assert.match(withFocus[1].text, /^<focus>\nthe tones\n<\/focus>$/);
  assert.ok(withFocus[2].text.startsWith('Line 0 '), 'the focus goes before the lines');
  /* Blank and whitespace-only are the same as absent. */
  assert.equal(buildGradingParts({ items, clips: [clip(0)], focus: '   ', itemCount: 1 }).length,
    without.length);
});

test('the intro says how many are handed in when it is only part of the set', () => {
  const items = [0, 1, 2].map((index) => ({ index, text: `Câu ${index}.` }));
  const partial = buildGradingParts({ items, clips: [clip(0), clip(2)], itemCount: 3 });
  assert.match(partial[0].text, /shown 3 lines and is handing in 2 of them/);
  const full = buildGradingParts({ items, clips: [clip(0), clip(1), clip(2)], itemCount: 3 });
  assert.match(full[0].text, /Here are the 3 lines/);
});

test('the byte budget drops the tail rather than throwing', () => {
  const big = [clip(0, 100), clip(1, 100), clip(2, 100)];
  assert.deepEqual(attachableClips(big, 250).map((c) => c.itemIndex), [0, 1]);
  assert.deepEqual(attachableClips(big, 10), []);
  assert.deepEqual(attachableClips(big).map((c) => c.itemIndex), [0, 1, 2]);
  assert.deepEqual(attachableClips(null), []);
  /* An empty recording is skipped rather than attached as nothing. */
  assert.deepEqual(
    attachableClips([clip(0, 0), clip(1, 5)]).map((c) => c.itemIndex), [1]);
  assert.ok(AUDIO_BUDGET_BYTES > 0);
});

/* ── reading the reply back ──────────────────────────────────────────── */

const good = {
  notes: [{ itemIndex: 0, comment: 'The tone on "một" settled nicely.' }],
  overall: 'Steady pace throughout.',
};

test('a well-formed reply comes back intact', () => {
  const out = normalise(good, 3);
  assert.deepEqual(out.notes, good.notes);
  assert.equal(out.overall, 'Steady pace throughout.');
  assert.equal(out.focusNote, null, 'an absent focusNote is null, not undefined or ""');
});

test('JSON behind a prose preamble still parses', () => {
  const raw = `Sure! Here is the feedback you asked for.\n\n${JSON.stringify(good)}`;
  assert.deepEqual(readGrading(raw, 3).notes, good.notes);
});

test('truncated JSON is a failure, not a partial grade', () => {
  const cut = JSON.stringify(good).slice(0, 40);
  assert.equal(extractTrailingJson(cut), null);
  assert.equal(readGrading(cut, 3), null);
  assert.equal(extractTrailingJson('no json at all here'), null);
  assert.equal(extractTrailingJson(null), null);
});

test('every unusable reply yields a failure rather than something storable', () => {
  const unusable = [
    null,
    'a string',
    {},
    { overall: 'nice' },                                     // no notes array
    { notes: [] },                                           // nothing to show
    { notes: [{ itemIndex: 9, comment: 'out of range' }] },  // beyond the set
    { notes: [{ itemIndex: -1, comment: 'before it' }] },
    { notes: [{ itemIndex: 1.5, comment: 'not an index' }] },
    { notes: [{ itemIndex: 0, comment: '   ' }] },           // blank once trimmed
    { notes: [{ itemIndex: 0 }] },                           // no comment at all
  ];
  for (const parsed of unusable) {
    assert.equal(normalise(parsed, 3), null, `${JSON.stringify(parsed)} should not be storable`);
  }
});

test('a duplicate index keeps the first and drops the second', () => {
  const out = normalise({
    notes: [
      { itemIndex: 0, comment: 'first' },
      { itemIndex: 0, comment: 'second' },
      { itemIndex: 1, comment: 'other' },
    ],
  }, 3);
  assert.deepEqual(out.notes, [
    { itemIndex: 0, comment: 'first' },
    { itemIndex: 1, comment: 'other' },
  ]);
});

test('notes come back sorted, and a good note survives a bad neighbour', () => {
  const out = normalise({
    notes: [
      { itemIndex: 2, comment: 'third' },
      { itemIndex: 99, comment: 'nonsense' },
      { itemIndex: 0, comment: 'first' },
    ],
  }, 3);
  assert.deepEqual(out.notes.map((n) => n.itemIndex), [0, 2]);
});

test('the rules a note cites are kept when sound and dropped when not', () => {
  const out = normalise({
    notes: [
      { itemIndex: 0, comment: 'a', rules: [2, '3', 2, 0, -1, 1.5, 'x'] },
      { itemIndex: 1, comment: 'b', rules: 'nope' },
      { itemIndex: 2, comment: 'c' },
    ],
  }, 3);
  assert.deepEqual(out.notes[0].rules, [2, 3]);
  assert.equal('rules' in out.notes[1], false);
  assert.equal('rules' in out.notes[2], false);
});

test('an over-long comment is truncated, not rejected', () => {
  const out = normalise({
    notes: [{ itemIndex: 0, comment: 'x'.repeat(900) }],
    overall: 'y'.repeat(2000),
    focusNote: 'z'.repeat(2000),
  }, 1);
  assert.equal(out.notes[0].comment.length, 600);
  assert.equal(out.overall.length, 1200);
  assert.equal(out.focusNote.length, 900);
});

/* ── the focus block ─────────────────────────────────────────────────── */

test('a focus is offered for the accents scope only', () => {
  const items = [{ index: 0, text: 'một', cardFront: 'một' }];
  assert.equal(focusFor('all', 'Vietnamese', items), '');
  assert.equal(focusFor('weak', 'Vietnamese', items), '');
  assert.match(focusFor('accents', 'Vietnamese', items), /một/);
  /* Nothing to name means no focus, rather than a block about no words. */
  assert.equal(focusFor('accents', 'Vietnamese', []), '');
});

/* ── handing in part of a set ────────────────────────────────────────── */

const NOW = new Date('2026-09-25T09:00:00Z');

function setOf(n) {
  return {
    items: Array.from({ length: n }, (_, index) => ({ index, text: `Câu ${index}.`, file: '', take: 0 })),
    feedback: null,
  };
}

function record(session, index) {
  const item = session.items[index];
  item.file = `shadowing/s_${index}.webm`;
  item.take = takeOf(item) + 1;
}

const grading = (indices, extra = {}) => ({
  notes: indices.map((i) => ({ itemIndex: i, comment: `note ${i}` })),
  overall: `about ${indices.join(',')}`,
  focusNote: null,
  model: 'm',
  attached: indices.length,
  rulesGeneration: 2,
  ...extra,
});

test('a set handed in half now and half later ends up with every note', () => {
  const s = setOf(4);
  record(s, 0);
  record(s, 1);
  assert.deepEqual(pendingIndices(s), [0, 1]);
  assert.equal(sessionStatus(s), 'recording');

  s.feedback = mergeGrading(s.feedback, grading([0, 1]), s.items, NOW);
  assert.equal(sessionStatus(s), 'partial');
  assert.deepEqual(pendingIndices(s), []);

  record(s, 2);
  record(s, 3);
  assert.deepEqual(pendingIndices(s), [2, 3]);
  s.feedback = mergeGrading(s.feedback, grading([2, 3]), s.items, NOW);
  assert.deepEqual(s.feedback.notes.map((n) => n.itemIndex), [0, 1, 2, 3]);
  assert.equal(sessionStatus(s), 'done');
  assert.deepEqual(s.feedback.handins.map((h) => [h.n, h.lines, h.overall]),
    [[1, [0, 1], 'about 0,1'], [2, [2, 3], 'about 2,3']], 'each overall stays with the lines it was about');
});

test('a retake leaves the other notes alone, and its old note is marked as about an earlier take', () => {
  const s = setOf(3);
  [0, 1, 2].forEach((i) => record(s, i));
  s.feedback = mergeGrading(s.feedback, grading([0, 1, 2]), s.items, NOW);
  s.feedback.notes[0].rating = 'useful';

  record(s, 1);
  const byIndex = new Map(s.feedback.notes.map((n) => [n.itemIndex, n]));
  assert.equal(noteIsCurrent(s.items[1], byIndex.get(1)), false);
  assert.equal(noteIsCurrent(s.items[0], byIndex.get(0)), true);
  assert.deepEqual(pendingIndices(s), [1]);
  assert.equal(sessionStatus(s), 'partial');

  s.feedback = mergeGrading(s.feedback, grading([1], { overall: 'retake' }), s.items, NOW);
  const after = new Map(s.feedback.notes.map((n) => [n.itemIndex, n]));
  assert.equal(after.get(0).rating, 'useful', 'a rating on a line not handed in again survives');
  assert.equal(after.get(1).take, 2);
  assert.equal(sessionStatus(s), 'done');
});

test('asking again about a graded line replaces its note and the rating on it', () => {
  const s = setOf(1);
  record(s, 0);
  s.feedback = mergeGrading(s.feedback, grading([0]), s.items, NOW);
  s.feedback.notes[0].rating = 'vague';
  s.feedback = mergeGrading(s.feedback, grading([0], { notes: [{ itemIndex: 0, comment: 'second opinion' }] }), s.items, NOW);
  assert.equal(s.feedback.notes.length, 1);
  assert.equal(s.feedback.notes[0].comment, 'second opinion');
  assert.equal('rating' in s.feedback.notes[0], false);
});

test('a line sent but skipped by the model keeps its old note', () => {
  const s = setOf(2);
  record(s, 0);
  record(s, 1);
  s.feedback = mergeGrading(s.feedback, grading([0, 1]), s.items, NOW);
  s.feedback = mergeGrading(s.feedback, grading([0], { overall: 'only 0 came back' }), s.items, NOW);
  assert.deepEqual(s.feedback.notes.map((n) => n.comment), ['note 0', 'note 1']);
});

test('each merged note carries the take, rules version and model it came from', () => {
  const s = setOf(1);
  record(s, 0);
  record(s, 0);
  s.feedback = mergeGrading(null, grading([0], { rulesGeneration: 5, model: 'lite' }), s.items, NOW);
  assert.deepEqual(
    { take: s.feedback.notes[0].take, g: s.feedback.notes[0].rulesGeneration, model: s.feedback.notes[0].model },
    { take: 2, g: 5, model: 'lite' });
  assert.equal(s.feedback.notes[0].gradedAt, NOW.toISOString());
});

test('a set saved before takes were counted reads as fully current', () => {
  const old = {
    items: [{ index: 0, text: 'a', file: 'x.webm' }, { index: 1, text: 'b', file: 'y.webm' }],
    feedback: { notes: [{ itemIndex: 0, comment: 'c' }, { itemIndex: 1, comment: 'd' }], rulesGeneration: 1 },
  };
  assert.deepEqual(pendingIndices(old), []);
  assert.equal(sessionStatus(old), 'done');
});

/* ── hand-ins as their own subsets ───────────────────────────────────── */

test('each hand-in is kept as its own subset, and every line is drawn once', () => {
  const s = setOf(10);
  [0, 1, 2, 3].forEach((i) => record(s, i));
  s.feedback = mergeGrading(s.feedback, grading([0, 1, 2, 3]), s.items, NOW);
  [4, 5].forEach((i) => record(s, i));
  s.feedback = mergeGrading(s.feedback, grading([4, 5]), s.items, NOW);

  const { groups, rest } = groupByHandin(s);
  assert.deepEqual(groups.map((g) => [g.handin.n, g.rows.map((r) => r.index)]), [[1, [0, 1, 2, 3]], [2, [4, 5]]]);
  assert.ok(groups.every((g) => g.rows.every((r) => r.current)));
  assert.deepEqual(rest, [6, 7, 8, 9], 'lines never handed in come last');
  assert.deepEqual(s.feedback.notes.map((n) => n.handin), [1, 1, 1, 1, 2, 2]);
});

test('a line handed in again moves to the new hand-in, and the old one keeps what it said', () => {
  const s = setOf(4);
  [0, 1, 2, 3].forEach((i) => record(s, i));
  s.feedback = mergeGrading(s.feedback, grading([0, 1, 2, 3]), s.items, NOW);
  record(s, 1);
  s.feedback = mergeGrading(s.feedback, grading([1], { overall: 'retake' }), s.items, NOW);

  const { groups, rest } = groupByHandin(s);
  const first = groups[0].rows.find((r) => r.index === 1);
  assert.equal(first.current, false);
  assert.equal(first.replacedBy, 2);
  assert.equal(first.said.comment, 'note 1', 'the first hand-in still shows what it said about line 2');
  assert.equal(first.said.take, 1);
  assert.deepEqual(groups[1].rows, [{ index: 1, current: true }]);
  assert.equal(groups[0].handin.overall, 'about 0,1,2,3', 'the first summary is untouched');
  assert.deepEqual(rest, []);
  const drawn = groups.flatMap((g) => g.rows.filter((r) => r.current).map((r) => r.index)).concat(rest);
  assert.deepEqual(drawn.sort(), [0, 1, 2, 3], 'each line has its controls exactly once');
});

test('a set graded before hand-ins were kept reads as one hand-in', () => {
  const old = {
    items: [0, 1, 2].map((index) => ({ index, text: 't', file: 'x' })),
    feedback: {
      notes: [0, 1].map((itemIndex) => ({ itemIndex, comment: `c${itemIndex}`, rating: 'useful' })),
      overall: 'the old overall', covers: [0, 1], model: 'm', rulesGeneration: 2,
    },
  };
  const [only] = handinsOf(old.feedback);
  assert.deepEqual([only.n, only.lines, only.overall, only.rulesGeneration], [1, [0, 1], 'the old overall', 2]);
  assert.equal('rating' in only.notes[0], false, 'a hand-in record keeps what was said, not the rating');
  const { groups, rest } = groupByHandin(old);
  assert.deepEqual(groups[0].rows.map((r) => r.current), [true, true]);
  assert.deepEqual(rest, [2]);

  /* Handing in again numbers on from it. */
  old.items[2].take = 1;
  old.feedback = mergeGrading(old.feedback, grading([2]), old.items, NOW);
  assert.deepEqual(old.feedback.handins.map((h) => h.n), [1, 2]);
  assert.equal(old.feedback.notes.find((n) => n.itemIndex === 0).rating, 'useful', 'old ratings survive the upgrade');
});

test('line lists read the way a learner counts', () => {
  assert.equal(lineList([2]), 'line 3');
  assert.equal(lineList([0, 1, 2, 3]), 'lines 1–4');
  assert.equal(lineList([4, 5]), 'lines 5, 6');
  assert.equal(lineList([9, 0, 1, 2, 6, 8]), 'lines 1–3, 7, 9, 10');
  assert.equal(lineList([]), 'no lines');
});

/* ── keeping the takes feedback was given on ─────────────────────────── */

test('each take has its own file, and take 0 keeps the old name', () => {
  assert.equal(takePath('s_1', 3, 'audio/webm', 2), 'shadowing/s_1_3_t2.webm');
  assert.equal(takePath('s_1', 3, 'audio/ogg'), 'shadowing/s_1_3.ogg');
});

test('a take is kept when it was handed in, and not when it was recorded over first', () => {
  const s = setOf(2);
  record(s, 0);
  s.items[0].file = takePath('s', 0, 'audio/webm', 1);
  assert.equal(takeWasHandedIn(s, 0), false, 'never handed in: free to discard');

  s.feedback = mergeGrading(s.feedback, grading([0]), s.items, NOW);
  assert.equal(takeWasHandedIn(s, 0), true, 'handed in: keep it');
  assert.equal(s.feedback.handins[0].notes[0].file, 'shadowing/s_0_t1.webm', 'the hand-in names the file it heard');

  /* A retake, not handed in, then recorded over again: that one goes. */
  record(s, 0);
  s.items[0].file = takePath('s', 0, 'audio/webm', 2);
  assert.equal(takeWasHandedIn(s, 0), false);
  assert.equal(takeWasHandedIn(s, 1), false, 'a line with no take has nothing to keep');
});

test('a set graded before hand-ins named their files learns the file before it is recorded over', () => {
  const old = {
    items: [{ index: 0, text: 'a', file: 'shadowing/s_0.webm', mime: 'audio/webm', take: 1 }],
    feedback: { notes: [{ itemIndex: 0, comment: 'c', take: 1 }], overall: 'o', rulesGeneration: 1 },
  };
  assert.equal(takeWasHandedIn(old, 0), true);
  pinTakeFile(old, 0);
  assert.equal(old.feedback.handins[0].notes[0].file, 'shadowing/s_0.webm');

  /* After the retake, the old hand-in still points at the kept file. */
  old.items[0].take = 2;
  old.items[0].file = 'shadowing/s_0_t2.webm';
  const { groups } = groupByHandin(old);
  assert.equal(groups[0].rows[0].current, true, 'the note is still the line’s current one until handed in again');
  old.feedback = mergeGrading(old.feedback, grading([0]), old.items, NOW);
  const again = groupByHandin(old).groups[0].rows[0];
  assert.equal(again.current, false);
  assert.equal(again.said.file, 'shadowing/s_0.webm', 'the first hand-in can still play what it heard');
});
