/* Talking to the Gemini API straight from the page.

   There is no proxy. generativelanguage.googleapis.com answers CORS preflights
   with content-type and x-goog-api-key on its allowlist, which is exactly what
   a request needs, so fetch() from the browser works. The key is the user's
   own, entered by them, kept in their own localStorage, and sent only to
   Google.

   Two calls make one dictation card: a text model writes the sentence, a TTS
   model speaks it. Both go through the rate limiter — there is deliberately no
   path to the network that skips it, because the free tier is small enough
   that a retry storm would eat a day's budget in a minute. */

import { words, contains } from './text.js';
import { VOICE_NAMES, modelLimits } from './defaults.js';
import { buildGradingParts, readGrading, attachableClips } from './shadowing.js';
import {
  rulesFor, formatRulesBlock, buildSeedPrompt, buildRevisionPrompt, readRules,
} from './shadow-rules.js';
import { encodeOggOpus, OPUS_MIME } from './opus.js';

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent';
const MINUTE = 60;
const DAY = 24 * 60 * 60;

export class GeminiError extends Error {}
export class QuotaError extends Error {
  constructor(message, retryAfter) {
    super(message);
    this.retryAfter = retryAfter;
  }
}

/* ── prompt templating ───────────────────────────────────────────────── */

/* {name} substitution and nothing else. A placeholder we do not know is left
   alone rather than blanked, so a user's own notation survives. */
export function fillTemplate(template, vars) {
  return String(template || '').replace(/\{(\w+)\}/g, (match, name) =>
    (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match));
}

export function buildTermListing(terms) {
  return terms
    .map((t) => `- "${t.front}"` + (t.back ? ` (${t.back})` : ''))
    .join('\n');
}

export function sentenceVars(settings, terms) {
  return {
    language: settings.targetLanguage,
    level: settings.learnerLevel,
    languageNote: settings.languageNote || '',
    terms: buildTermListing(terms),
    minWords: settings.sentenceWords.min,
    maxWords: settings.sentenceWords.max,
  };
}

/* Pulls the two labelled lines back out. Falls back to the first two non-empty
   lines, so a model that ignores the format still usually yields something. */
export function parseSentence(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  let target = '';
  let english = '';
  for (const line of lines) {
    /* Models like to decorate: a bullet, a bold label, a blockquote marker.
       None of that changes which line is which. */
    const bare = line.replace(/^[\s\-*#>]+/, '');
    const m = /^(TARGET|VI|SENTENCE|EN|ENGLISH)\**\s*:\s*(.*)$/i.exec(bare);
    if (!m) continue;
    const label = m[1].toUpperCase();
    const value = cleanLine(m[2]);
    if (!target && label !== 'EN' && label !== 'ENGLISH') target = value;
    else if (!english && (label === 'EN' || label === 'ENGLISH')) english = value;
  }
  if (!target) {
    const plain = lines.map(cleanLine).filter(Boolean);
    target = plain[0] || '';
    english = english || plain[1] || '';
  }
  return { target, english };
}

function cleanLine(s) {
  let out = String(s || '').trim();
  out = out.replace(/^[-*\d.)\s]+/, '');
  out = out.replace(/^["'“‘]+/, '').replace(/["'”’]+$/, '');
  return out.trim();
}

/* These models occasionally answer with an analysis of the words instead of a
   sentence, or quietly drop a target. A bad answer key is worse than no card,
   so a candidate is checked before anything is spent on speaking it. */
export function sentenceProblem(target, terms, settings) {
  if (!target) return 'empty';
  const w = words(target);
  /* The models rarely hit an exact count, so the window is looser than what
     was asked for — but not so loose that a fragment gets through. */
  const min = Math.max(3, (settings.sentenceWords.min || 8) - 2);
  const max = (settings.sentenceWords.max || 16) + 14;
  if (w.length < min) return `too short (${w.length} words)`;
  if (w.length > max) return `too long (${w.length} words)`;
  if (target.trimStart().startsWith('>')) return 'looks like commentary, not a sentence';
  const missing = terms.filter((t) => !contains(w, t.front)).map((t) => t.front);
  if (missing.length) return 'missing target word(s): ' + missing.join(', ');
  return null;
}

/* ── rate limiting ───────────────────────────────────────────────────── */

/* Rolling windows, not calendar ones. Google resets the daily quota at
   midnight Pacific, which this page cannot reliably compute; a rolling 24h
   window can only ever be stricter than the real one, never looser. The cost
   is that the day's budget trickles back an hour at a time rather than all at
   once. */
export class RateLimiter {
  constructor({ now = () => Date.now() / 1000, save = null } = {}) {
    this.now = now;
    this.save = save;
    this.calls = {};
    this.blocked = {};
  }

  getState() {
    return { calls: this.calls, blocked_until: this.blocked };
  }

  setState(state) {
    const calls = (state && state.calls) || {};
    this.calls = {};
    for (const [model, list] of Object.entries(calls)) {
      if (Array.isArray(list)) this.calls[model] = list.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
    }
    this.blocked = {};
    const blocked = (state && state.blocked_until) || {};
    const now = this.now();
    for (const [model, until] of Object.entries(blocked)) {
      if (Number.isFinite(until) && until > now) this.blocked[model] = until;
    }
    this.prune(this.now());
  }

  prune(now) {
    for (const [model, list] of Object.entries(this.calls)) {
      this.calls[model] = list.filter((t) => now - t < DAY);
    }
  }

  persist() {
    if (this.save) Promise.resolve(this.save(this.getState())).catch(() => {});
  }

  /* Seconds until one more call to this model would be legal. 0 = now. */
  waitFor(model, rpm, rpd) {
    const now = this.now();
    this.prune(now);
    const ts = this.calls[model] || [];
    const waits = [(this.blocked[model] || 0) - now];
    if (rpd && ts.length >= rpd) waits.push(ts[ts.length - rpd] + DAY - now);
    if (rpm) {
      const recent = ts.filter((t) => now - t < MINUTE);
      if (recent.length >= rpm) waits.push(recent[recent.length - rpm] + MINUTE - now);
    }
    return Math.max(0, ...waits);
  }

  why(model, rpm, rpd) {
    const wait = this.waitFor(model, rpm, rpd);
    if (wait <= 0) return null;
    const now = this.now();
    if ((this.blocked[model] || 0) > now) {
      return `${model} hit a quota error upstream and is cooling off. Next call in ${formatWait(wait)}.`;
    }
    const ts = this.calls[model] || [];
    if (rpd && ts.length >= rpd) {
      return `Daily limit reached for ${model} (${rpd} calls/day). Next call in ${formatWait(wait)} — replaying from the bank is free until then.`;
    }
    return `Per-minute limit for ${model} (${rpm} calls/min). Next call in ${formatWait(wait)}.`;
  }

  /* Records the call before it is made. A request that then fails still counts
     — the quota was spent either way, and guessing otherwise is how a client
     ends up over the real limit. */
  async reserve(model, rpm, rpd, waitUpTo = 0) {
    const deadline = this.now() + waitUpTo;
    for (;;) {
      const wait = this.waitFor(model, rpm, rpd);
      if (wait <= 0) {
        const list = this.calls[model] || (this.calls[model] = []);
        list.push(this.now());
        this.persist();
        return;
      }
      if (this.now() + wait > deadline) throw new QuotaError(this.why(model, rpm, rpd), wait);
      await sleep(Math.min(wait, 5) * 1000 + 250);
    }
  }

  coolOff(model, seconds) {
    this.blocked[model] = Math.max(this.blocked[model] || 0, this.now() + seconds);
    this.persist();
  }

  reset() {
    this.calls = {};
    this.blocked = {};
    this.persist();
  }

  usage(model, rpm, rpd) {
    const now = this.now();
    this.prune(now);
    const ts = this.calls[model] || [];
    const usedMinute = ts.filter((t) => now - t < MINUTE).length;
    return {
      model,
      rpm,
      rpd,
      usedMinute,
      usedDay: ts.length,
      leftMinute: rpm ? Math.max(0, rpm - usedMinute) : null,
      leftDay: rpd ? Math.max(0, rpd - ts.length) : null,
      retryAfter: this.waitFor(model, rpm, rpd),
    };
  }

  /* canGenerate, retryAfter and cardsLeftToday are all about making one
     dictation card, which takes a text call and a speech call. Shadowing is
     reported alongside but deliberately left out of them: it spends neither of
     those models, and a shadowing budget that had run down must not stop you
     writing a sentence. */
  report(settings) {
    const text = this.usageOf(settings, settings.textModel);
    const tts = this.usageOf(settings, settings.ttsModel);
    const shadow = this.usageOf(settings, settings.shadowModel);
    return {
      text,
      tts,
      shadow,
      retryAfter: Math.max(text.retryAfter, tts.retryAfter),
      canGenerate: text.retryAfter <= 0 && tts.retryAfter <= 0,
      cardsLeftToday: cardsLeft(settings, text, tts),
    };
  }

  /* usage() for a model named in the settings, at the limits the catalogue
     gives that model. */
  usageOf(settings, model) {
    const { rpm, rpd } = modelLimits(settings, model);
    return this.usage(model, rpm, rpd);
  }
}

/* How many more cards today's budget holds. Normally the scarcer of the two
   models, but one model may be given both jobs — and then each card spends two
   of its calls, so what is left buys half as many. */
function cardsLeft(settings, text, tts) {
  if (settings.textModel === settings.ttsModel) {
    return text.leftDay === null ? null : Math.floor(text.leftDay / 2);
  }
  const lefts = [text.leftDay, tts.leftDay].filter((n) => n !== null);
  return lefts.length ? Math.min(...lefts) : null;
}

export function formatWait(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}m`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ── audio ───────────────────────────────────────────────────────────── */

/* Gemini TTS hands back headerless signed 16-bit PCM, described only by a mime
   type like audio/L16;rate=24000. Wrap it in a RIFF header so it is a file
   anything can play. A payload that already declares a container is passed
   through untouched. */
export function pcmToWav(bytes, mime) {
  const head = String.fromCharCode(...bytes.slice(0, 4));
  if (head === 'RIFF' || head === 'OggS' || head.slice(0, 3) === 'ID3') return bytes;

  const m = /rate=(\d+)/.exec(mime || '');
  const rate = m ? Number(m[1]) : 24000;
  const channels = 1;
  const bits = 16;
  const byteRate = (rate * channels * bits) / 8;
  const blockAlign = (channels * bits) / 8;

  const out = new Uint8Array(44 + bytes.length);
  const view = new DataView(out.buffer);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + bytes.length, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);      // fmt chunk size
  view.setUint16(20, 1, true);       // PCM
  view.setUint16(22, channels, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bits, true);
  ascii(36, 'data');
  view.setUint32(40, bytes.length, true);
  out.set(bytes, 44);
  return out;
}

/* The file a spoken sentence is saved as: Ogg Opus where the browser can
   encode it, a twelfth the size, and WAV where it cannot — see opus.js. A
   bank that already holds WAVs keeps them; each entry names its own file.
   A payload that arrives already in a container is kept as it came. */
export async function speechFile(bytes, mime) {
  const wav = pcmToWav(bytes, mime);
  if (wav === bytes) {
    const ogg = ascii4(bytes) === 'OggS';
    return { bytes, ext: ogg ? 'ogg' : 'wav', type: ogg ? OPUS_MIME : 'audio/wav' };
  }
  const m = /rate=(\d+)/.exec(mime || '');
  const opus = await encodeOggOpus(bytes, m ? Number(m[1]) : 24000);
  if (opus) return { bytes: opus, ext: 'ogg', type: OPUS_MIME };
  return { bytes: wav, ext: 'wav', type: 'audio/wav' };
}

function ascii4(bytes) {
  return String.fromCharCode(...bytes.slice(0, 4));
}

function decodeBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ── response shapes ─────────────────────────────────────────────────── */

function parts(data) {
  try {
    return data.candidates[0].content.parts || [];
  } catch (e) {
    throw new GeminiError('Unexpected response shape: ' + JSON.stringify(data).slice(0, 400));
  }
}

function firstText(data) {
  /* Thinking parts carry text too; they are not the answer. */
  const text = parts(data).filter((p) => p.text && !p.thought).map((p) => p.text).join('').trim();
  if (!text) throw new GeminiError('Model returned no text: ' + JSON.stringify(data).slice(0, 400));
  return text;
}

function firstAudio(data) {
  for (const p of parts(data)) {
    const inline = p.inlineData || p.inline_data;
    if (inline && inline.data) {
      return { bytes: decodeBase64(inline.data), mime: inline.mimeType || inline.mime_type || '' };
    }
  }
  throw new GeminiError('The speech response contained no audio: ' + JSON.stringify(data).slice(0, 400));
}

/* ── the client ──────────────────────────────────────────────────────── */

export function pickVoice(settings) {
  const pool = (settings.voices || []).filter((v) => VOICE_NAMES.includes(v));
  if (!pool.length) return settings.fallbackVoice || 'Kore';
  return pool[Math.floor(Math.random() * pool.length)];
}

export function createClient({ getSettings, getApiKey, limiter }) {
  async function call(model, body, rpm, rpd, waitUpTo = 0) {
    const key = getApiKey();
    if (!key) throw new GeminiError('No API key. Add your Gemini key in Settings.');
    await limiter.reserve(model, rpm, rpd, waitUpTo);

    let res;
    try {
      res = await fetch(ENDPOINT.replace('{model}', encodeURIComponent(model)), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw new GeminiError(`Could not reach Gemini: ${e.message}`);
    }

    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 600);
      if (res.status === 429) {
        /* The real limit is lower than the settings claim, or the key is
           shared. Back off rather than hammering it. */
        limiter.coolOff(model, MINUTE);
        throw new GeminiError(`${model} is rate-limited upstream. Lower the limits in Settings, or wait a minute.\n${detail}`);
      }
      throw new GeminiError(`${model} returned HTTP ${res.status}: ${detail}`);
    }
    return res.json();
  }

  /* One text call, one token, to prove a key works. */
  async function testKey() {
    const s = getSettings();
    const l = modelLimits(s, s.textModel);
    const data = await call(s.textModel, {
      contents: [{ parts: [{ text: 'Reply with the single word: ok' }] }],
      generationConfig: { maxOutputTokens: 8 },
    }, l.rpm, l.rpd);
    return firstText(data).slice(0, 40);
  }

  /* Refuse before spending anything unless both a text and a speech call are
     available: a sentence nothing can speak is a wasted text call. */
  function preflight() {
    const s = getSettings();
    const text = modelLimits(s, s.textModel);
    const tts = modelLimits(s, s.ttsModel);
    const why = limiter.why(s.textModel, text.rpm, text.rpd)
      || limiter.why(s.ttsModel, tts.rpm, tts.rpd);
    if (why) throw new QuotaError(why, limiter.report(s).retryAfter);
  }

  async function writeSentence(terms) {
    const s = getSettings();
    const prompt = fillTemplate(s.prompts.sentence, sentenceVars(s, terms));
    const l = modelLimits(s, s.textModel);
    const problems = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const data = await call(s.textModel, {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 1.0, maxOutputTokens: 2048 },
      }, l.rpm, l.rpd, attempt ? 75 : 0);
      const { target, english } = parseSentence(firstText(data));
      const why = sentenceProblem(target, terms, s);
      if (!why) return { sentence: target, english };
      problems.push(`attempt ${attempt + 1}: ${why} — "${target.slice(0, 80)}"`);
    }
    throw new GeminiError(`Could not get a usable sentence from ${s.textModel}.\n` + problems.join('\n'));
  }

  async function speak(sentence, voice) {
    const s = getSettings();
    const text = fillTemplate(s.prompts.speech, { sentence });
    const l = modelLimits(s, s.ttsModel);
    for (let attempt = 0; attempt < 2; attempt++) {
      const data = await call(s.ttsModel, {
        contents: [{ parts: [{ text }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        },
      }, l.rpm, l.rpd, attempt ? 75 : 0);

      const blocked = (data.promptFeedback || {}).blockReason;
      if (!blocked) return firstAudio(data);
      /* The safety filter throws false positives on ordinary sentences often
         enough that one identical retry is worth a call. */
      if (attempt === 1) {
        throw new GeminiError(`The speech model refused this sentence twice (${blocked}). This is usually a false positive — try a new sentence.\n\n${sentence}`);
      }
    }
    throw new GeminiError('The speech model returned nothing.');
  }

  /* One card: write it, check it, speak it. The voice is drawn once, so a
     retry does not change speaker mid-sentence.

     `deck` is the single deck all the terms came from. It is recorded on the
     entry, along with the difficulty the sentence was written at, because both
     are properties of this audio file forever: the deck decides whether the
     sentence may come back in a later session, and the difficulty is the one
     thing about a banked sentence that cannot be re-read from the settings —
     change the learner level tomorrow and yesterday's audio is still what it
     always was. */
  async function generateCard(terms, manifest, deck) {
    preflight();
    const s = getSettings();
    const voice = pickVoice(s);
    const { sentence, english } = await writeSentence(terms);
    const { bytes, mime } = await speak(sentence, voice);
    const file = await speechFile(bytes, mime);
    const audio = new Blob([file.bytes], { type: file.type });

    const id = nextBankId(manifest);
    const entry = {
      id,
      file: `audio/${id}.${file.ext}`,
      text_file: `audio/${id}.txt`,
      sentence,
      english,
      terms: terms.map((t) => t.front),
      deck: deck || '',
      difficulty: s.learnerLevel || '',
      language: s.targetLanguage,
      text_model: s.textModel,
      tts_model: s.ttsModel,
      voice,
      created: new Date().toISOString().slice(0, 10),
      times_practiced: 0,
    };
    return { entry, audio, sidecar: sidecarText(entry) };
  }

  /* ── shadowing ─────────────────────────────────────────────────────── */

  /* Reasoning-capable Flash models think by default, and the thinking tokens
     come out of the SAME budget as the visible answer — so the reasoning can
     eat the whole maxOutputTokens and cut the JSON off mid-object, leaving
     nothing parseable. thinkingConfig turns it off, but support and valid
     range vary by model, and an alias can start pointing somewhere new with no
     change on our side.

     So: try with the field, and if the API rejects the request because of it,
     retry once without and REMEMBER that for the rest of the page's life.
     Without the memory every later call pays for two real requests and
     silently doubles what the budget is spending. */
  let thinkingRejected = false;

  function looksLikeThinkingRejection(err) {
    return err instanceof GeminiError
      && /HTTP 400/.test(err.message)
      && /thinking/i.test(err.message);
  }

  /* One call with thinking turned off where the model allows it. `body` is
     handed whether to ask, so the retry is the same request minus the field. */
  async function callUnthinking(model, body) {
    const s = getSettings();
    const l = modelLimits(s, model);
    try {
      return await call(model, body(thinkingRejected ? {} : { thinkingConfig: { thinkingBudget: 0 } }), l.rpm, l.rpd);
    } catch (e) {
      if (!looksLikeThinkingRejection(e) || thinkingRejected) throw e;
      thinkingRejected = true;
      return call(model, body({}), l.rpm, l.rpd);
    }
  }

  /* One call, carrying the reference text of every recorded line and the
     learner's recording of it. Returns normalised feedback, or throws — a
     reply that cannot be read is a failure, never a half grade, because a
     half grade is indistinguishable from a finished one to whoever reads it. */
  async function gradeShadowing({ items, clips, focus, itemCount }) {
    const s = getSettings();
    const attach = attachableClips(clips);
    if (!attach.length) throw new GeminiError('There are no recordings to send.');

    const rules = rulesFor(s, s.targetLanguage);
    const system = shadowSystem(s, itemCount, rules);

    const userParts = buildGradingParts({
      items, clips: attach, focus, language: s.targetLanguage, itemCount,
    });

    const data = await callUnthinking(s.shadowModel, (thinking) => ({
      system_instruction: { parts: [{ text: system }] },
      contents: [{ parts: userParts }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 16384, ...thinking },
    }));

    const graded = readGrading(firstText(data), itemCount);
    if (!graded) {
      throw new GeminiError(
        `${s.shadowModel} replied with something that could not be read as feedback. `
        + 'Nothing was saved — your recordings are still here, so you can ask again.');
    }
    /* Which version of the rules graded this, so a rating given to it later
       counts towards that version and no other. 0 is "graded without any". */
    return {
      ...graded,
      model: s.shadowModel,
      attached: attach.length,
      rulesGeneration: rules ? rules.generation : 0,
    };
  }

  /* ── listening rules ───────────────────────────────────────────────── */

  /* Drafting and revising the rules are writing jobs, not listening ones, so
     they go to the text model and spend its allowance — the shadowing budget
     is left for the thing you actually press Hand in for. Both return the
     rules read back, or throw; a reply that cannot be read changes nothing. */
  function rulesPreflight() {
    const s = getSettings();
    const l = modelLimits(s, s.textModel);
    const why = limiter.why(s.textModel, l.rpm, l.rpd);
    if (why) throw new QuotaError(why, limiter.waitFor(s.textModel, l.rpm, l.rpd));
  }

  async function rulesCall(prompt, what) {
    rulesPreflight();
    const s = getSettings();
    const data = await callUnthinking(s.textModel, (thinking) => ({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.4, maxOutputTokens: 8192, ...thinking },
    }));
    const reply = readRules(firstText(data));
    if (!reply) {
      throw new GeminiError(`${s.textModel} replied with something that could not be read as ${what}. The listening rules were left as they were.`);
    }
    return reply;
  }

  async function draftShadowRules() {
    const s = getSettings();
    return rulesCall(buildSeedPrompt({
      language: s.targetLanguage, level: s.learnerLevel, languageNote: s.languageNote,
    }), 'listening rules');
  }

  async function reviseShadowRules({ entry, rated, current, previous }) {
    const s = getSettings();
    return rulesCall(buildRevisionPrompt({
      language: s.targetLanguage,
      level: s.learnerLevel,
      languageNote: s.languageNote,
      entry, rated, current, previous,
    }), 'revised listening rules');
  }

  /* Refuses before spending, the way preflight() does for a dictation card. */
  function shadowPreflight() {
    const s = getSettings();
    const l = modelLimits(s, s.shadowModel);
    const why = limiter.why(s.shadowModel, l.rpm, l.rpd);
    if (why) throw new QuotaError(why, limiter.waitFor(s.shadowModel, l.rpm, l.rpd));
  }

  return {
    call, testKey, generateCard, preflight, gradeShadowing, shadowPreflight,
    draftShadowRules, reviseShadowRules, rulesPreflight,
  };
}

/* The shadowing system instruction, filled. {sounds} is the old setting's
   placeholder: a prompt someone customised before rules existed may still
   carry it, and it is filled with nothing rather than left showing. */
export function shadowSystem(settings, count, rules = rulesFor(settings, settings.targetLanguage)) {
  return fillTemplate(settings.prompts.shadowing, {
    language: settings.targetLanguage,
    count,
    rules: formatRulesBlock(rules ? rules.rules : []),
    sounds: '',
  });
}

/* Duplicates what the manifest holds, so a stray audio file is never an orphan. */
export function sidecarText(entry) {
  return [
    entry.sentence,
    entry.english,
    `[terms] ${entry.terms.join(', ')}`,
    entry.deck ? `[deck] ${entry.deck}` : '',
    entry.difficulty ? `[difficulty] ${entry.difficulty}` : '',
    `[language] ${entry.language}`,
    `[voice] ${entry.voice}`,
    `[created] ${entry.created}`,
  ].filter(Boolean).join('\n') + '\n';
}

export function nextBankId(manifest) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `d_${today}_`;
  let n = manifest.filter((e) => String(e.id || '').startsWith(prefix)).length + 1;
  const taken = new Set(manifest.map((e) => e.id));
  while (taken.has(prefix + String(n).padStart(4, '0'))) n++;
  return prefix + String(n).padStart(4, '0');
}
