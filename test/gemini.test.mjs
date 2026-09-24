import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fillTemplate, buildTermListing, sentenceVars, parseSentence, sentenceProblem,
  RateLimiter, QuotaError, pcmToWav, formatWait, nextBankId, sidecarText, pickVoice, createClient,
} from '../js/gemini.js';
import { DEFAULT_SETTINGS, withDefaults } from '../js/defaults.js';

const TERMS = [
  { front: 'cải tiến', back: 'to improve' },
  { front: 'tận hưởng', back: '' },
];

/* ── prompts ─────────────────────────────────────────────────────────── */

test('fillTemplate substitutes known keys and leaves unknown ones alone', () => {
  assert.equal(fillTemplate('{a}/{b}/{c}', { a: 1, b: 'two' }), '1/two/{c}');
  assert.equal(fillTemplate('', {}), '');
});

test('the term listing carries the meaning only when there is one', () => {
  assert.equal(buildTermListing(TERMS), '- "cải tiến" (to improve)\n- "tận hưởng"');
});

test('the default prompt renders with nothing left over', () => {
  const out = fillTemplate(DEFAULT_SETTINGS.prompts.sentence, sentenceVars(DEFAULT_SETTINGS, TERMS));
  assert.equal(out.match(/\{\w+\}/g), null);
  assert.ok(out.includes('Vietnamese'));
  assert.ok(out.includes('8-16 words'));
  assert.ok(out.includes('cải tiến'));
});

test('switching language changes what is sent', () => {
  const spanish = withDefaults({ targetLanguage: 'Spanish', learnerLevel: 'beginner' });
  const out = fillTemplate(spanish.prompts.sentence, sentenceVars(spanish, TERMS));
  assert.ok(out.includes('single Spanish dictation sentence'));
  assert.ok(out.includes('beginner learner'));
  assert.equal(out.includes('Vietnamese'), false);
});

test('parseSentence reads the labels in any case, past bullets and quotes', () => {
  assert.deepEqual(parseSentence('TARGET: Tôi đi học.\nEN: I go to school.'),
    { target: 'Tôi đi học.', english: 'I go to school.' });
  assert.deepEqual(parseSentence('target: "Tôi đi học."\nen: I go.'),
    { target: 'Tôi đi học.', english: 'I go.' });
  assert.deepEqual(parseSentence('- VI: Tôi đi học.\n- EN: I go.'),
    { target: 'Tôi đi học.', english: 'I go.' });
});

test('parseSentence falls back to the first two lines when labels are absent', () => {
  assert.deepEqual(parseSentence('\nTôi đi học.\nI go to school.\n'),
    { target: 'Tôi đi học.', english: 'I go to school.' });
  assert.deepEqual(parseSentence(''), { target: '', english: '' });
});

test('sentenceProblem rejects what would make a bad answer key', () => {
  const s = DEFAULT_SETTINGS;
  const good = 'Quán ăn vừa cải tiến để khách được tận hưởng bữa ăn.';
  assert.equal(sentenceProblem(good, TERMS, s), null);
  assert.equal(sentenceProblem('', TERMS, s), 'empty');
  assert.match(sentenceProblem('Tôi cải tiến tận hưởng.', TERMS, s), /too short/);
  assert.match(sentenceProblem(Array(60).fill('từ').join(' '), TERMS, s), /too long/);
  assert.match(sentenceProblem('Quán ăn vừa cải tiến chất lượng dịch vụ rất nhiều.', TERMS, s),
    /missing target word\(s\): tận hưởng/);
});

test('sentenceProblem follows the configured sentence length', () => {
  const long = withDefaults({ sentenceWords: { min: 25, max: 40 } });
  const twelve = 'Quán ăn vừa cải tiến để cho khách được tận hưởng bữa ăn';
  assert.equal(sentenceProblem(twelve, TERMS, DEFAULT_SETTINGS), null);
  assert.match(sentenceProblem(twelve, TERMS, long), /too short/);
});

/* ── budget ──────────────────────────────────────────────────────────── */

function limiter(startAt = 1_000_000) {
  const clock = { t: startAt };
  const lim = new RateLimiter({ now: () => clock.t });
  return { lim, clock };
}

async function take(lim, rpm, rpd) {
  try {
    await lim.reserve('m', rpm, rpd);
    return 'ok';
  } catch (e) {
    assert.ok(e instanceof QuotaError);
    return Math.ceil(e.retryAfter);
  }
}

test('the per-minute limit blocks the next call and frees it after a minute', async () => {
  const { lim, clock } = limiter();
  for (let i = 0; i < 4; i++) assert.equal(await take(lim, 4, 20), 'ok');
  assert.equal(await take(lim, 4, 20), 60);
  clock.t += 59;
  assert.equal(await take(lim, 4, 20), 1);
  clock.t += 1;
  assert.equal(await take(lim, 4, 20), 'ok');
});

test('the daily limit blocks for the rest of the rolling day', async () => {
  const { lim, clock } = limiter();
  /* Six calls spread over ten minutes, then the clock sits 12 minutes past
     the first one — which is when its slot comes back. */
  for (let i = 0; i < 6; i++) { assert.equal(await take(lim, 0, 6), 'ok'); clock.t += 120; }
  assert.equal(await take(lim, 0, 6), 24 * 3600 - 720);
  clock.t += 24 * 3600 - 720;
  assert.equal(await take(lim, 0, 6), 'ok');
});

test('zero means unlimited', async () => {
  const { lim } = limiter();
  for (let i = 0; i < 50; i++) assert.equal(await take(lim, 0, 0), 'ok');
});

test('a cool-off blocks a model that would otherwise be free', async () => {
  const { lim, clock } = limiter();
  lim.coolOff('m', 60);
  assert.equal(await take(lim, 4, 20), 60);
  clock.t += 60;
  assert.equal(await take(lim, 4, 20), 'ok');
});

test('the report refuses generation when either model is exhausted', async () => {
  const { lim } = limiter();
  const settings = withDefaults({ limits: { textRpm: 4, textRpd: 20, ttsRpm: 2, ttsRpd: 10 } });
  assert.equal(lim.report(settings).canGenerate, true);

  await lim.reserve(settings.ttsModel, 2, 10);
  await lim.reserve(settings.ttsModel, 2, 10);
  const report = lim.report(settings);
  assert.equal(report.canGenerate, false, 'speech is out even though text is free');
  assert.equal(report.text.retryAfter, 0);
  assert.ok(report.tts.retryAfter > 0);
  assert.equal(report.retryAfter, report.tts.retryAfter);
});

test('cards left today is the scarcer of the two models', async () => {
  const { lim } = limiter();
  const settings = withDefaults({ limits: { textRpm: 0, textRpd: 20, ttsRpm: 0, ttsRpd: 10 } });
  assert.equal(lim.report(settings).cardsLeftToday, 10);
  await lim.reserve(settings.ttsModel, 0, 10);
  assert.equal(lim.report(settings).cardsLeftToday, 9);
  assert.equal(lim.report(withDefaults({ limits: { textRpd: 0, ttsRpd: 0 } })).cardsLeftToday, null);
});

test('state survives a round trip and forgets what is older than a day', () => {
  const { lim, clock } = limiter();
  const old = clock.t - 25 * 3600;
  const fresh = clock.t - 10;
  const next = new RateLimiter({ now: () => clock.t });
  next.setState({ calls: { m: [old, fresh] }, blocked_until: { m: clock.t - 5, n: clock.t + 30 } });
  assert.deepEqual(next.getState().calls.m, [fresh]);
  assert.deepEqual(Object.keys(next.getState().blocked_until), ['n'], 'an expired cool-off is dropped');
  assert.doesNotThrow(() => lim.setState(null));
});

test('reset clears everything', async () => {
  const { lim } = limiter();
  await lim.reserve('m', 1, 1);
  lim.reset();
  assert.equal(await take(lim, 1, 1), 'ok');
});

test('formatWait reads as a person would say it', () => {
  assert.equal(formatWait(0), '0s');
  assert.equal(formatWait(45.2), '46s');
  assert.equal(formatWait(187), '3m 07s');
  assert.equal(formatWait(8100), '2h 15m');
});

/* ── audio ───────────────────────────────────────────────────────────── */

test('pcmToWav writes a 44-byte RIFF header around the samples', () => {
  const pcm = new Uint8Array(100).fill(7);
  const wav = pcmToWav(pcm, 'audio/L16;rate=24000');
  assert.equal(wav.length, 144);
  const view = new DataView(wav.buffer);
  assert.equal(String.fromCharCode(...wav.slice(0, 4)), 'RIFF');
  assert.equal(String.fromCharCode(...wav.slice(8, 12)), 'WAVE');
  assert.equal(view.getUint32(4, true), 36 + 100, 'RIFF size covers header plus data');
  assert.equal(view.getUint16(20, true), 1, 'PCM');
  assert.equal(view.getUint16(22, true), 1, 'mono');
  assert.equal(view.getUint32(24, true), 24000, 'sample rate from the mime type');
  assert.equal(view.getUint32(28, true), 48000, 'byte rate');
  assert.equal(view.getUint16(34, true), 16, 'bit depth');
  assert.equal(view.getUint32(40, true), 100, 'data size');
  assert.deepEqual([...wav.slice(44, 48)], [7, 7, 7, 7]);
});

test('pcmToWav defaults the rate and passes containers through', () => {
  assert.equal(new DataView(pcmToWav(new Uint8Array(4), '').buffer).getUint32(24, true), 24000);
  assert.equal(new DataView(pcmToWav(new Uint8Array(4), 'audio/L16;rate=16000').buffer).getUint32(24, true), 16000);
  const riff = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2]);
  assert.equal(pcmToWav(riff, ''), riff, 'an existing RIFF file is untouched');
  const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1]);
  assert.equal(pcmToWav(ogg, ''), ogg);
});

/* ── bank ────────────────────────────────────────────────────────────── */

test('bank ids count today and never collide', () => {
  const first = nextBankId([]);
  assert.match(first, /^d_\d{8}_0001$/);
  assert.equal(nextBankId([{ id: first }]).endsWith('_0002'), true);
  /* A gap from a deleted entry must not hand out an id already in use. */
  const taken = [{ id: first }, { id: first.replace('0001', '0002') }];
  assert.equal(nextBankId(taken.slice(1)), first.replace('0001', '0003'));
});

test('the sidecar repeats what the manifest holds', () => {
  const text = sidecarText({
    sentence: 'Tôi đi học.', english: 'I go to school.',
    terms: ['đi', 'học'], language: 'Vietnamese', voice: 'Kore', created: '2026-01-01',
  });
  assert.equal(text, 'Tôi đi học.\nI go to school.\n[terms] đi, học\n[language] Vietnamese\n[voice] Kore\n[created] 2026-01-01\n');
});

test('the sidecar records the deck and the difficulty when the entry has them', () => {
  const text = sidecarText({
    sentence: 'Tôi đi học.', english: 'I go to school.',
    terms: ['đi', 'học'], deck: 'everyday', difficulty: 'beginner',
    language: 'Vietnamese', voice: 'Kore', created: '2026-01-01',
  });
  assert.ok(text.includes('[deck] everyday'));
  assert.ok(text.includes('[difficulty] beginner'));
  /* The difficulty is the level the sentence was written at, not whatever the
     settings say today, so it has to be on the file rather than looked up. */
  assert.equal(text.split('\n')[3], '[deck] everyday');
});

test('a voice is always picked, even from a broken pool', () => {
  assert.ok(DEFAULT_SETTINGS.voices.includes(pickVoice(DEFAULT_SETTINGS)));
  assert.equal(pickVoice(withDefaults({ voices: ['Kore'] })), 'Kore');
  assert.equal(pickVoice({ voices: ['NotARealVoice'], fallbackVoice: 'Kore' }), 'Kore');
  assert.equal(withDefaults({ voices: [] }).voices.length, 1, 'an empty pool falls back rather than staying empty');
});

/* ── thinking turned off, where the model allows it ─────────────────── */

test('a model that refuses thinkingConfig with a bare 400 is retried without it, and remembered', async () => {
  const sent = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const model = decodeURIComponent(url.match(/models\/([^:]+):/)[1]);
    const body = JSON.parse(init.body);
    const thinking = !!(body.generationConfig && body.generationConfig.thinkingConfig);
    sent.push({ model, thinking });
    if (model === 'lite' && thinking) {
      return new Response('{"error":{"code":400,"message":"Request contains an invalid argument."}}', { status: 400 });
    }
    const text = '{"rules":[{"kind":"listen","text":"Nasal vowels."}]}';
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }), { status: 200 });
  };
  try {
    let settings = withDefaults({ textModel: 'lite', models: [{ id: 'lite' }, { id: 'flash' }] });
    const client = createClient({
      getSettings: () => settings,
      getApiKey: () => 'k',
      limiter: new RateLimiter({ now: () => 1_000_000 }),
    });

    await client.draftShadowRules();
    assert.deepEqual(sent, [{ model: 'lite', thinking: true }, { model: 'lite', thinking: false }]);

    sent.length = 0;
    await client.draftShadowRules();
    assert.deepEqual(sent, [{ model: 'lite', thinking: false }], 'the refusal is remembered: one call, not two');

    /* Another model still gets thinking turned off. */
    sent.length = 0;
    settings = withDefaults({ ...settings, textModel: 'flash' });
    await client.draftShadowRules();
    assert.deepEqual(sent, [{ model: 'flash', thinking: true }]);
  } finally {
    globalThis.fetch = saved;
  }
});
