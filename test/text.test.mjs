import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalize, words, base, contains, containsLoosely, diff, termPieces,
  compareAnswer, compareMeaning, meaningVariants, accentMarks,
} from '../js/text.js';

test('normalize keeps diacritics but drops case and punctuation', () => {
  assert.equal(normalize('  Tôi KHÔNG rành, đường!  '), 'tôi không rành đường');
  assert.equal(normalize('“quoted” — dashed'), 'quoted dashed');
  assert.deepEqual(words(''), []);
});

test('base strips diacritics across languages', () => {
  assert.equal(base('rành'), 'ranh');
  assert.equal(base('đường'), 'duong');
  assert.equal(base('Corazón'), 'corazon');
  assert.equal(base('Grüße'), 'grüße'.normalize('NFD').replace(/[̀-ͯ]/g, ''));
  assert.equal(base('für'), 'fur');
});

test('contains matches a whole phrase verbatim and ignores parentheticals', () => {
  const w = words('Tôi phải đóng học phí trước ngày mai.');
  assert.equal(contains(w, 'đóng (học phí)'), true);
  assert.equal(contains(w, 'đóng học phí'), true);
  assert.equal(contains(w, 'dong hoc phi'), false, 'accents must match');
  assert.equal(contains(w, 'học đóng'), false, 'order matters');
  assert.equal(contains(w, ''), false);
});

test('an accent slip is one wrong-accent word, not a missing plus an extra', () => {
  const d = diff(words('tôi không rành đường'), words('tôi khong rành đường'));
  assert.equal(d.accent, 1);
  assert.equal(d.missing, 0);
  assert.equal(d.extra, 0);
  assert.equal(d.ok, 3);
  assert.deepEqual(d.tokens.map((t) => t.kind), ['ok', 'accent', 'ok', 'ok']);
});

test('a dropped word is exactly one missing', () => {
  const d = diff(words('một hai ba bốn'), words('một hai bốn'));
  assert.equal(d.missing, 1);
  assert.equal(d.extra, 0);
  assert.equal(d.tokens.find((t) => t.kind === 'missing').text, 'ba');
});

test('an invented word is exactly one extra', () => {
  const d = diff(words('một hai ba'), words('một hai xyz ba'));
  assert.equal(d.extra, 1);
  assert.equal(d.missing, 0);
  assert.equal(d.ok, 3);
});

test('diff of identical input is all ok', () => {
  const d = diff(words('một hai ba'), words('Một, hai ba!'));
  assert.equal(d.ok, 3);
  assert.equal(d.accent + d.missing + d.extra, 0);
});

test('empty transcription marks every word missing', () => {
  const d = diff(words('một hai ba'), words(''));
  assert.equal(d.missing, 3);
  assert.equal(d.ok, 0);
});

test('compareAnswer separates a wrong word from wrong accents', () => {
  assert.equal(compareAnswer('cải tiến', 'Cải Tiến'), 'exact');
  assert.equal(compareAnswer('cai tien', 'cải tiến'), 'accent');
  assert.equal(compareAnswer('tận hưởng', 'cải tiến'), 'wrong');
  assert.equal(compareAnswer('', 'cải tiến'), 'wrong');
});

test('accentMarks flags only the characters that differ', () => {
  const marks = accentMarks('cai tien', 'cải tiến');
  assert.equal(marks.length, 8);
  assert.deepEqual(marks.filter((m) => m.bad).map((m) => m.ch), ['a', 'e']);
});

test('a pattern front matches when its fixed parts appear in order, with words between', () => {
  const w = (s) => words(s);
  assert.ok(contains(w('Hễ trời mưa là tôi ở nhà.'), 'hễ … là …'));
  assert.ok(contains(w('Không những đẹp mà còn rẻ.'), 'không những … mà còn …'));
  assert.ok(contains(w('Tôi không ăn thịt nữa.'), 'không … nữa'));
  assert.ok(contains(w('Chính là anh ấy.'), 'chính là ...'));
  assert.ok(contains(w('Khi thì vui khi thì buồn.'), 'khi thì … khi thì …'));
  assert.ok(!contains(w('Là tôi, hễ có dịp.'), 'hễ … là …'), 'order matters');
  assert.ok(!contains(w('Khi thì vui.'), 'khi thì … khi thì …'), 'a repeated part must appear twice');
  assert.ok(!contains(w('Tôi không ăn thịt nưa.'), 'không … nữa'), 'accents still count');
});

test('capital letters are gaps only on a pattern card', () => {
  assert.deepEqual(termPieces('A mà B', true), [['mà']]);
  assert.deepEqual(termPieces('A có điều là B', true), [['có', 'điều', 'là']]);
  assert.deepEqual(termPieces('X mà còn …, huống chi Y', true), [['mà', 'còn'], ['huống', 'chi']]);
  assert.ok(contains(words('Chị ấy phụ trách mà anh lại rảnh.'), 'A mà B', true));
  assert.deepEqual(termPieces('A mà B'), [['a', 'mà', 'b']], 'not said to be a pattern: three words');
  assert.deepEqual(termPieces('A veces'), [['a', 'veces']]);
  assert.ok(contains(words('A veces llueve.'), 'A veces'));
  assert.deepEqual(termPieces('Ánh sáng', true), [['ánh', 'sáng']], 'a capital with an accent is a word');
  assert.deepEqual(termPieces('ABC', true), [['abc']], 'letters inside a word are not gaps');
});

test('a front of nothing but gaps matches nothing', () => {
  assert.equal(contains(words('bất cứ câu nào'), '…'), false);
  assert.equal(contains(words('bất cứ câu nào'), 'A, B', true), false);
});

test('containsLoosely hears a pattern whatever its accents, in order', () => {
  const heard = words('Hê trời mưa la tôi ở nhà.');
  assert.ok(!contains(heard, 'hễ … là …'));
  assert.ok(containsLoosely(heard, 'hễ … là …'));
  assert.ok(!containsLoosely(words('la tôi, hê'), 'hễ … là …'));
});

test('containsLoosely hears a word whatever its accents', () => {
  const heard = words('Tôi thấy nó rất tiện lời.');
  assert.ok(!contains(heard, 'tiện lợi'));
  assert.ok(containsLoosely(heard, 'tiện lợi'));
  assert.ok(!containsLoosely(heard, 'tiện ích'), 'a different word is still a different word');
  assert.ok(containsLoosely(words('di dau'), 'đi đâu (to go)'), 'bracketed notes are not matched on');
});

test('meanings accept one semicolon part, drop bracketed notes and an optional "to"', () => {
  const cases = [
    ['return', 'to go back; to return', 'exact'],
    ['to go back', 'to go back; to return', 'exact'],
    ['complain', 'to complain', 'exact'],
    ['to deal with', 'to handle; to deal with (penalise)', 'exact'],
    ['driving licence', 'driving licence (formal)', 'exact'],
    ['boyfriend/girlfriend', 'baby; (casual) boyfriend/girlfriend', 'exact'],
    ['Keep the change', 'Keep the change!', 'exact'],
    ['convenient, handy', 'convenient, handy (of an object/method)', 'exact'],
    ['convenient', 'convenient, handy (of an object/method)', 'wrong'],
    ["If I were him", "If I were him, I'd have quit already.", 'wrong'],
    ['go', 'to go back', 'wrong'],
    ['', 'to go', 'wrong'],
    ['to', 'to go', 'wrong'],
  ];
  for (const [typed, meaning, want] of cases) {
    assert.equal(compareMeaning(typed, meaning), want, `${JSON.stringify(typed)} vs ${JSON.stringify(meaning)}`);
  }
});

test('a meaning typed with the wrong accents is an accent miss, not a wrong one', () => {
  assert.equal(compareMeaning('cafe', 'café'), 'accent');
  assert.equal(compareMeaning('café', 'café'), 'exact');
});

test('meaningVariants never yields an empty or duplicate reading', () => {
  const v = meaningVariants('to handle; to deal with (penalise)');
  assert.deepEqual(v, [...new Set(v)], 'no duplicates');
  assert.ok(v.every((x) => x.trim()), 'nothing blank');
  assert.ok(v.includes('to handle'));
  assert.deepEqual(meaningVariants('   '), [], 'nothing to read');
});
