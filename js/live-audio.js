/* The audio of a live conversation: the microphone going up as the Live API
   wants it, the partner's voice coming down, and a recording of the
   microphone for the grader. Browser built-ins only (Web Audio,
   AudioWorklet, MediaRecorder), nothing that touches the network. Ported
   from the God-project's Praat (praat-web/src/live/micStream.ts and playback.ts).

   Two things recorded from one microphone: the PCM that is streamed, for
   the partner, and a compressed MediaRecorder clip of the whole
   conversation, which is what the grader listens to afterwards. Both come
   from the same stream, with the same echo cancellation. */

import { INPUT_RATE, OUTPUT_RATE } from './live.js';

const CHUNK_SAMPLES = INPUT_RATE / 10; // 100 ms

/* What a live conversation needs from the browser, and what it says when
   something is missing: null when everything is there. Safari has had all
   of it since 14.1, Firefox since 76. */
export function liveUnsupported() {
  if (typeof window === 'undefined') return 'This needs a browser.';
  if (!window.WebSocket) return 'This browser has no WebSockets, which a live conversation needs.';
  if (!(window.AudioContext || window.webkitAudioContext) || typeof window.AudioWorkletNode === 'undefined') {
    return 'This browser cannot process audio as it is recorded (no AudioWorklet), which a live conversation needs.';
  }
  if (!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia)) {
    return 'This browser cannot use a microphone here. A live conversation needs one, and a secure (https) page.';
  }
  if (typeof window.MediaRecorder === 'undefined') return 'This browser cannot record audio, which the feedback on a live conversation needs.';
  return null;
}

/* Kept as a string and loaded from a Blob URL, so the worklet is not a
   module of its own that the import map would have to version.

   Browsers capture at 44.1 or 48 kHz and will not reliably hand a stream
   over at any other rate, so the resampling to 16 kHz happens here, off the
   main thread, where a busy page cannot make the audio stutter. Linear
   interpolation over a fractional read position: 44.1 kHz is not a whole
   multiple of 16 kHz, and dropping every nth sample would alias. The level
   of each chunk comes with it, for the meter. */
const WORKLET_SOURCE = `
class PcmDownsampler extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / ${INPUT_RATE};
    this.pos = 0;
    this.out = new Int16Array(${CHUNK_SAMPLES});
    this.n = 0;
    this.sumSq = 0;
    this.prev = 0;
  }
  process(inputs) {
    const input = inputs[0] && inputs[0][0];
    if (!input) return true;
    while (this.pos < input.length) {
      const i = Math.floor(this.pos);
      const frac = this.pos - i;
      const a = i === 0 ? this.prev : input[i - 1];
      const b = input[i];
      const s = Math.max(-1, Math.min(1, a + (b - a) * frac));
      this.out[this.n++] = s < 0 ? s * 0x8000 : s * 0x7fff;
      this.sumSq += s * s;
      if (this.n === ${CHUNK_SAMPLES}) {
        this.port.postMessage({ pcm: this.out.buffer, rms: Math.sqrt(this.sumSq / this.n) }, [this.out.buffer]);
        this.out = new Int16Array(${CHUNK_SAMPLES});
        this.n = 0;
        this.sumSq = 0;
      }
      this.pos += this.ratio;
    }
    this.pos -= input.length;
    this.prev = input[input.length - 1];
    return true;
  }
}
registerProcessor('lsw-pcm-downsampler', PcmDownsampler);
`;

function newContext() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  return new Ctx();
}

export function openMicrophone() {
  return navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      /* The partner's voice comes out of the same device. Without echo
         cancellation it would be streamed back up as though the learner had
         said it, and the partner would answer itself. */
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
}

/* Starts delivering 16 kHz PCM from `stream`: onChunk(base64, level) every
   100 ms. Resolves with {stop}. */
export async function startPcm(stream, onChunk) {
  const context = newContext();
  const url = URL.createObjectURL(new Blob([WORKLET_SOURCE], { type: 'application/javascript' }));
  try {
    await context.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, 'lsw-pcm-downsampler');
  node.port.onmessage = (event) => onChunk(bytesToBase64(new Uint8Array(event.data.pcm)), event.data.rms);
  /* Not connected to the speakers: nobody should hear themselves. */
  source.connect(node);
  if (context.state === 'suspended') context.resume().catch(() => {});
  return {
    stop() {
      node.port.onmessage = null;
      try { source.disconnect(); node.disconnect(); } catch (e) { /* already */ }
      context.close().catch(() => {});
    },
  };
}

/* The partner's voice: 24 kHz PCM chunks, played back to back. Each chunk
   starts exactly where the one before ends, on the audio clock, so there
   are no gaps however unevenly they arrive. When the learner talks over the
   partner the API says so, and everything still queued is dropped at once:
   a partner who keeps talking after being interrupted does not feel live.

   The context runs at the device's own rate and the buffers at 24 kHz; the
   browser resamples. Asking for a 24 kHz context instead is refused by some
   browsers. Create this inside a click: a context started without one stays
   silent in Safari and Chrome. */
export function createPlayback() {
  const context = newContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.connect(context.destination);
  const samples = new Float32Array(analyser.fftSize);
  let nextStart = 0;
  const playing = new Set();
  if (context.state === 'suspended') context.resume().catch(() => {});

  function push(base64) {
    const bytes = base64ToBytes(base64);
    const pcm = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
    if (!pcm.length) return;
    const buffer = context.createBuffer(1, pcm.length, OUTPUT_RATE);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) channel[i] = pcm[i] / 0x8000;
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(analyser);
    /* A little lead after a silence, so the second chunk arrives before the
       first runs out. */
    const at = Math.max(nextStart, context.currentTime + 0.05);
    source.start(at);
    nextStart = at + buffer.duration;
    playing.add(source);
    source.onended = () => playing.delete(source);
  }

  function flush() {
    for (const source of playing) {
      try { source.stop(); } catch (e) { /* already stopped */ }
    }
    playing.clear();
    nextStart = 0;
  }

  /* The partner's loudness now, 0 to 1. */
  function level() {
    if (!playing.size) return 0;
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const s of samples) sum += s * s;
    return Math.sqrt(sum / samples.length);
  }

  /* Resolves once what is queued has played, or after `maxMs`. */
  function drain(maxMs) {
    const left = Math.max(0, nextStart - context.currentTime) * 1000;
    return new Promise((resolve) => setTimeout(resolve, Math.min(maxMs, left + 150)));
  }

  return {
    push, flush, level, drain,
    close() { flush(); context.close().catch(() => {}); },
  };
}

/* The whole conversation, from the learner's microphone, for the grader.
   stop() resolves on MediaRecorder's own onstop, never earlier: chunks are
   not guaranteed flushed before it fires (see recorder.js). */
export function recordStream(stream) {
  const recorder = new MediaRecorder(stream);
  const chunks = [];
  recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
  recorder.start(1000);
  return {
    stop() {
      const done = () => new Blob(chunks, { type: recorder.mimeType || (chunks[0] && chunks[0].type) || 'audio/webm' });
      if (recorder.state === 'inactive') return Promise.resolve(done());
      return new Promise((resolve) => {
        recorder.onstop = () => resolve(done());
        try { recorder.stop(); } catch (e) { resolve(done()); }
      });
    },
  };
}

function bytesToBase64(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}
