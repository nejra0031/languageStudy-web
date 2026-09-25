import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  recordResult, stats, isDictatable, isPattern, normalizeCard, parseDeck, serializeDeck,
  importWatchlist, parseDeckFile, amendLastToRight, addAlternative, meanings,
  pickWeighted, pickGroup, cardWeight, inScope, slugify, WINDOW,
} from '../js/deck.js';

const card = (recent = []) => ({ front: 'x', back: 'y', score: 1, recent: recent.slice() });

test('score follows accuracy once a full window exists', () => {
  const cases = [
    [[1, 0, 0, 0, 0, 0, 0, 0], 1],   // 12.5%
    [[1, 1, 0, 0, 0, 0, 0, 0], 2],   // 25%
    [[1, 1, 1, 1, 0, 0, 0, 0], 3],   // 50%
    [[1, 1, 1, 1, 1, 1, 0, 0], 4],   // 75%
    [[1, 1, 1, 1, 1, 1, 1, 1], 5],   // 100%
  ];
  for (const [pattern, expected] of cases) {
    const c = card(pattern.slice(0, 7).map(Boolean));
    recordResult(c, !!pattern[7]);
    assert.equal(c.score, expected, `pattern ${pattern.join('')}`);
  }
});

test('a short perfect streak is capped at weak', () => {
  const c = card();
  for (let i = 0; i < WINDOW - 1; i++) {
    recordResult(c, true);
    assert.equal(c.score, 2, `after ${i + 1} correct answers`);
  }
  recordResult(c, true);
  assert.equal(c.score, 5, 'the cap lifts on the eighth answer');
});

test('the window drops the oldest result rather than growing', () => {
  const c = card();
  for (let i = 0; i < 12; i++) recordResult(c, i >= 4);
  assert.equal(c.recent.length, WINDOW);
  assert.deepEqual(c.recent, Array(WINDOW).fill(true));
  assert.equal(c.score, 5);
});

test('encounters and correct are derived, never stored', () => {
  const c = card([true, false, true]);
  assert.deepEqual(stats(c), { encounters: 3, correct: 2, accuracy: 2 / 3 });
  recordResult(c, false);
  assert.equal(stats(c).encounters, 4);
  assert.equal('encounters' in c, false);
  assert.equal('correct' in c, false);
});

test('recordResult stamps the date and reports the move', () => {
  const c = card([true, true, true, true, true, true, true]);
  const move = recordResult(c, true);
  assert.deepEqual({ before: move.before, after: move.after }, { before: 1, after: 5 });
  assert.match(c.last_seen, /^\d{4}-\d{2}-\d{2}$/);
});

test('isDictatable keeps phrases and rejects what has no single string', () => {
  assert.equal(isDictatable({ front: 'đóng (học phí)' }), true);
  assert.equal(isDictatable({ front: 'giữ gìn' }), true);
  assert.equal(isDictatable({ front: 'bằng cách' }), true);
  assert.equal(isDictatable({ front: 'đóng vs chi' }), false);
  assert.equal(isDictatable({ front: 'thứ / quà' }), false);
  assert.equal(isDictatable({ front: 'càng… càng' }), false);
  assert.equal(isDictatable({ front: 'sự + danh từ' }), false);
  assert.equal(isDictatable({ front: 'a b c d e f g' }), false, 'too long to hear as a unit');
  assert.equal(isDictatable({ front: '' }), false);
});

test('a card is a pattern only when it says so', () => {
  assert.equal(isPattern({ front: 'A mà B', type: 'pattern' }), true);
  assert.equal(isPattern({ front: 'A mà B', type: ' Pattern ' }), true);
  assert.equal(isPattern({ front: 'A mà B' }), false);
  assert.equal(isPattern({ front: 'A veces', type: 'phrase' }), false);
});

test('a pattern card is a dictation target when it has two fixed words or more', () => {
  const p = (front) => isDictatable({ front, type: 'pattern' });
  assert.equal(p('hễ … là …'), true);
  assert.equal(p('không … nữa'), true);
  assert.equal(p('không những … mà còn …'), true);
  assert.equal(p('càng… càng'), true);
  assert.equal(p('A có điều là B'), true);
  assert.equal(p('nói đến … người ta nghĩ ngay đến …'), true, 'six words or fewer in each part');
  assert.equal(p('a b c d e f g …'), false);
  assert.equal(p('… được'), false, 'one common word tests nothing');
  assert.equal(p('A mà B'), false);
  assert.equal(p('A, B, cả C'), false);
  assert.equal(p('A được B + động từ'), false, 'a formula is still not a string');
  assert.equal(p('một đống / một mớ'), false);
  assert.equal(p('…'), false);
});

test('an unmarked card that looks like a pattern is judged as before', () => {
  assert.equal(isDictatable({ front: 'hễ … là …' }), false);
  assert.equal(isDictatable({ front: 'A mà B' }), true, 'three plain words, as far as anyone can tell');
});

test('a bare front/back pair is filled in', () => {
  assert.deepEqual(normalizeCard({ front: ' a ', back: 'b' }), {
    front: 'a', back: 'b', score: 1, recent: [], last_seen: null,
  });
});

test('normalizeCard clamps a nonsense score and trims a long history', () => {
  const c = normalizeCard({ front: 'a', back: 'b', score: 99, recent: Array(20).fill(true) });
  assert.equal(c.score, 1);
  assert.equal(c.recent.length, WINDOW);
});

test('parse and serialize round-trip', () => {
  const source = [
    { front: 'cải tiến', back: 'to improve', notes: 'n', score: 3, recent: [true, false], last_seen: '2026-01-02' },
  ];
  const text = serializeDeck(source);
  const back = parseDeck(text);
  assert.equal(back.error, undefined);
  assert.deepEqual(back.cards, source);
  assert.equal(serializeDeck(back.cards), text);
});

test('fields this app does not know about survive a save', () => {
  const card = normalizeCard({ front: 'a', back: 'b', type: 'vocab', tags: ['x'], source: 'p12' });
  assert.equal(card.type, 'vocab');
  assert.deepEqual(card.tags, ['x']);

  const text = serializeDeck([card]);
  assert.match(text, /"type": "vocab"/);
  const back = parseDeck(text).cards[0];
  assert.equal(back.type, 'vocab');
  assert.equal(back.source, 'p12');

  /* The app's own keys still lead, so a save never reshuffles the file. */
  assert.deepEqual(Object.keys(back), ['front', 'back', 'score', 'recent', 'last_seen', 'type', 'tags', 'source']);
});

test('a prototype-polluting key is not carried through', () => {
  const card = normalizeCard(JSON.parse('{"front":"a","back":"b","__proto__":{"bad":1}}'));
  assert.equal(card.bad, undefined);
  assert.equal(({}).bad, undefined);
});

test('the starter deck is valid and self-consistent', async () => {
  const { STARTER_DECK } = await import('../js/defaults.js');
  const parsed = parseDeck(JSON.stringify(STARTER_DECK));
  assert.equal(parsed.error, undefined);
  for (const card of parsed.cards) {
    const { encounters, correct, accuracy } = stats(card);
    const expected = accuracy <= 0.2 ? 1 : accuracy <= 0.4 ? 2 : accuracy <= 0.6 ? 3 : accuracy <= 0.8 ? 4 : 5;
    const capped = encounters < WINDOW && expected > 2 ? 2 : expected;
    assert.equal(card.score, capped,
      `${card.front} claims score ${card.score} but ${correct}/${encounters} earns ${capped}`);
  }
});

test('the history is folded onto one line so the words stay readable', () => {
  const text = serializeDeck([{ front: 'a', back: 'b', score: 1, recent: [true, false, true] }]);
  assert.match(text, /"recent": \[true, false, true\]/);
  assert.equal(text.includes('\n    true'), false);
  assert.match(serializeDeck([{ front: 'a', back: 'b', score: 1, recent: [] }]), /"recent": \[\]/);
  assert.equal(parseDeck(text).cards[0].recent.length, 3, 'still parses');
});

test('parse reports where the JSON broke', () => {
  const bad = parseDeck('[\n  {\n    "front": ,\n  }\n]');
  assert.match(bad.error, /line 3/);
  assert.equal(parseDeck('{}').error, 'The deck must be a JSON array of cards, starting with [ and ending with ].');
  assert.match(parseDeck('[{"front":"a"}]').error, /Card 1 needs both/);
  assert.match(parseDeck('[null]').error, /Card 1 is not an object/);
});

test('a watchlist converts into cards', () => {
  const watchlist = JSON.stringify({
    items: [
      { id: 'w1', term: 'cải tiến', english: 'to improve', notes: 'n', score: 3, recent_results: [true, false], last_seen: '2026-01-01' },
      { id: 'w2', term: 'no english here' },
    ],
  });
  const out = importWatchlist(watchlist);
  assert.equal(out.cards.length, 1, 'an item with no meaning cannot be a card');
  assert.equal(out.cards[0].front, 'cải tiến');
  assert.deepEqual(out.cards[0].recent, [true, false]);
  assert.match(importWatchlist('[]').error, /items/);
});

test('weighted picking draws without replacement and favours weak cards', () => {
  const pool = [card(), card(), card()].map((c, i) => ({ ...c, front: String(i) }));
  const drawn = pickWeighted(pool, 3);
  assert.equal(new Set(drawn.map((c) => c.front)).size, 3);
  assert.equal(pickWeighted(pool, 9).length, 3, 'cannot draw more than exist');

  const weak = { ...card(), score: 1 };
  const strong = { ...card(), score: 5 };
  let weakFirst = 0;
  for (let i = 0; i < 400; i++) if (pickWeighted([weak, strong], 1)[0] === weak) weakFirst++;
  assert.ok(weakFirst > 300, `weak card should dominate, drawn ${weakFirst}/400`);
});

test('scope filters by score', () => {
  assert.equal(inScope({ score: 2 }, 'weak'), true);
  assert.equal(inScope({ score: 3 }, 'weak'), false);
  assert.equal(inScope({ score: 3 }, 'developing'), true);
  assert.equal(inScope({ score: 5 }, 'all'), true);
});

test('slugify produces a safe filename', () => {
  assert.equal(slugify('Tiếng Việt — Level 3'), 'tieng-viet-level-3');
  assert.equal(slugify('///'), 'deck');
});

/* ── choosing a deck before choosing a card ──────────────────────────── */

test('cardWeight is the (6 - score) squared rule, and survives a bare card', () => {
  assert.equal(cardWeight({ score: 1 }), 25);
  assert.equal(cardWeight({ score: 5 }), 1);
  assert.equal(cardWeight({}), 25, 'a card with no score is treated as the weakest');
});

test('pickGroup returns one of the groups, or null when there are none', () => {
  const a = { name: 'a', cards: [card()] };
  const b = { name: 'b', cards: [card()] };
  assert.ok([a, b].includes(pickGroup([a, b])));
  assert.equal(pickGroup([]), null);
  assert.equal(pickGroup([a]), a, 'one group is always the answer');
});

test('a deck is drawn in proportion to the weight of the cards in it', () => {
  /* Two weak cards against one mastered card: the weak deck should win about
     50 times out of 51, which is exactly what drawing from one flat pool would
     have done. Ticking a second deck must not change how often the first is
     practised. */
  const weak = { name: 'weak', cards: [{ ...card(), score: 1 }, { ...card(), score: 1 }] };
  const strong = { name: 'strong', cards: [{ ...card(), score: 5 }] };
  let weakWins = 0;
  for (let i = 0; i < 1000; i++) if (pickGroup([weak, strong]).name === 'weak') weakWins++;
  assert.ok(weakWins > 900, `weak deck should dominate, drawn ${weakWins}/1000`);
  assert.ok(weakWins < 1000, 'but the strong deck must still come up sometimes');
});

test('an empty group cannot be drawn when a non-empty one exists', () => {
  const empty = { name: 'empty', cards: [] };
  const full = { name: 'full', cards: [card()] };
  for (let i = 0; i < 50; i++) assert.equal(pickGroup([empty, full]).name, 'full');
});

test('an opened file is read as a deck, else as a watchlist', () => {
  const deck = parseDeckFile('[{"front":"hola","back":"hello"}]');
  assert.equal(deck.format, 'deck');
  assert.equal(deck.cards[0].front, 'hola');
  const wl = parseDeckFile('{"items":[{"term":"cải tiến","english":"to improve"}]}');
  assert.equal(wl.format, 'watchlist');
  assert.equal(wl.cards[0].back, 'to improve');
  assert.match(parseDeckFile('{"nope":1}').error, /JSON array/);
  assert.match(parseDeckFile('[{"front":').error, /./);
});

test('an accent slip flags the card until it is typed exactly', () => {
  const c = card();
  recordResult(c, false, { accentSlip: true });
  assert.equal(c.accent_slip, true);
  assert.deepEqual(c.recent, [false], 'still scored as wrong');
  assert.ok(inScope(c, 'accents'));

  recordResult(c, false);
  assert.equal(c.accent_slip, true, 'a plain miss leaves the flag alone');

  recordResult(c, true, { typedFront: false });
  assert.equal(c.accent_slip, true, 'getting the meaning right does not clear it');

  recordResult(c, true);
  assert.equal(c.accent_slip, undefined, 'an exact answer clears it');
  assert.ok(!inScope(c, 'accents'));
});

test('the Accents scope selects on the flag alone, whatever the score', () => {
  const strong = { ...card(), score: 5, accent_slip: true };
  const weak = { ...card(), score: 1 };
  assert.ok(inScope(strong, 'accents'));
  assert.ok(!inScope(weak, 'accents'));
  assert.ok(inScope(weak, 'weak'), 'the other scopes are untouched');
  assert.ok(inScope(strong, 'all'));
});

test('accent_slip round-trips through a save, and only when set', () => {
  const [flagged, clean] = parseDeck(serializeDeck([
    { ...card(), front: 'a', accent_slip: true },
    { ...card(), front: 'b' },
  ])).cards;
  assert.equal(flagged.accent_slip, true);
  assert.ok(!('accent_slip' in clean));
  assert.ok(!serializeDeck([clean]).includes('accent_slip'));
});

test('accepting a meaning turns the last answer right, through the same rules', () => {
  const c = card([true, true, true, true, true, true, false]);
  recordResult(c, false);
  assert.equal(c.score, 4, '6/8 = 75%');
  const move = amendLastToRight(c);
  assert.deepEqual(c.recent, [true, true, true, true, true, true, false, true],
    'the miss is replaced, not added to');
  assert.equal(move.after, 5, '7/8 = 87.5%');
  assert.equal(c.score, 5);
});

test('accepting a meaning does not clear an accent flag', () => {
  const c = { ...card(), accent_slip: true };
  recordResult(c, false);
  amendLastToRight(c);
  assert.equal(c.accent_slip, true, 'the accents were never the thing being judged');
});

test('alternatives are added once, kept through a save, and count as meanings', () => {
  const same = (a, b) => a.toLowerCase().replace(/[!,]/g, '') === b.toLowerCase().replace(/[!,]/g, '');
  const c = { ...card(), front: 'khỏi thối', back: 'Keep the change!' };
  assert.equal(addAlternative(c, 'keep the change', same), false, 'already the back');
  assert.equal(addAlternative(c, 'Auntie, keep the change', same), true);
  assert.equal(addAlternative(c, 'auntie keep the change', same), false, 'already an alternative');
  assert.equal(addAlternative(c, '   ', same), false, 'nothing to add');
  assert.deepEqual(meanings(c), ['Keep the change!', 'Auntie, keep the change']);

  const text = serializeDeck([c]);
  const [back] = parseDeck(text).cards;
  assert.deepEqual(back.alternatives, ['Auntie, keep the change']);
  assert.ok(text.indexOf('"alternatives"') < text.indexOf('"score"'),
    'sits with the meaning, above the history');
  assert.ok(!serializeDeck([card()]).includes('alternatives'), 'absent when empty');
  assert.ok(!('alternatives' in normalizeCard({ front: 'a', back: 'b', alternatives: ['', '  '] })));
});
