/* Live conversation: the parts that are plain logic. The partner's system
   instruction, the setup the socket opens with, reading what the socket
   sends, putting the running transcription together into turns, and the
   grading call at the end. No DOM, no audio and no network: the socket is
   gemini-live.js, the microphone and the speaker are live-audio.js, the
   conversation from Start talking to hand-in is live-session.js, and the
   tab is tab-conversation.js.

   Ported from durkle's Praat (the praat-site branch), which ran the same
   conversation through a server. The server was there for two things only:
   to mint a single-use token, so the browser never held Google's key, and
   to grade afterwards. Here the key is the learner's own, already in this
   browser, and every other mode already calls Gemini from the page, so the
   page opens the socket itself and grades like any other mode. Nothing
   Praat did needs a backend.

   A live conversation is a Conversation of kind 'live': its scene is a
   find-out scene, written by the scene model around a few of your cards,
   and it is kept in the same list. Its record adds, once it has been had:

     seconds   how long it was set to run
     voice     the partner's voice
     talked    how long it actually ran, in seconds
     take      conversation/<id>_live.<ext>, the recording of your microphone
     mime      its type

   and its turns are the running transcription, the partner's exact and
   yours only a guide, until the feedback writes yours afresh from the
   recording. */

import { fillTemplate, withFeedbackBlock, feedbackRequestText } from './gemini.js';
import { extractTrailingJson, cardVerdicts } from './json-reply.js';
import { readingTermListing } from './reading.js';
import { rulesFor, formatRulesBlock } from './shadow-rules.js';
import { AUDIO_BUDGET_BYTES, toBase64 } from './shadowing.js';

/* The two signals the page sends the partner as text. The partner prompt
   names them; these are what is actually sent, whatever it says. */
export const START_CUE = '[START]';
export const TIME_CUE = '[TIME]';

/* The partner is told to round off this many seconds before the end. */
export const WRAP_UP_SECONDS = 15;
/* How long the partner's last sentence may keep playing once time is up. */
export const DRAIN_MS = 6000;
/* A conversation that drops before this is not worth grading: the partner
   has barely said hello. */
export const MIN_GRADABLE_SECONDS = 20;

/* The Live API's audio: 16-bit mono PCM, 16 kHz going up and 24 kHz coming
   down. Fixed by the API, not chosen here. */
export const INPUT_RATE = 16000;
export const OUTPUT_RATE = 24000;
export const INPUT_MIME = `audio/pcm;rate=${INPUT_RATE}`;

/* ── the partner ─────────────────────────────────────────────────────── */

/* The facts as the partner holds them: labels and answers, no ids, since
   the partner never reports which it gave away. */
export function partnerFacts(facts) {
  return (facts || []).map((f) => `- ${f.label}: ${f.detail}`).join('\n');
}

/* The partner's system instruction, filled. `cards` are the session's
   cards as the decks have them, {front, back, type}. */
export function partnerInstruction(settings, session, cards) {
  const sc = session.scenario || {};
  return fillTemplate(settings.prompts.livePartner, {
    situation: sc.situation || '',
    llmRole: sc.llmRole || '',
    studentRole: sc.studentRole || '',
    language: settings.targetLanguage,
    level: settings.learnerLevel,
    languageNote: settings.languageNote || '',
    facts: partnerFacts(sc.facts),
    terms: cards && cards.length ? readingTermListing(cards) : '(none)',
  });
}

/* The first message on the socket. Both sides are transcribed as they
   speak: the partner's words for the grader and for the page, and the
   learner's as a guide to where their turns fell. The model name is sent
   as "models/<id>", which is how the API names it. */
export function setupMessage({ model, system, voice }) {
  const generationConfig = { responseModalities: ['AUDIO'] };
  if (voice) generationConfig.speechConfig = { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } };
  return {
    setup: {
      model: String(model).startsWith('models/') ? model : `models/${model}`,
      generationConfig,
      systemInstruction: { parts: [{ text: system }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
    },
  };
}

export function audioMessage(base64) {
  return { realtimeInput: { audio: { data: base64, mimeType: INPUT_MIME } } };
}

/* A signal to the partner, as a text turn. `complete` false means "take
   this into account" rather than "answer this now": the time signal must
   not cut into what the learner is saying. */
export function textMessage(text, complete = true) {
  return { clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: complete } };
}

/* One message from the socket, flattened to what the page acts on. Anything
   unrecognised comes back as an empty event rather than an error: the API
   adds fields, and a message the page does not use is not a failure.
   `goAway` is the seconds the server says are left before it closes the
   socket, or null. */
export function readServerMessage(message) {
  const out = {
    setupComplete: false, audio: [], interrupted: false, turnComplete: false,
    input: '', output: '', goAway: null,
  };
  if (!message || typeof message !== 'object') return out;
  if (message.setupComplete) out.setupComplete = true;
  const content = message.serverContent;
  if (content && typeof content === 'object') {
    const parts = (content.modelTurn && Array.isArray(content.modelTurn.parts)) ? content.modelTurn.parts : [];
    for (const p of parts) {
      const data = p && p.inlineData && p.inlineData.data;
      if (typeof data === 'string' && data) out.audio.push(data);
    }
    out.interrupted = content.interrupted === true;
    out.turnComplete = content.turnComplete === true;
    if (content.inputTranscription && typeof content.inputTranscription.text === 'string') out.input = content.inputTranscription.text;
    if (content.outputTranscription && typeof content.outputTranscription.text === 'string') out.output = content.outputTranscription.text;
  }
  if (message.goAway) out.goAway = parseSeconds(message.goAway.timeLeft);
  return out;
}

/* A protobuf Duration as JSON: "12s", "1.5s", or a number. */
function parseSeconds(value) {
  const n = typeof value === 'number' ? value : parseFloat(String(value || ''));
  return Number.isFinite(n) ? n : 0;
}

/* ── the running transcript ──────────────────────────────────────────── */

/* The transcription arrives a few words at a time, for both sides, and is
   put together here into turns. The learner's pieces run on while the
   learner is the last to have spoken. The partner's run on only while the
   partner's turn is open: a turn that completed, or that the learner
   interrupted, is over, and what comes after it is a new one, even if the
   learner said nothing audible in between. Turns are {speaker, text}, with
   'learner' and 'partner' as in every other conversation. */
export function createTranscript() {
  const turns = [];
  let partnerOpen = false;
  return {
    add(speaker, text) {
      if (!text) return;
      const last = turns[turns.length - 1];
      const continues = last && last.speaker === speaker && (speaker === 'learner' || partnerOpen);
      if (continues) last.text += text;
      else turns.push({ speaker, text: text.replace(/^\s+/, '') });
      if (speaker === 'partner') partnerOpen = true;
    },
    /* The partner finished, or was cut off. */
    close() { partnerOpen = false; },
    /* A copy, tidied: runs of space made one, and empty turns dropped. */
    turns() {
      return turns
        .map((t) => ({ speaker: t.speaker, text: t.text.replace(/\s+/g, ' ').trim() }))
        .filter((t) => t.text);
    },
  };
}

/* ── the feedback ────────────────────────────────────────────────────── */

/* The four areas the grader scores, each 0 to 4, and how much each counts
   toward the percentage. Pronunciation weighs most because it is what a
   listener notices first and longest; the four sum to 1. Praat's weights. */
export const BANDS = ['pronunciation', 'flow', 'grammar', 'wordChoice'];
export const BAND_WEIGHTS = { pronunciation: 0.35, flow: 0.2, grammar: 0.25, wordChoice: 0.2 };
export const BAND_LABELS = { pronunciation: 'Pronunciation', flow: 'Flow', grammar: 'Grammar', wordChoice: 'Word choice' };

/* 0 to 100, or null when there are no bands (too little speech to judge).
   Computed, never asked for: see the grading prompt's comment in
   defaults.js. */
export function liveScore(bands) {
  if (!bands || typeof bands !== 'object') return null;
  let sum = 0;
  for (const band of BANDS) {
    const value = Number(bands[band]);
    if (!Number.isFinite(value)) return null;
    sum += BAND_WEIGHTS[band] * (Math.min(4, Math.max(0, value)) / 4);
  }
  return Math.round(sum * 100);
}

/* The grading request: the prompt as the system instruction, identical
   from call to call but for the settings, so it can be cached; the scene,
   the transcript and the cards as the message; then the recording. `clip`
   is {mime, bytes} or {mime, base64}. Null when the recording is too big to
   send in one request, which three minutes of speech never is. */
export function liveGradeRequest(settings, session, cards, clip) {
  const size = clip && clip.bytes ? clip.bytes.length : 0;
  if (size > AUDIO_BUDGET_BYTES) return null;
  const entry = rulesFor(settings, settings.targetLanguage);
  const system = fillTemplate(withFeedbackBlock(settings.prompts.liveGrade), {
    language: settings.targetLanguage,
    languageNote: settings.languageNote || '',
    rules: formatRulesBlock(entry ? entry.rules : []),
    feedback: feedbackRequestText(settings.feedbackRequest),
  });
  const sc = session.scenario || {};
  const facts = (sc.facts || []).map((f) => `- id "${f.id}": ${f.label} -- ${f.detail}`).join('\n');
  const turns = session.turns || [];
  const transcript = turns.length
    ? turns.map((t, i) => `${i + 1}. ${t.speaker === 'learner' ? 'LEARNER' : 'PARTNER'}: ${t.text}`).join('\n')
    : '(the automatic transcript is empty -- rely on the recording)';
  const text = `<situation>
Situation: ${sc.situation || ''}
The partner played: ${sc.llmRole || ''}
The learner played: ${sc.studentRole || ''}
The learner's level: ${settings.learnerLevel}
Their goal: ${sc.goal || ''}
The facts to find out:
${facts}
</situation>

<transcript>
${transcript}
</transcript>

<cards>
${cards && cards.length ? readingTermListing(cards) : '(none)'}
</cards>

The recording of the learner's microphone follows.`;
  return {
    system,
    parts: [
      { text },
      { inlineData: { mimeType: (clip && clip.mime) || 'audio/webm', data: (clip && clip.base64) || toBase64(clip.bytes) } },
    ],
  };
}

const MAX_LINES = 80;
const MAX_LINE = 600;
const MAX_ITEMS_PER_LINE = 4;
const MAX_FRAGMENT = 300;
const MAX_WHY = 400;
const MAX_PRONUNCIATION = 6;
const MAX_OVERALL = 1200;

function str(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function corrections(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const original = str(item && item.original, MAX_FRAGMENT);
    const correction = str(item && item.correction, MAX_FRAGMENT);
    if (!original || !correction || original === correction) continue;
    out.push({ original, correction, why: str(item.why, MAX_WHY) });
    if (out.length >= MAX_ITEMS_PER_LINE) break;
  }
  return out;
}

function alternatives(value) {
  const out = [];
  for (const item of Array.isArray(value) ? value : []) {
    const original = str(item && item.original, MAX_FRAGMENT);
    const suggestions = (Array.isArray(item && item.suggestions) ? item.suggestions : [])
      .map((s) => str(s, MAX_FRAGMENT)).filter(Boolean).slice(0, 3);
    if (!original || !suggestions.length) continue;
    out.push({ original, suggestions, why: str(item.why, MAX_WHY) });
    if (out.length >= MAX_ITEMS_PER_LINE) break;
  }
  return out;
}

function readBands(value) {
  if (!value || typeof value !== 'object') return null;
  const out = {};
  for (const band of BANDS) {
    const n = Number(value[band]);
    if (value[band] === null || value[band] === '' || !Number.isFinite(n)) return null;
    out[band] = Math.min(4, Math.max(0, Math.round(n)));
  }
  return out;
}

/* The feedback, or null for a reply that is not its shape. Half a results
   page looks exactly like a whole one, so a reply with no transcript is a
   failure with a Try again, never a grade. Lines are
   {speaker: 'learner'|'partner', text, corrections, alternatives}; only the
   learner's carry corrections. `found` has one entry per fact of this
   scene, in its order, whatever the reply listed; the reasons are kept only
   with the bands they explain. */
export function readLiveGrade(reply, session, cards) {
  const p = extractTrailingJson(reply);
  if (!p || typeof p !== 'object' || !Array.isArray(p.transcript)) return null;
  const lines = [];
  for (const line of p.transcript.slice(0, MAX_LINES)) {
    const speaker = line && line.speaker === 'you' ? 'learner' : line && line.speaker === 'partner' ? 'partner' : null;
    const text = str(line && line.text, MAX_LINE);
    if (!speaker || !text) continue;
    const mine = speaker === 'learner';
    lines.push({
      speaker,
      text,
      corrections: mine ? corrections(line.corrections) : [],
      alternatives: mine ? alternatives(line.alternatives) : [],
    });
  }
  if (!lines.length) return null;

  const pronunciation = (Array.isArray(p.pronunciation) ? p.pronunciation : [])
    .map((n) => ({ word: str(n && n.word, MAX_FRAGMENT), comment: str(n && n.comment, MAX_WHY) }))
    .filter((n) => n.word && n.comment)
    .slice(0, MAX_PRONUNCIATION);

  const said = new Map();
  for (const g of Array.isArray(p.goal) ? p.goal : []) {
    if (g && g.factId !== undefined && g.factId !== null) said.set(String(g.factId), g.found === true);
  }
  const facts = (session && session.scenario && session.scenario.facts) || [];
  const found = facts.filter((f) => said.get(String(f.id)) === true).map((f) => String(f.id));

  const bands = readBands(p.bands);
  const reasons = {};
  if (bands) {
    for (const band of BANDS) {
      const why = str(p.reasons && p.reasons[band], MAX_WHY);
      if (why) reasons[band] = why;
    }
  }

  return {
    lines,
    pronunciation,
    found,
    bands,
    reasons,
    score: liveScore(bands),
    overall: str(p.overall, MAX_OVERALL) || null,
    cards: cardVerdicts(p, cards || []),
  };
}

/* Where a live conversation's recording is kept: beside it, as the spoken
   turns of a typed conversation are. */
export function livePath(sessionId, ext) {
  return `conversation/${sessionId}_live.${ext}`;
}

/* "2 min", "1 min 30 s": a length in words. */
export function minutesLabel(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (!m) return `${r} s`;
  return r ? `${m} min ${r} s` : `${m} min`;
}

/* "1:05": a countdown. */
export function clock(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
