/* Export: a record written out as one .html file. What matters is that the
   file stands alone (no script, nothing loaded), that nothing in a record
   can run in it, that a recording is in it only when asked for, and that
   every kind of record, finished or not, comes out as a page. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  shadowingExport, readingExport, writingExport, conversationExport,
  audioPaths, gatherAudio, dataUri, mimeForPath, sizeLabel,
} from '../js/export-html.js';

const clip = (path) => [path, dataUri(path, new Uint8Array([1, 2, 3]))];

/* A file that needs nothing but itself: no script, and no address of
   anything outside it. A data: URI is the file's own content. */
function standsAlone(html) {
  assert.match(html, /^<!doctype html>/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /\b(?:src|href)="(?!data:)/i);
  assert.doesNotMatch(html, /\son\w+=/i, 'no event handler attributes');
}

/* ── audio ───────────────────────────────────────────────────────────── */

test('a recording is typed by its name, and inlined as base64', () => {
  assert.equal(mimeForPath('conversation/c_1_3.webm'), 'audio/webm');
  assert.equal(mimeForPath('shadowing/s_1_0_t2.mp4'), 'audio/mp4');
  assert.equal(mimeForPath('reading/r_1.ogg'), 'audio/ogg');
  assert.equal(mimeForPath('reading/r_1.wav'), 'audio/wav');
  assert.equal(mimeForPath('odd'), 'audio/webm');
  assert.equal(dataUri('a.ogg', new Uint8Array([1, 2, 3])), 'data:audio/ogg;base64,AQID');
});

test('the recordings are gathered by path, and one that cannot be read is named', async () => {
  const blobs = { 'a.webm': new Blob([new Uint8Array([1, 2, 3])]), 'empty.webm': new Blob([]) };
  const got = await gatherAudio(['a.webm', 'gone.webm', 'empty.webm'], async (p) => blobs[p] || null);
  assert.equal(got.audio.get('a.webm'), 'data:audio/webm;base64,AQID');
  assert.deepEqual(got.missing, ['gone.webm', 'empty.webm']);
  assert.equal(got.bytes, 3);
  assert.equal(sizeLabel(500), '1 KB');
  assert.equal(sizeLabel(840 * 1024), '840 KB');
  assert.equal(sizeLabel(2.34 * 1024 * 1024), '2.3 MB');
});

/* ── writing ─────────────────────────────────────────────────────────── */

const writing = {
  id: 'w_20260930_0001', created: '2026-09-30', kind: 'opinion', language: 'Vietnamese', level: 'A2', model: 'gemini-x',
  brief: 'Bạn thích thành phố hay nông thôn?', title: 'Bạn thích thành phố hay nông thôn?',
  cards: [{ front: 'đi', deck: 'default' }, { front: 'nếu … thì …', deck: 'default' }],
  text: 'Tôi thích thành phố.\nVì có nhiều việc.', ended: true,
  result: {
    valid: true, detectedLevel: 'A2', languageNote: 'Clear.', contentNote: 'A reason was given.',
    taskPoints: [{ point: 'Take a position', met: true, note: '' }, { point: 'Give an example', met: false, note: 'No example.' }],
    grammarMistakes: [{ description: 'Wrong classifier.', correction: 'một con mèo', cardNumber: null }],
    vocabStyle: [{ category: 'STYLE', original: 'Tôi thích', suggestions: ['Tôi ưa', 'Tôi chuộng'], reason: 'More precise.' }],
    cards: [{ index: 0, verdict: 'right', note: 'Used well.' }, { index: 1, verdict: 'absent', note: '' }],
  },
};

test('a piece of writing exports with its task, its text and every section of its feedback', () => {
  const { filename, html } = writingExport(writing);
  assert.equal(filename, 'writing-w_20260930_0001.html');
  standsAlone(html);
  assert.match(html, /<title>Bạn thích thành phố hay nông thôn\?<\/title>/);
  assert.match(html, /Tôi thích thành phố\.\nVì có nhiều việc\./, 'the text, line breaks kept');
  assert.match(html, /This reads at <strong>A2<\/strong>/);
  assert.match(html, /✗<\/span> Give an example<span class="sub">No example\.<\/span>/);
  assert.match(html, /Wrong classifier\. → <ins lang="vi">một con mèo<\/ins>/);
  assert.match(html, /Tôi ưa \/ Tôi chuộng/);
  assert.match(html, /<strong lang="vi">đi<\/strong> — <span class="ok">Right<\/span><span class="sub">Used well\.<\/span>/);
  assert.match(html, /nếu … thì …<\/strong> — <span class="">Not used<\/span>/);
  assert.doesNotMatch(html, /<audio/, 'writing has no audio');
  assert.match(html, /written by an AI model/);
});

test('a draft exports as a draft, and a piece not counted says so', () => {
  const draft = writingExport({ ...writing, result: null, ended: false, text: 'Tôi' }).html;
  assert.match(draft, /Not handed in yet: this is a draft/);
  assert.match(draft, /Flashcards to try to use/);
  assert.doesNotMatch(draft, /Grammar and spelling/);
  const invalid = writingExport({ ...writing, result: { valid: false, reason: 'Not in Vietnamese.' } }).html;
  assert.match(invalid, /not counted as an attempt at the task\.<\/strong> Not in Vietnamese\. Nothing was scored\./);
});

test('a summary names its text, and carries the source when it is given', () => {
  const summary = { ...writing, kind: 'summary', brief: '', readingTitle: 'Cửa hàng', title: 'Summary of Cửa hàng' };
  assert.match(writingExport(summary).html, /Summarise “Cửa hàng” in your own words\./);
  assert.doesNotMatch(writingExport(summary).html, /The text summarised/);
  assert.match(writingExport(summary, { source: { text: 'Một cửa hàng nhỏ.' } }).html, /The text summarised<\/summary><div class="box text" lang="vi">Một cửa hàng nhỏ\./);
});

test('nothing in a record can run in the file: every text is escaped', () => {
  const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>"';
  const { html } = writingExport({
    ...writing, title: evil, brief: evil, text: evil,
    cards: [{ front: evil }],
    result: { ...writing.result, languageNote: evil, taskPoints: [{ point: evil, met: false, note: evil }], grammarMistakes: [{ description: evil, correction: evil }], vocabStyle: [{ category: 'VOCAB', original: evil, suggestions: [evil], reason: evil }], cards: [{ index: 0, verdict: 'wrong', note: evil }] },
  });
  /* The text is in the file, as text: no tag of its own survives. */
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<img/);
  assert.doesNotMatch(html, /"[^"<>]*"\s*on\w+=/, 'and its quote cannot close an attribute');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

/* ── reading ─────────────────────────────────────────────────────────── */

const reading = {
  id: 'r_20260930_0001', created: '2026-09-30', title: 'Buổi sáng', language: 'Vietnamese', level: 'A2', model: 'gemini-x',
  request: 'A short story.',
  paragraphs: [[{ text: 'Tôi ' }, { text: 'đi', item: 0 }, { text: ' chợ.' }], [{ text: 'Hết.' }]],
  used: [0],
  items: [{ front: 'đi', back: 'to go', pattern: false }, { front: 'nếu … thì …', back: 'if … then …', pattern: true }],
  audio: { file: 'reading/r_20260930_0001.ogg' },
};

test('a reading text exports with its words marked, its cards and its audio', () => {
  const audio = new Map([clip('reading/r_20260930_0001.ogg')]);
  const { filename, html } = readingExport(reading, { audio });
  assert.equal(filename, 'reading-r_20260930_0001.html');
  standsAlone(html);
  assert.match(html, /<p>Tôi <mark title="to go">đi<\/mark> chợ\.<\/p>\n<p>Hết\.<\/p>/);
  assert.match(html, /<audio controls preload="none" src="data:audio\/ogg;base64,AQID"/);
  assert.match(html, /nếu … thì …<\/strong> — if … then … <span class="tag">pattern<\/span><span class="sub">not used in the text<\/span>/);
  assert.match(html, /The recordings are inside this file/);
  assert.deepEqual(audioPaths('reading', reading), ['reading/r_20260930_0001.ogg']);
  assert.deepEqual(audioPaths('reading', { ...reading, audio: null }), []);
});

test('without audio the file has no player, and says it was exported without', () => {
  const html = readingExport(reading, { audio: new Map([clip('reading/r_20260930_0001.ogg')]), withAudio: false }).html;
  assert.doesNotMatch(html, /<audio/);
  assert.doesNotMatch(html, /data:audio/);
  assert.match(html, /exported without its recordings/);
  const none = readingExport({ ...reading, audio: null }).html;
  assert.doesNotMatch(none, /recording/, 'a text never read aloud says nothing about recordings');
});

test('a recording that could not be read is said to be missing, not shown as a dead player', () => {
  const html = readingExport(reading, { audio: new Map() }).html;
  assert.doesNotMatch(html, /<audio/);
  assert.match(html, /This recording could not be read\./);
  assert.match(html, /1 recording could not be read and is not in this file\./);
});

/* ── shadowing ───────────────────────────────────────────────────────── */

const shadowing = {
  id: 's_20260930_0001', created: '2026-09-30', language: 'Vietnamese', level: 'A2',
  items: [
    { index: 0, text: 'Xin chào.', gloss: 'Hello.', file: 'shadowing/s_20260930_0001_0_t2.webm', take: 2 },
    { index: 1, text: 'Cảm ơn.', gloss: 'Thank you.', file: 'shadowing/s_20260930_0001_1.webm' },
    { index: 2, text: 'Tạm biệt.', gloss: 'Goodbye.', file: '' },
  ],
  feedback: {
    notes: [{ itemIndex: 0, comment: 'Later note.', handin: 2 }],
    handins: [
      { n: 1, lines: [0], notes: [{ itemIndex: 0, comment: 'The tone fell.', file: 'shadowing/s_20260930_0001_0.webm' }], overall: 'Steady.', focusNote: 'Tones.', model: 'gemini-x', gradedAt: '2026-09-29T10:00:00Z' },
      { n: 2, lines: [0], notes: [{ itemIndex: 0, comment: 'Better.', file: 'shadowing/s_20260930_0001_0_t2.webm' }], overall: 'Improved.', focusNote: null, model: 'gemini-x', gradedAt: '2026-09-30T10:00:00Z' },
    ],
  },
};

test('a shadowing set exports by hand-in, each note beside the take it heard', () => {
  const paths = audioPaths('shadowing', shadowing);
  assert.deepEqual(paths, [
    'shadowing/s_20260930_0001_0.webm', 'shadowing/s_20260930_0001_0_t2.webm', 'shadowing/s_20260930_0001_1.webm',
  ], 'a take an earlier hand-in heard is kept, and each file once');
  const audio = new Map(paths.map((p, i) => [p, `data:audio/webm;base64,CLIP${i}`]));
  const { filename, html } = shadowingExport(shadowing, { audio });
  assert.equal(filename, 'shadowing-s_20260930_0001.html');
  standsAlone(html);
  assert.match(html, /<h2>Hand-in 1 · 2026-09-29<\/h2>[\s\S]*The tone fell\.[\s\S]*<h2>Hand-in 2 · 2026-09-30<\/h2>[\s\S]*Better\./);
  const first = html.slice(html.indexOf('Hand-in 1'), html.indexOf('Hand-in 2'));
  assert.match(first, /CLIP0/, 'the first hand-in plays the take it heard');
  assert.doesNotMatch(first, /CLIP1/);
  assert.match(html.slice(html.indexOf('Hand-in 2')), /CLIP1/);
  assert.match(html, /<h2>Not handed in<\/h2>[\s\S]*value="2"[\s\S]*Cảm ơn\.[\s\S]*CLIP2[\s\S]*value="3"[\s\S]*Tạm biệt\./);
  assert.match(html, /<strong>To work on:<\/strong> Tones\./);
  assert.match(html, /3 lines · 2 recorded/);
});

test('a set never handed in exports its lines and recordings', () => {
  const html = shadowingExport({ ...shadowing, feedback: null }, { audio: new Map([clip('shadowing/s_20260930_0001_1.webm')]) }).html;
  assert.match(html, /<h2>The lines<\/h2>/);
  assert.doesNotMatch(html, /Hand-in/);
  assert.match(html, /1 recording could not be read/);
});

/* ── conversation ────────────────────────────────────────────────────── */

const roleplay = {
  id: 'c_20260930_0001', kind: 'roleplay', delivery: 'turns', created: '2026-09-30', language: 'Vietnamese', level: 'A2',
  title: 'Bạn muốn mua bánh mì.', maxTurns: 6, ended: true, deliveryNote: 'The tone on “bánh” rose.',
  cards: [{ front: 'đi', deck: 'default' }],
  scenario: { scenario: 'Bạn muốn mua bánh mì.', studentRole: 'Khách', llmRole: 'Người bán', openingLine: 'Chào bạn!' },
  turns: [
    { speaker: 'partner', text: 'Chào bạn!' },
    { speaker: 'learner', text: 'cho tôi một ổ', take: 'conversation/c_20260930_0001_1.webm' },
    { speaker: 'partner', text: 'Vâng.' },
    { speaker: 'learner', text: 'cảm ơn' },
  ],
  feedback: { turns: [{ turnIndex: 1, natural: 'Cho tôi một ổ bánh mì.', comment: 'Name the thing.' }, { turnIndex: 3, natural: 'Cảm ơn.', comment: 'Good.' }], cards: [{ index: 0, verdict: 'absent', note: '' }] },
};

test('a roleplay exports its scene, its turns with their recordings, and the feedback turn by turn', () => {
  const audio = new Map([clip('conversation/c_20260930_0001_1.webm')]);
  const { filename, html } = conversationExport(roleplay, { audio });
  assert.equal(filename, 'conversation-c_20260930_0001.html');
  standsAlone(html);
  assert.match(html, /Conversation: a roleplay, turn by turn/);
  assert.match(html, /2 of 6 turns/);
  assert.match(html, /<dt>The AI model played<\/dt><dd lang="vi">Người bán<\/dd>/);
  assert.match(html, /Người bán · AI model/, 'the other side is always said to be a model');
  assert.equal((html.match(/<audio/g) || []).length, 1, 'only the spoken turn has a player');
  assert.match(html, /More natural: <ins lang="vi">“Cho tôi một ổ bánh mì\.”<\/ins>/);
  assert.doesNotMatch(html, /“Cảm ơn\.”<\/ins>/, 'a suggestion that only adds a capital and a full stop is not one');
  assert.match(html, /How it sounded<\/h3><p>The tone on “bánh” rose\./);
  assert.doesNotMatch(html, /What there was to find out/);
});

const facts = [{ id: '1', label: 'ngày thu rác', detail: 'thứ ba' }, { id: '2', label: 'chìa khoá', detail: 'dưới thảm' }];
const findOut = {
  id: 'c_20260930_0002', kind: 'findout', delivery: 'turns', created: '2026-09-30', language: 'Vietnamese', title: 'Hỏi về toà nhà.',
  maxTurns: 6, ended: true, revealed: ['1'], cards: [],
  scenario: { situation: 'Bạn mới chuyển đến.', studentRole: 'Hàng xóm mới', llmRole: 'Hàng xóm', goal: 'Hỏi về toà nhà.', facts },
  turns: [{ speaker: 'partner', text: 'Chào!' }, { speaker: 'learner', text: 'Rác thu khi nào?' }, { speaker: 'partner', text: 'Thứ ba.' }],
  feedback: { conversation: 'You listened.', asking: 'Clear questions.', nextTime: 'Follow up.', found: ['ngày thu rác'], missed: ['chìa khoá'], cards: [] },
};

test('a find out exports what was found, and gives the answers only once it has ended', () => {
  const ended = conversationExport(findOut).html;
  assert.match(ended, /class="ok">✓<\/span> <span lang="vi">ngày thu rác<span class="sub">thứ ba<\/span>/);
  assert.match(ended, /○<\/span> <span lang="vi">chìa khoá<span class="sub">dưới thảm<\/span>/);
  assert.match(ended, /<strong>Next time:<\/strong> Follow up\./);
  assert.match(ended, /Never asked about: <span lang="vi">chìa khoá<\/span>/);
  const open = conversationExport({ ...findOut, ended: false, feedback: null }).html;
  assert.doesNotMatch(open, /dưới thảm|thứ ba<\/span>/, 'an open find out does not give away what is still to be found');
  assert.match(open, /This conversation has no feedback yet\./);
  assert.match(open, /not finished/);
});

const live = {
  ...findOut, id: 'c_20260930_0003', delivery: 'live', seconds: 120, talked: 95, take: 'conversation/c_20260930_0003_live.webm',
  feedback: {
    score: 70, bands: { pronunciation: 3, flow: 2, grammar: 3, wordChoice: 3 }, reasons: { flow: 'Pauses inside phrases.' }, overall: 'A real conversation.',
    lines: [
      { speaker: 'partner', text: 'Chào!', corrections: [], alternatives: [] },
      { speaker: 'learner', text: 'Rác thu khi nào', corrections: [{ original: 'thu', correction: 'được thu', why: 'Passive.' }], alternatives: [{ original: 'khi nào', suggestions: ['lúc nào'], why: 'Spoken.' }] },
    ],
    pronunciation: [{ word: 'rác', comment: 'The tone should rise.' }], cards: [],
  },
};

test('a live conversation exports its score, its marks, the recording and the lines as said', () => {
  const audio = new Map([clip('conversation/c_20260930_0003_live.webm')]);
  const html = conversationExport(live, { audio }).html;
  standsAlone(html);
  assert.match(html, /Conversation: a find out, held live/);
  assert.match(html, /1 min 35 s talked/);
  assert.match(html, /<span class="score">70%<\/span>/);
  assert.match(html, /<strong>Flow<\/strong>: 2 of 4<span class="sub">Pauses inside phrases\.<\/span>/);
  assert.equal((html.match(/<audio/g) || []).length, 1);
  assert.match(html, /<del lang="vi">thu<\/del> → <ins lang="vi">được thu<\/ins>/);
  assert.match(html, /More natural: <ins lang="vi">“lúc nào”<\/ins>/);
  assert.match(html, /<strong lang="vi">rác<\/strong> The tone should rise\./);
  /* One from before live was a way of holding a conversation. */
  assert.match(conversationExport({ ...live, kind: 'live', delivery: undefined }, { audio }).html, /a find out, held live/);
  /* Talked, recorded, and never graded: the recording and the running lines. */
  const ungraded = conversationExport({ ...live, ended: false, feedback: null }, { audio }).html;
  assert.match(ungraded, /<h2>The recording · 1 min 35 s<\/h2>\s*<audio/);
  assert.match(ungraded, /Rác thu khi nào\?/);
  assert.match(ungraded, /no feedback yet/);
});
