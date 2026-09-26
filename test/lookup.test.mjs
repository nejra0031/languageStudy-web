/* The selection popup's decisions: what Google Translate's reply says, which
   side of a card the selected text is, whether the deck has the word
   already, and what counts as the sentence it came from. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readTranslation, translateUrl, resolveDirection, sameLanguage, findCard,
  cleanSelection, sentenceAround, codeFor, nameFor, LANGUAGES, hasGap,
} from '../js/lookup.js';

/* ── the reply ───────────────────────────────────────────────────────── */

test('a reply gives its translation and the language it detected', () => {
  const reply = [[['convenient', 'tiện lợi', null, null, 10]], null, 'vi', null, null, null, 1];
  assert.deepEqual(readTranslation(reply), { text: 'convenient', detected: 'vi' });
});

test('a reply in several pieces is put back together', () => {
  const reply = [[['Hello. ', 'Xin chào. ', null], ['How are you?', 'Bạn khỏe không?', null]], null, 'vi'];
  assert.equal(readTranslation(reply).text, 'Hello. How are you?');
});

test('a reply that cannot be read is nothing, not half a meaning', () => {
  for (const bad of [null, {}, 'text', [], [null], [[]], [[[null]]], [[['   ']]]]) {
    assert.equal(readTranslation(bad), null, JSON.stringify(bad));
  }
  assert.deepEqual(readTranslation([[['yes', 'có']]]), { text: 'yes', detected: '' });
});

test('the request asks for the text, from and to the languages given', () => {
  const url = new URL(translateUrl('tiện lợi & co', 'auto', 'en'));
  assert.equal(url.origin + url.pathname, 'https://translate.googleapis.com/translate_a/single');
  assert.equal(url.searchParams.get('q'), 'tiện lợi & co');
  assert.equal(url.searchParams.get('sl'), 'auto');
  assert.equal(url.searchParams.get('tl'), 'en');
  assert.equal(url.searchParams.get('client'), 'gtx');
});

/* ── which way round ─────────────────────────────────────────────────── */

test('text in the student\'s own language is the meaning; anything else the word', () => {
  assert.equal(resolveDirection('en', 'vi', 'en'), 'reverse');
  assert.equal(resolveDirection('vi', 'vi', 'en'), 'forward');
  /* A third language Google thinks it saw is taken as the word: a page of
     practice mostly holds the language being learnt. */
  assert.equal(resolveDirection('fr', 'vi', 'en'), 'forward');
  assert.equal(resolveDirection('', 'vi', 'en'), 'forward');
});

test('a region or script does not make a different language', () => {
  assert.ok(sameLanguage('zh-CN', 'zh'));
  assert.ok(sameLanguage('EN', 'en-GB'));
  assert.ok(sameLanguage('he', 'iw'), 'Google has spelt Hebrew both ways');
  assert.ok(!sameLanguage('', ''));
  assert.equal(resolveDirection('en-US', 'es', 'en'), 'reverse');
});

test('with both languages the same, nothing is ever the wrong way round', () => {
  assert.equal(resolveDirection('en', 'en', 'en'), 'forward');
});

/* ── is it a card already? ───────────────────────────────────────────── */

const DECK = [
  { front: 'tiện lợi', back: 'convenient, handy', front_alternatives: ['thuận tiện'] },
  { front: 'Lời đề nghị', back: 'offer', back_alternatives: ['proposal'] },
];

test('a word is found whatever its case and punctuation', () => {
  assert.equal(findCard(DECK, { front: 'lời đề nghị!' }), DECK[1]);
  assert.equal(findCard(DECK, { front: '  Tiện lợi.' }), DECK[0]);
});

test('different accents are a different word', () => {
  /* Judged on normalize(), which keeps diacritics — as every answer is. */
  assert.equal(findCard(DECK, { front: 'tien loi' }), null);
  assert.equal(findCard(DECK, { front: 'tiện lời' }), null);
});

test('a word finds its card by an alternative form too', () => {
  assert.equal(findCard(DECK, { front: 'Thuận tiện' }), DECK[0]);
});

test('a meaning finds its card, alternatives included', () => {
  assert.equal(findCard(DECK, { back: 'Proposal' }), DECK[1]);
  assert.equal(findCard(DECK, { back: 'offer' }), DECK[1]);
  /* Only a whole meaning: one word of a longer back is not the card. */
  assert.equal(findCard(DECK, { back: 'handy' }), null);
});

test('nothing asked for, nothing found', () => {
  assert.equal(findCard(DECK, {}), null);
  assert.equal(findCard([], { front: 'x' }), null);
  assert.equal(findCard(undefined, { front: 'x' }), null);
});

/* ── the selection ───────────────────────────────────────────────────── */

test('a selection is tidied into a word or a phrase', () => {
  assert.equal(cleanSelection('  tiện\n lợi  '), 'tiện lợi');
  assert.equal(cleanSelection('"tiện lợi,"'), 'tiện lợi');
  assert.equal(cleanSelection('(học phí)'), 'học phí');
});

test('a paragraph dragged across by mistake opens nothing', () => {
  assert.equal(cleanSelection(''), '');
  assert.equal(cleanSelection('   '), '');
  assert.equal(cleanSelection('one two three four five six seven eight nine'), '');
  assert.equal(cleanSelection('x'.repeat(101)), '');
  assert.equal(cleanSelection('one two three four five six seven eight'), 'one two three four five six seven eight');
});

test('the sentence around a selection, and only that sentence', () => {
  const text = 'Tôi đi học. Điện thoại này rất tiện lợi! Còn bạn?';
  const at = text.indexOf('tiện lợi');
  assert.equal(sentenceAround(text, at, at + 'tiện lợi'.length), 'Điện thoại này rất tiện lợi!');
  assert.equal(sentenceAround(text, 0, 3), 'Tôi đi học.');
  assert.equal(sentenceAround(text, text.length - 4, text.length), 'Còn bạn?');
  assert.equal(sentenceAround('', 0, 0), '');
});

test('a very long sentence is cut down around the selection', () => {
  const text = `${'a '.repeat(300)}WORD${' b'.repeat(300)}`;
  const at = text.indexOf('WORD');
  const out = sentenceAround(text, at, at + 4, 100);
  assert.ok(out.length <= 100);
  assert.ok(out.includes('WORD'));
});

test('a language name becomes the code Google Translate takes', () => {
  assert.equal(codeFor('Vietnamese'), 'vi');
  assert.equal(codeFor(' spanish '), 'es');
  assert.equal(codeFor('Mandarin'), 'zh-CN');
  assert.equal(codeFor('pt'), 'pt');
  assert.equal(codeFor('Klingon'), '');
  assert.equal(codeFor(''), '');
  assert.equal(nameFor('vi'), 'Vietnamese');
  assert.equal(nameFor('he'), 'Hebrew');
});

test('the language list has one entry per code', () => {
  const codes = LANGUAGES.map(([c]) => c);
  assert.equal(new Set(codes).size, codes.length);
  assert.ok(codes.includes('en') && codes.includes('vi'));
});

test('a gap written as an ellipsis is what makes a pattern', () => {
  assert.ok(hasGap('hễ … là …'));
  assert.ok(hasGap('không những ... mà còn ...'));
  assert.ok(!hasGap('tiện lợi'));
  assert.ok(!hasGap('Mr. Smith'));
  /* A capital letter is a gap only on a card already marked as a pattern;
     here it may be a word, as in Spanish "A veces". */
  assert.ok(!hasGap('A mà B'));
  assert.ok(!hasGap(''));
});

test('a pattern is found in the deck whichever way its gaps are written', () => {
  const deck = [{ front: 'hễ … là …', back: 'whenever … then …', type: 'pattern' }];
  assert.equal(findCard(deck, { front: 'hễ ... là ...' }), deck[0]);
});
