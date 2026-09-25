/* The one request to Google Translate, for the selection popup.

   This is the keyless endpoint Google's own translate widgets call, not the
   Cloud Translation API: nothing to set up, no key, nothing counted against
   the Gemini budget. It is also undocumented, and Google turns a network
   away with a 429 when it decides the traffic looks automated — so every
   failure here is a readable message, and the popup leaves the fields for
   the student to fill in themselves. */

import { translateUrl, readTranslation, resolveDirection } from './lookup.js';

export class TranslateError extends Error {}

async function ask(text, sl, tl) {
  let res;
  try {
    res = await fetch(translateUrl(text, sl, tl));
  } catch (e) {
    throw new TranslateError('Could not reach Google Translate. Type the meaning yourself.');
  }
  if (res.status === 429) {
    throw new TranslateError('Google Translate is refusing requests from this network for now. Type the meaning yourself.');
  }
  if (!res.ok) throw new TranslateError(`Google Translate answered ${res.status}. Type the meaning yourself.`);
  const read = readTranslation(await res.json().catch(() => null));
  if (!read) throw new TranslateError('Google Translate sent back something that could not be read. Type the meaning yourself.');
  return read;
}

/* The selection as a card: `front` in the language being learnt, `back` in
   the student's own. Selected text in their own language costs a second
   request, because the first one was asked the wrong way round — Google has
   to say what language it is before anyone knows which way that is. */
export async function translate(text, { learning, native }) {
  const first = await ask(text, 'auto', native);
  if (resolveDirection(first.detected, learning, native) === 'forward') {
    return { front: text, back: first.text, detected: first.detected, direction: 'forward' };
  }
  if (!learning) {
    throw new TranslateError('That looks like the meaning, and no language to learn is set. Choose one under Add from selected text in Settings.');
  }
  const second = await ask(text, native, learning);
  return { front: second.text, back: text, detected: first.detected, direction: 'reverse' };
}
