/* The Reading tab's decisions: which cards a text is written around, what
   the prompt is told about them, and how the marked-up reply is read back
   into plain text and clickable words. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  READING_PRESETS, pickReadingCards, readingTermListing, readingVars, readReading, clampTerms,
  nextReadingId, readingAudioPath, readingRow, speakableText,
} from '../js/reading.js';
import { DEFAULT_READING_PROMPT, withDefaults } from '../js/defaults.js';
import { fillTemplate } from '../js/gemini.js';

const word = (front, back = 'meaning') => ({ front, back, score: 1, recent: [] });
const pattern = (front, back = 'meaning') => ({ ...word(front, back), type: 'pattern' });
/* The first n, in order: the weighting is deck.js's and tested there. */
const firstN = (pool, n) => pool.slice(0, n);

/* ── choosing the cards ──────────────────────────────────────────────── */

test('patterns get about a quarter of the text when the decks have them', () => {
  const cards = [...Array.from({ length: 20 }, (_, i) => word(`w${i}`)), ...Array.from({ length: 10 }, (_, i) => pattern(`p${i} …`))];
  const picked = pickReadingCards(cards, 12, firstN);
  assert.equal(picked.length, 12);
  assert.equal(picked.filter((c) => c.type === 'pattern').length, 3);
});

test('a small text with patterns available still gets one', () => {
  const picked = pickReadingCards([word('a'), word('b'), word('c'), pattern('x … y')], 2, firstN);
  assert.deepEqual(picked.map((c) => c.front), ['x … y', 'a']);
});

test('without patterns every slot is a word, and without words every slot is a pattern', () => {
  assert.equal(pickReadingCards([word('a'), word('b'), word('c')], 3, firstN).length, 3);
  const onlyPatterns = pickReadingCards([pattern('a … b'), pattern('c … d'), pattern('e … f')], 3, firstN);
  assert.equal(onlyPatterns.length, 3);
});

test('whichever kind runs short, the other fills in', () => {
  const picked = pickReadingCards([word('a'), pattern('p … q'), pattern('r … s'), pattern('t … u')], 4, firstN);
  assert.equal(picked.length, 4, 'one word is all there is, so the patterns make up the rest');
});

test('never more cards than there are, and a word in two decks only once', () => {
  assert.equal(pickReadingCards([word('a'), word('b')], 10, firstN).length, 2);
  assert.equal(pickReadingCards([word('a'), word('a'), word('b')], 10, firstN).length, 2);
  assert.deepEqual(pickReadingCards([], 10, firstN), []);
});

test('the number of cards is kept to what a text can hold', () => {
  assert.equal(clampTerms(0), 1);
  assert.equal(clampTerms(500), 40);
  assert.equal(clampTerms('12'), 12);
  assert.equal(clampTerms('lots'), READING_PRESETS[0].terms);
});

/* ── the prompt ──────────────────────────────────────────────────────── */

test('each card is numbered from 1, and a pattern says it is one', () => {
  const listing = readingTermListing([word('tiện lợi', 'convenient'), pattern('hễ … là …', 'whenever … then …')]);
  const [first, second] = listing.split('\n');
  assert.equal(first, '1. "tiện lợi" (convenient)');
  assert.match(second, /^2\. the grammar pattern "hễ … là …", meaning "whenever … then …"/);
  assert.match(second, /gap/);
});

test('the prompt carries the request, the cards and the language', () => {
  const s = withDefaults(null);
  const prompt = fillTemplate(DEFAULT_READING_PROMPT, readingVars(s, [word('tiện lợi')], 'A poem about rain.'));
  assert.match(prompt, /<request>\nA poem about rain\.\n<\/request>/);
  assert.match(prompt, /1\. "tiện lợi"/);
  assert.match(prompt, new RegExp(s.targetLanguage));
  assert.doesNotMatch(prompt, /\{(request|terms|language|level)\}/);
});

test('an empty request asks for the first preset', () => {
  assert.equal(readingVars(withDefaults(null), [], '   ').request, READING_PRESETS[0].request);
});

test('the presets are the three the tab offers, each with a full request', () => {
  assert.deepEqual(READING_PRESETS.map((p) => p.label), ['Short story', 'Long news article', 'Presentation']);
  for (const p of READING_PRESETS) {
    assert.ok(p.request.length > 150, `${p.label} is a detailed request`);
    assert.ok(p.terms >= 1 && p.terms <= 40);
  }
});

test('an older settings file gains the reading prompt and a sane card count', () => {
  const s = withDefaults({ prompts: { sentence: 'mine' }, readingTerms: 'nonsense' });
  assert.equal(s.prompts.sentence, 'mine');
  assert.equal(s.prompts.reading, DEFAULT_READING_PROMPT);
  assert.equal(s.readingTerms, withDefaults(null).readingTerms);
  assert.equal(withDefaults({ readingTerms: 99 }).readingTerms, 40);
});

/* ── the reply ───────────────────────────────────────────────────────── */

const CARDS = [word('tiện lợi'), pattern('hễ … là …'), word('căn cứ')];

test('the title and the paragraphs are read from their labels', () => {
  const r = readReading('TITLE: Một ngày mưa\nTEXT:\nĐoạn một.\n\nĐoạn hai.', CARDS);
  assert.equal(r.title, 'Một ngày mưa');
  assert.deepEqual(r.paragraphs, [[{ text: 'Đoạn một.' }], [{ text: 'Đoạn hai.' }]]);
  assert.deepEqual(r.used, []);
});

test('a marked word becomes a run pointing at its card', () => {
  const r = readReading('TITLE: T\nTEXT:\nNó rất [[1|tiện lợi]] cho tôi.', CARDS);
  assert.deepEqual(r.paragraphs[0], [
    { text: 'Nó rất ' }, { text: 'tiện lợi', item: 0 }, { text: ' cho tôi.' },
  ]);
  assert.deepEqual(r.used, [0]);
});

test('a pattern marked in its parts is one card, with its gap left plain', () => {
  const r = readReading('TEXT:\n[[2|Hễ]] trời mưa [[2|là]] tôi ở nhà.', CARDS);
  assert.deepEqual(r.paragraphs[0], [
    { text: 'Hễ', item: 1 }, { text: ' trời mưa ' }, { text: 'là', item: 1 }, { text: ' tôi ở nhà.' },
  ]);
  assert.deepEqual(r.used, [1]);
});

test('the words inside a mark are what the text says, not what the card says', () => {
  const r = readReading('TEXT:\nAyer [[1|fuimos]] al mercado.', [word('ir', 'to go')]);
  assert.deepEqual(r.paragraphs[0][1], { text: 'fuimos', item: 0 });
});

test('a mark with a number no card has is kept as plain text', () => {
  const r = readReading('TEXT:\nMột [[9|chữ]] lạ.', CARDS);
  assert.deepEqual(r.paragraphs[0], [{ text: 'Một ' }, { text: 'chữ' }, { text: ' lạ.' }]);
  assert.deepEqual(r.used, []);
});

test('loose marks are still read: spaces, and a colon for the bar', () => {
  const r = readReading('TEXT:\nRất [[ 1 : tiện lợi ]].', CARDS);
  assert.deepEqual(r.paragraphs[0][1], { text: 'tiện lợi', item: 0 });
});

test('a word the model used but did not mark is marked where it stands', () => {
  const r = readReading('TEXT:\nKhông thể căn cứ vào bề ngoài. Rất [[1|tiện lợi]].', CARDS);
  assert.deepEqual(r.paragraphs[0].slice(0, 3), [
    { text: 'Không thể ' }, { text: 'căn cứ', item: 2 }, { text: ' vào bề ngoài. Rất ' },
  ]);
  assert.deepEqual(r.used, [0, 2]);
});

test('an unmarked word is only found whole, and a pattern is never guessed at', () => {
  const r = readReading('TEXT:\nNhững cái tiện lợiích và hễ mưa là ở nhà.', CARDS);
  assert.deepEqual(r.used, [], 'part of a longer word is not the word, and a pattern needs its marks');
});

test('an unmarked word is found whatever its case', () => {
  const r = readReading('TEXT:\nCăn cứ vào đó.', CARDS);
  assert.deepEqual(r.paragraphs[0][0], { text: 'Căn cứ', item: 2 });
});

test('bold, headings, code fences and marks in the title are tidied away', () => {
  const r = readReading('```\nTITLE: **Về [[1|tiện lợi]]**\nTEXT:\n## Phần một\nCâu **một**.\n```', CARDS);
  assert.equal(r.title, 'Về tiện lợi');
  assert.deepEqual(r.paragraphs, [[{ text: 'Phần một\nCâu một.' }]]);
});

test('a reply with no labels is all text, and an empty one is nothing', () => {
  const r = readReading('Just a paragraph.', CARDS);
  assert.equal(r.title, '');
  assert.deepEqual(r.paragraphs, [[{ text: 'Just a paragraph.' }]]);
  assert.equal(readReading('TITLE: Only a title\nTEXT:\n', CARDS), null);
  assert.equal(readReading('', CARDS), null);
});

test('Windows line endings do not merge paragraphs', () => {
  const r = readReading('TEXT:\r\nOne.\r\n\r\nTwo.', CARDS);
  assert.equal(r.paragraphs.length, 2);
});

/* ── keeping texts ───────────────────────────────────────────────────── */

test('a text is named by its day and a count within it, never reusing a name', () => {
  const day = new Date('2026-09-26T10:00:00Z');
  assert.equal(nextReadingId([], day), 'r_20260926_0001');
  assert.equal(nextReadingId([{ id: 'r_20260926_0001' }, { id: 'r_20260925_0001' }], day), 'r_20260926_0002');
  assert.equal(nextReadingId([{ id: 'r_20260926_0002' }], day), 'r_20260926_0003',
    'one deleted from the middle does not hand out a name still in use');
});

test('a row says whether the text has audio, and what it was made from', () => {
  const record = {
    id: 'r_20260926_0001', title: 'Mưa', created: '2026-09-26', level: 'intermediate', language: 'Vietnamese',
    items: [{ deck: 'a' }, { deck: 'b' }, { deck: 'a' }], used: [0, 2], paragraphs: [],
    audio: null,
  };
  const row = readingRow(record);
  assert.deepEqual(row.decks, ['a', 'b']);
  assert.equal(row.used, 2);
  assert.equal(row.items, 3);
  assert.equal(row.audio, '');
  assert.equal(readingRow({ ...record, audio: { file: 'reading/r_20260926_0001.ogg' } }).audio, 'reading/r_20260926_0001.ogg');
});

test('what is read aloud is the title and the text, without the marks', () => {
  const r = readReading('TITLE: Một ngày mưa\nTEXT:\n[[2|Hễ]] trời mưa [[2|là]] tôi ở nhà.\n\nRất [[1|tiện lợi]].', CARDS);
  assert.equal(speakableText(r), 'Một ngày mưa\n\nHễ trời mưa là tôi ở nhà.\n\nRất tiện lợi.');
});

test('every file a kept text makes is inside the data layout, so backups carry it', async () => {
  const { dataPath } = await import('../js/storage.js');
  for (const path of [readingAudioPath('r_20260926_0001', 'ogg'), readingAudioPath('r_20260926_0001', 'wav'),
    'reading/r_20260926_0001.json', 'reading/manifest.json']) {
    assert.equal(dataPath(path), path, `${path} would be left out of a backup`);
  }
});

test('the Read aloud voice is kept when it is a voice, and otherwise means any', () => {
  assert.equal(withDefaults(null).readingVoice, '');
  assert.equal(withDefaults({ readingVoice: 'Kore' }).readingVoice, 'Kore');
  assert.equal(withDefaults({ readingVoice: 'NotAVoice' }).readingVoice, '', 'a dropped voice falls back to a drawn one');
});
