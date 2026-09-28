/* One live conversation, from Start talking to the recording being handed
   back. No DOM: the tab draws what onUpdate reports. Ported from durkle's
   Praat (praat-web/src/live/useLiveConversation.ts), less the server.

     idle → connecting → live → wrapping → done
                  ↘         ↘
                    error     (dropped in the first seconds: error)

   connecting  the microphone first, so a refused permission costs nothing,
               then the socket (gemini.js counts it as one call).
   live        the countdown runs; the microphone streams up, the partner
               streams down, and both sides' transcription is put together
               into turns. With WRAP_UP_SECONDS left the partner is told to
               round off.
   wrapping    time is up, or End now was pressed: the microphone stops
               first, so nothing said from here on is sent; the partner's
               last words are let finish; the socket closes.
   done        `done` resolves with {blob, mime, turns, talked}.

   `done` rejects, with a `code` the tab has a sentence for, on every other
   way out: mic_denied, no_mic, connection_failed, connection_lost,
   audio_failed, nothing_recorded, aborted. */

import {
  START_CUE, TIME_CUE, WRAP_UP_SECONDS, DRAIN_MS, MIN_GRADABLE_SECONDS, createTranscript,
} from './live.js';
import { openMicrophone, startPcm, createPlayback, recordStream } from './live-audio.js';

/* `connect({onMessage, onClose})` opens the socket and resolves with
   {sendAudio, sendText, close}: store.client.openLive with the partner's
   instruction and voice bound. */
export function createLiveTalk({ connect, seconds, onUpdate = () => {} }) {
  let phase = 'idle';
  let error = null;
  let secondsLeft = seconds;
  const transcript = createTranscript();
  let socket = null;
  let stream = null;
  let mic = null;
  let playback = null;
  let recording = null;
  let timer = 0;
  let startedAt = 0;
  let wrapSent = false;
  let micLevel = 0;

  let resolveDone;
  let rejectDone;
  const done = new Promise((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  /* Whoever started it awaits this; the catch keeps an unawaited rejection
     from being reported as unhandled. */
  done.catch(() => {});

  const report = () => onUpdate({ phase, secondsLeft, turns: transcript.turns(), error });
  const go = (next) => { phase = next; report(); };

  function teardown() {
    clearInterval(timer);
    timer = 0;
    if (mic) { mic.stop(); mic = null; }
    if (recording) { recording.stop(); recording = null; }
    if (stream) { for (const t of stream.getTracks()) t.stop(); stream = null; }
    if (socket) { socket.close(); socket = null; }
    if (playback) { playback.close(); playback = null; }
  }

  function fail(code, detail = '') {
    if (phase === 'done' || phase === 'error') return;
    teardown();
    error = { code, detail };
    go('error');
    rejectDone(Object.assign(new Error(detail || code), { code }));
  }

  function onMessage(m) {
    for (const chunk of m.audio) if (playback) playback.push(chunk);
    if (m.interrupted) {
      if (playback) playback.flush();
      transcript.close();
    }
    if (m.input) transcript.add('learner', m.input);
    if (m.output) transcript.add('partner', m.output);
    if (m.turnComplete) transcript.close();
    if (m.input || m.output) report();
  }

  function onClose(info) {
    socket = null;
    if (phase === 'live') {
      /* Google ends a session on its own when its time runs out, which can
         land a moment before the page's countdown: past the first seconds
         that is the conversation ending, not failing. */
      if ((Date.now() - startedAt) / 1000 >= MIN_GRADABLE_SECONDS) finish();
      else fail('connection_lost', info && info.reason);
    } else if (phase === 'connecting') {
      fail('connection_failed', info && info.reason);
    }
  }

  function begin() {
    socket.sendText(START_CUE, true);
    recording = recordStream(stream);
    startPcm(stream, (base64, level) => {
      micLevel = level;
      if (phase !== 'live' || !socket) return;
      try { socket.sendAudio(base64); } catch (e) { /* closing: onClose decides */ }
    }).then((m) => {
      /* A conversation that ended while the worklet was loading. */
      if (phase === 'live') mic = m;
      else m.stop();
    }, (e) => fail('audio_failed', e && e.message));
    startedAt = Date.now();
    go('live');
    timer = setInterval(tick, 250);
  }

  function tick() {
    const left = Math.max(0, seconds - Math.floor((Date.now() - startedAt) / 1000));
    if (left !== secondsLeft) { secondsLeft = left; report(); }
    if (left <= WRAP_UP_SECONDS && !wrapSent && socket) {
      wrapSent = true;
      try { socket.sendText(TIME_CUE, false); } catch (e) { /* closing */ }
    }
    if (left === 0) finish();
  }

  /* Must be called from a click: the speaker's audio context is made here,
     before anything is awaited, and a context made without a gesture stays
     silent in Safari and Chrome. */
  async function start() {
    if (phase !== 'idle') return done;
    go('connecting');
    try {
      playback = createPlayback();
    } catch (e) {
      fail('audio_failed', e && e.message);
      return done;
    }
    try {
      stream = await openMicrophone();
    } catch (e) {
      fail(e && e.name === 'NotFoundError' ? 'no_mic' : 'mic_denied', e && e.message);
      return done;
    }
    if (phase !== 'connecting') { teardown(); return done; }
    try {
      socket = await connect({ onMessage, onClose });
    } catch (e) {
      fail('connection_failed', e && e.message);
      return done;
    }
    if (phase !== 'connecting') { teardown(); return done; }
    begin();
    return done;
  }

  /* End now, or time is up. */
  async function finish() {
    if (phase !== 'live') return;
    go('wrapping');
    clearInterval(timer);
    timer = 0;
    if (mic) { mic.stop(); mic = null; }
    if (playback) await playback.drain(DRAIN_MS);
    if (socket) { socket.close(); socket = null; }
    const rec = recording;
    recording = null;
    const blob = rec ? await rec.stop() : null;
    const talked = Math.min(seconds, Math.round((Date.now() - startedAt) / 1000));
    teardown();
    if (!blob || !blob.size) { fail('nothing_recorded'); return; }
    go('done');
    resolveDone({ blob, mime: blob.type || 'audio/webm', turns: transcript.turns(), talked });
  }

  /* Leaves without a result: nothing is kept. */
  function abort() {
    if (phase === 'done' || phase === 'error') return;
    fail('aborted');
  }

  return {
    start, finish, abort, done,
    get phase() { return phase; },
    /* Each side's loudness now, 0 to 1, for the meter. Read every frame. */
    levels: () => ({
      learner: phase === 'live' ? micLevel : 0,
      partner: playback ? playback.level() : 0,
    }),
  };
}
