/* The Gemini Live API, from the page: one WebSocket, written from scratch
   rather than with Google's SDK, since this site has no build step and no
   packages. The protocol is small: a setup message, then audio going up
   and audio and transcription coming down, all as JSON.

   The key goes in the socket's URL, which is the one way a browser can
   authenticate a WebSocket to Google (it cannot set a header on one). Like
   every other call here it is the learner's own key, and it goes nowhere
   but generativelanguage.googleapis.com.

   Nothing here counts calls or knows about settings: gemini.js does both
   before it opens a socket, as it does for every other request, and live.js
   builds the messages sent and reads the ones received. */

import { setupMessage, audioMessage, textMessage, readServerMessage } from './live.js';

export const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';

/* How long the server may take to accept the setup. It normally answers in
   well under a second; this is for a connection that opened and then hung. */
const SETUP_TIMEOUT_MS = 15000;

/* Why a socket closed, in words: Google puts the reason in the close frame
   ("models/… is not found…", "API key not valid…"), and that is shown as it
   is. A close with no reason is a dropped connection. */
export function closeReason({ code, reason } = {}) {
  const text = String(reason || '').trim();
  if (text) return text;
  if (code === 1000) return 'The conversation was closed.';
  return `The connection closed (code ${code || 'unknown'}).`;
}

/* Frames arrive as text or as binary holding JSON, depending on the
   browser and the server; both are read the same way. Null for anything
   that is not JSON. */
export function decodeFrame(data) {
  let text = data;
  if (data instanceof ArrayBuffer) text = new TextDecoder().decode(new Uint8Array(data));
  else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data);
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

/* Opens a socket, sends the setup, and resolves once the server has
   accepted it, with {sendAudio, sendText, close}. Rejects with the
   server's own reason when the socket closes first, or when the setup is
   never answered. After that, every message goes to onMessage, already
   flattened by readServerMessage(), and the close to onClose({code,
   reason}); a close the page asked for is reported too, and the caller
   decides what it means. `WebSocketImpl` is for the tests. */
export function openLiveSocket({
  key, model, system, voice, onMessage = () => {}, onClose = () => {},
  WebSocketImpl = globalThis.WebSocket, setupTimeoutMs = SETUP_TIMEOUT_MS,
}) {
  return new Promise((resolve, reject) => {
    if (typeof WebSocketImpl !== 'function') {
      reject(new Error('This browser has no WebSocket, which a live conversation needs.'));
      return;
    }
    let ws;
    try {
      ws = new WebSocketImpl(`${LIVE_URL}?key=${encodeURIComponent(key)}`);
    } catch (e) {
      reject(new Error(`Could not open a connection to Gemini: ${e.message}`));
      return;
    }
    ws.binaryType = 'arraybuffer';
    let ready = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch (e) { /* already closing */ }
      reject(new Error('Gemini did not accept the conversation in time. Try again.'));
    }, setupTimeoutMs);

    const send = (obj) => {
      if (ws.readyState === 1) ws.send(JSON.stringify(obj));
    };
    const handle = {
      sendAudio: (base64) => send(audioMessage(base64)),
      sendText: (text, complete = true) => send(textMessage(text, complete)),
      close: () => { try { ws.close(1000); } catch (e) { /* already closed */ } },
    };

    ws.onopen = () => send(setupMessage({ model, system, voice }));
    ws.onmessage = (event) => {
      const message = readServerMessage(decodeFrame(event.data));
      if (!ready) {
        if (!message.setupComplete) return;
        ready = true;
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(handle);
        return;
      }
      onMessage(message);
    };
    /* An error event carries nothing a page may read; the close that
       follows it carries the reason. */
    ws.onerror = () => {};
    ws.onclose = (event) => {
      const info = { code: event && event.code, reason: event && event.reason };
      if (!ready) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error(closeReason(info)));
        return;
      }
      onClose(info);
    };
  });
}
