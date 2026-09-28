/* The live conversation's decisions: what the partner is told, what goes
   down the socket and how what comes back is read, the running transcript
   put together into turns, and the feedback read back. A malformed grade
   has to be null, never half a results page. The socket client is driven
   with a fake WebSocket; the audio needs a browser and is not covered. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  partnerInstruction, partnerFacts, setupMessage, audioMessage, textMessage, readServerMessage,
  createTranscript, liveScore, liveGradeRequest, readLiveGrade, livePath, minutesLabel, clock,
  START_CUE, TIME_CUE,
} from '../js/live.js';
import { openLiveSocket, decodeFrame, closeReason, LIVE_URL } from '../js/gemini-live.js';
import { callsNeeded, budgetProblem, awaitingReply, conversationTitle } from '../js/conversation.js';
import { withDefaults, LIVE_MODEL } from '../js/defaults.js';
import { RateLimiter } from '../js/gemini.js';

const settings = withDefaults({ targetLanguage: 'Spanish', learnerLevel: 'B1', feedbackRequest: 'English' });
const cards = [{ front: 'madrugar', back: 'to get up early' }];
const scenario = {
  situation: 'Acabas de mudarte.', studentRole: 'Vecino nuevo', llmRole: 'Vecina', goal: 'Averigua cómo funciona el edificio.',
  facts: [
    { id: '1', label: 'cuándo recogen la basura', detail: 'martes y viernes' },
    { id: '2', label: 'dónde está el buzón', detail: 'en la entrada' },
    { id: '3', label: 'quién es el portero', detail: 'Luis' },
  ],
  openingLine: 'Hola',
};
const session = {
  id: 'c_20260927_001', kind: 'live', scenario, seconds: 120, talked: 118,
  turns: [
    { speaker: 'partner', text: '¡Hola! Tú eres el nuevo vecino, ¿no?' },
    { speaker: 'learner', text: 'Sí, hola. ¿Cuándo recogen la basura?' },
    { speaker: 'partner', text: 'Los martes y los viernes.' },
  ],
};

/* ── the partner ─────────────────────────────────────────────────────── */

test('the partner knows the facts with their answers, and the scene and the cards', () => {
  const text = partnerInstruction(settings, session, cards);
  assert.match(text, /- cuándo recogen la basura: martes y viernes/);
  assert.match(text, /YOU ARE: Vecina/);
  assert.match(text, /THE LEARNER IS: Vecino nuevo/);
  assert.match(text, /speak ONLY Spanish/);
  assert.match(text, /1\. "madrugar"/);
  assert.ok(text.includes(START_CUE) && text.includes(TIME_CUE), 'it is told what the two signals mean');
  assert.doesNotMatch(text, /\{\w+\}/, 'every placeholder is filled');
  assert.equal(partnerFacts([]), '');
});

test('the setup names the model, the voice and both transcriptions', () => {
  const m = setupMessage({ model: 'gemini-x-live', system: 'be a neighbour', voice: 'Kore' });
  assert.equal(m.setup.model, 'models/gemini-x-live');
  assert.deepEqual(m.setup.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(m.setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName, 'Kore');
  assert.equal(m.setup.systemInstruction.parts[0].text, 'be a neighbour');
  assert.deepEqual(m.setup.inputAudioTranscription, {});
  assert.deepEqual(m.setup.outputAudioTranscription, {});
  assert.equal(setupMessage({ model: 'models/y', system: '' }).setup.model, 'models/y');
  assert.equal(setupMessage({ model: 'y', system: '' }).setup.generationConfig.speechConfig, undefined, 'no voice, the model\'s own');
});

test('audio goes up as 16 kHz PCM, and a signal as a text turn', () => {
  assert.deepEqual(audioMessage('AAAA'), { realtimeInput: { audio: { data: 'AAAA', mimeType: 'audio/pcm;rate=16000' } } });
  assert.equal(textMessage(START_CUE).clientContent.turnComplete, true);
  assert.equal(textMessage(TIME_CUE, false).clientContent.turnComplete, false, 'the time signal must not cut the learner off');
  assert.equal(textMessage('x').clientContent.turns[0].parts[0].text, 'x');
});

/* ── what comes back ─────────────────────────────────────────────────── */

test('a server message is flattened to what the page acts on', () => {
  const m = readServerMessage({
    serverContent: {
      modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: 'QUJD' } }, { text: 'ignored' }] },
      outputTranscription: { text: 'Hola' },
      inputTranscription: { text: 'buenas' },
      turnComplete: true,
    },
  });
  assert.deepEqual(m.audio, ['QUJD']);
  assert.equal(m.output, 'Hola');
  assert.equal(m.input, 'buenas');
  assert.equal(m.turnComplete, true);
  assert.equal(m.interrupted, false);
  assert.equal(readServerMessage({ setupComplete: {} }).setupComplete, true);
  assert.equal(readServerMessage({ serverContent: { interrupted: true } }).interrupted, true);
  assert.equal(readServerMessage({ goAway: { timeLeft: '9.5s' } }).goAway, 9.5);
  assert.deepEqual(readServerMessage({ usageMetadata: {} }).audio, [], 'an unknown message is an empty event');
  assert.equal(readServerMessage(null).setupComplete, false);
});

test('the transcription is put together into turns', () => {
  const t = createTranscript();
  t.add('partner', '¡Hola! ');
  t.add('partner', 'Bienvenido.');
  t.close();
  t.add('learner', ' Hola, ');
  t.add('learner', 'gracias.');
  t.add('partner', 'Dime.');
  t.close();
  t.add('partner', '¿Algo más?');
  t.add('learner', '');
  assert.deepEqual(t.turns(), [
    { speaker: 'partner', text: '¡Hola! Bienvenido.' },
    { speaker: 'learner', text: 'Hola, gracias.' },
    { speaker: 'partner', text: 'Dime.' },
    { speaker: 'partner', text: '¿Algo más?' },
  ], 'a partner turn that completed is over, even with nothing heard in between');
});

test('an interrupted partner turn ends where it was cut off', () => {
  const t = createTranscript();
  t.add('partner', 'Los martes y');
  t.close();
  t.add('learner', 'perdón');
  t.add('partner', 'No pasa nada.');
  assert.equal(t.turns().length, 3);
});

/* ── the socket ──────────────────────────────────────────────────────── */

/* Enough of a browser WebSocket to drive the client: it records what is
   sent, and the test plays the server. */
function fakeSocket() {
  const made = [];
  class FakeWebSocket {
    constructor(url) {
      this.url = url;
      this.sent = [];
      this.readyState = 0;
      made.push(this);
      queueMicrotask(() => { this.readyState = 1; this.onopen && this.onopen(); });
    }
    send(data) { this.sent.push(JSON.parse(data)); }
    close(code = 1000, reason = '') { this.readyState = 3; this.onclose && this.onclose({ code, reason }); }
    serve(obj) { this.onmessage({ data: new TextEncoder().encode(JSON.stringify(obj)).buffer }); }
  }
  return { FakeWebSocket, made };
}

test('the socket sends the setup, and resolves once the server accepts it', async () => {
  const { FakeWebSocket, made } = fakeSocket();
  const heard = [];
  const closed = [];
  const opening = openLiveSocket({
    key: 'AIza k/y', model: 'm-live', system: 'sys', voice: 'Puck', WebSocketImpl: FakeWebSocket,
    onMessage: (m) => heard.push(m), onClose: (c) => closed.push(c),
  });
  await new Promise((r) => setTimeout(r, 0));
  const ws = made[0];
  assert.equal(ws.url, `${LIVE_URL}?key=AIza%20k%2Fy`);
  assert.equal(ws.sent[0].setup.model, 'models/m-live');
  ws.serve({ setupComplete: {} });
  const live = await opening;
  live.sendText(START_CUE);
  live.sendAudio('AAAA');
  assert.equal(ws.sent[1].clientContent.turns[0].parts[0].text, START_CUE);
  assert.equal(ws.sent[2].realtimeInput.audio.data, 'AAAA');
  ws.serve({ serverContent: { outputTranscription: { text: 'Hola' } } });
  assert.equal(heard[0].output, 'Hola');
  live.close();
  assert.deepEqual(closed, [{ code: 1000, reason: '' }]);
});

test('a socket the server closes before setup rejects with the server\'s reason', async () => {
  const { FakeWebSocket, made } = fakeSocket();
  const opening = openLiveSocket({ key: 'k', model: 'nope', system: '', WebSocketImpl: FakeWebSocket });
  await new Promise((r) => setTimeout(r, 0));
  made[0].close(1008, 'models/nope is not found for API version v1beta');
  await assert.rejects(opening, /models\/nope is not found/);
});

test('a setup never answered times out', async () => {
  const { FakeWebSocket } = fakeSocket();
  await assert.rejects(
    openLiveSocket({ key: 'k', model: 'm', system: '', WebSocketImpl: FakeWebSocket, setupTimeoutMs: 20 }),
    /did not accept/);
});

test('frames are read as text or as binary JSON', () => {
  assert.deepEqual(decodeFrame('{"a":1}'), { a: 1 });
  assert.deepEqual(decodeFrame(new TextEncoder().encode('{"a":2}')), { a: 2 });
  assert.equal(decodeFrame('not json'), null);
  assert.equal(closeReason({ code: 1006, reason: '' }), 'The connection closed (code 1006).');
  assert.equal(closeReason({ code: 1008, reason: ' API key not valid. ' }), 'API key not valid.');
});

/* ── the cost ────────────────────────────────────────────────────────── */

test('a live conversation is the scene, one live call and the feedback', () => {
  assert.equal(settings.liveModel, LIVE_MODEL);
  const s = withDefaults({ ...settings, liveGradeModel: 'gemini-3.6-flash' });
  assert.deepEqual(callsNeeded(s, 'live'), [
    { model: 'gemini-3.6-flash', count: 2, jobs: ['the scene', 'the feedback'] },
    { model: LIVE_MODEL, count: 1, jobs: ['the live conversation'] },
  ]);
  const limiter = new RateLimiter({ now: () => 1000 });
  const capped = withDefaults({ ...s, models: [{ id: 'gemini-3.6-flash', rpm: 4, rpd: 20 }, { id: LIVE_MODEL, rpm: 0, rpd: 1 }] });
  limiter.calls[LIVE_MODEL] = [990];
  assert.match(budgetProblem(capped, 'live', (m, rpm, rpd) => limiter.usage(m, rpm, rpd)), /a live conversation needs 1/);
});

test('a live conversation is never waiting for a reply, and is titled by its goal', () => {
  const last = { ...session, turns: [...session.turns, { speaker: 'learner', text: 'Gracias' }] };
  assert.equal(awaitingReply(last), false);
  assert.equal(awaitingReply({ ...last, kind: 'findout' }), true);
  assert.equal(conversationTitle(session), scenario.goal);
});

test('an older settings file starts on a kind it knows, and a length it offers', () => {
  assert.equal(withDefaults({ conversationKind: 'live' }).conversationKind, 'live');
  assert.equal(withDefaults({ liveSeconds: '180' }).liveSeconds, 180);
  assert.equal(withDefaults({ liveSeconds: 45 }).liveSeconds, 120);
  assert.equal(withDefaults({}).liveSeconds, 120);
});

/* ── the feedback ────────────────────────────────────────────────────── */

test('the percentage is computed from the bands, weighted', () => {
  assert.equal(liveScore({ pronunciation: 4, flow: 4, grammar: 4, wordChoice: 4 }), 100);
  assert.equal(liveScore({ pronunciation: 0, flow: 0, grammar: 0, wordChoice: 0 }), 0);
  assert.equal(liveScore({ pronunciation: 2, flow: 2, grammar: 2, wordChoice: 2 }), 50);
  assert.equal(liveScore({ pronunciation: 4, flow: 0, grammar: 0, wordChoice: 0 }), 35, 'pronunciation weighs most');
  assert.equal(liveScore({ pronunciation: 9, flow: -1, grammar: 4, wordChoice: 4 }), 80, 'held to 0-4');
  assert.equal(liveScore(null), null);
  assert.equal(liveScore({ pronunciation: 3 }), null);
});

test('the grading request carries the scene, the transcript, the cards and the recording', () => {
  const r = liveGradeRequest(settings, session, cards, { mime: 'audio/webm;codecs=opus', bytes: new Uint8Array([1, 2, 3]) });
  assert.match(r.system, /experienced Spanish teacher/);
  assert.match(r.system, /<feedback_request>\nEnglish\n<\/feedback_request>/);
  assert.doesNotMatch(r.system, /\{(language|rules|feedback|languageNote)\}/);
  assert.match(r.parts[0].text, /- id "1": cuándo recogen la basura -- martes y viernes/);
  assert.match(r.parts[0].text, /2\. LEARNER: Sí, hola/);
  assert.match(r.parts[0].text, /1\. "madrugar"/);
  assert.deepEqual(r.parts[1], { inlineData: { mimeType: 'audio/webm;codecs=opus', data: 'AQID' } });
  const empty = liveGradeRequest(settings, { ...session, turns: [] }, [], { mime: 'audio/mp4', base64: 'x' });
  assert.match(empty.parts[0].text, /rely on the recording/);
  assert.match(empty.parts[0].text, /<cards>\n\(none\)/);
  assert.equal(liveGradeRequest(settings, session, cards, { mime: 'audio/webm', bytes: new Uint8Array(13 * 1024 * 1024) }), null, 'too big for one request');
});

const reply = {
  transcript: [
    { speaker: 'partner', text: '¡Hola!', corrections: [{ original: 'x', correction: 'y' }] },
    {
      speaker: 'you', text: 'Hola, cuándo recoge la basura',
      corrections: [{ original: 'recoge', correction: 'recogen', why: 'plural' }, { original: 'same', correction: 'same' }],
      alternatives: [{ original: 'Hola', suggestions: ['Buenas', '', 'Buenas tardes'], why: 'more natural' }, { original: 'x', suggestions: [] }],
    },
    { speaker: 'narrator', text: 'dropped' },
    { speaker: 'you', text: '   ' },
  ],
  pronunciation: [{ word: 'basura', comment: 'the s is soft' }, { word: '', comment: 'no word' }],
  goal: [{ factId: 1, found: true }, { factId: '2', found: 'yes' }, { factId: '9', found: true }],
  bands: { pronunciation: 3, flow: 2, grammar: 2.6, wordChoice: 3 },
  reasons: { pronunciation: 'basura', flow: 'pauses', other: 'x' },
  overall: 'Good start.',
  cards: [{ number: 1, verdict: 'absent', note: '' }],
};

test('a grade reads back: your lines corrected, the partner\'s not, the facts in the scene\'s order', () => {
  const g = readLiveGrade(`Here it is:\n${JSON.stringify(reply)}`, session, cards);
  assert.equal(g.lines.length, 2);
  assert.deepEqual(g.lines[0], { speaker: 'partner', text: '¡Hola!', corrections: [], alternatives: [] });
  assert.equal(g.lines[1].speaker, 'learner');
  assert.deepEqual(g.lines[1].corrections, [{ original: 'recoge', correction: 'recogen', why: 'plural' }]);
  assert.deepEqual(g.lines[1].alternatives, [{ original: 'Hola', suggestions: ['Buenas', 'Buenas tardes'], why: 'more natural' }]);
  assert.deepEqual(g.pronunciation, [{ word: 'basura', comment: 'the s is soft' }]);
  assert.deepEqual(g.found, ['1'], 'only a real true, only this scene\'s facts');
  assert.deepEqual(g.bands, { pronunciation: 3, flow: 2, grammar: 3, wordChoice: 3 });
  assert.deepEqual(g.reasons, { pronunciation: 'basura', flow: 'pauses' });
  assert.equal(g.score, 70);
  assert.equal(g.overall, 'Good start.');
  assert.equal(g.cards[0].verdict, 'absent');
});

test('no bands is no score, and no reasons', () => {
  const g = readLiveGrade(JSON.stringify({ ...reply, bands: null }), session, cards);
  assert.equal(g.bands, null);
  assert.equal(g.score, null);
  assert.deepEqual(g.reasons, {});
  assert.equal(readLiveGrade(JSON.stringify({ ...reply, bands: { ...reply.bands, flow: null } }), session, cards).score, null);
});

test('a reply that is not a grade is null', () => {
  assert.equal(readLiveGrade('no json', session, cards), null);
  assert.equal(readLiveGrade(JSON.stringify({ ...reply, transcript: 'x' }), session, cards), null);
  assert.equal(readLiveGrade(JSON.stringify({ ...reply, transcript: [{ speaker: 'narrator', text: 'x' }] }), session, cards), null);
});

test('the recording is kept beside the conversation, and lengths read as words', () => {
  assert.equal(livePath('c_1', 'webm'), 'conversation/c_1_live.webm');
  assert.equal(minutesLabel(120), '2 min');
  assert.equal(minutesLabel(90), '1 min 30 s');
  assert.equal(minutesLabel(12), '12 s');
  assert.equal(clock(65), '1:05');
  assert.equal(clock(-3), '0:00');
});
