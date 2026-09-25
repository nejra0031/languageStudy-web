/* Turning a bank's WAV sentences into Ogg Opus, in place.

   Sentences banked before dictation audio was saved as Opus are WAV, twelve
   times the size of the same speech as Ogg. This converts them one at a time,
   in an order that never leaves a sentence without playable audio:

     encode → write the .ogg → point the entry at it → save the manifest
     → only then remove the .wav

   The manifest is saved every few sentences rather than after each one (it
   is rewritten whole, and a bank runs to hundreds), and the WAVs of a batch
   are removed only once the save that stops pointing at them has landed. If
   anything throws partway, what has been switched is saved and everything
   else is left exactly as it was.

   Storage and the encoder are passed in, so this is testable in node. */

import { wavSamples } from './gemini.js';

const WAV = /\.wav$/i;

export function isWavEntry(entry) {
  return !!entry && WAV.test(entry.file || '');
}

/* `io`:
     read(path)         bytes, or null when the file is missing
     write(path, bytes) true when it landed
     remove(path)
     list()             names in audio/, for the leftovers sweep
     save()             writes the manifest as it now stands
     encode(pcm, rate)  Ogg bytes, or null
   Returns what happened, counted. */
export async function convertBank(manifest, io, { batch = 20, onProgress } = {}) {
  const todo = manifest.filter(isWavEntry);
  const result = { total: todo.length, converted: 0, missing: 0, unusual: 0, failed: 0, before: 0, after: 0 };
  let switched = [];

  const flush = async () => {
    if (!switched.length) return;
    await io.save();
    const gone = switched;
    switched = [];
    for (const path of gone) await io.remove(path);
  };

  try {
    for (let i = 0; i < todo.length; i++) {
      const entry = todo[i];
      const bytes = await io.read(entry.file);
      if (!bytes) {
        result.missing++;
      } else {
        /* Only 16-bit mono PCM goes to the encoder — every WAV this app
           has written. Anything else stays as it is and keeps playing. */
        const inside = wavSamples(bytes);
        if (!inside) {
          result.unusual++;
        } else {
          const ogg = await io.encode(inside.pcm, inside.rate);
          const path = entry.file.replace(WAV, '.ogg');
          if (!ogg || !(await io.write(path, ogg))) {
            result.failed++;
          } else {
            switched.push(entry.file);
            entry.file = path;
            result.converted++;
            result.before += bytes.length;
            result.after += ogg.length;
            if (switched.length >= batch) await flush();
          }
        }
      }
      if (onProgress) onProgress(i + 1, todo.length);
    }
  } finally {
    await flush();
  }

  /* A run cut off between a save and its removals leaves a WAV that nothing
     points at any more. Its twin is in the manifest as .ogg, so it can go. */
  const oggs = new Set(manifest.map((e) => e.file).filter((f) => /\.ogg$/i.test(f || '')));
  for (const name of await io.list()) {
    if (WAV.test(name) && oggs.has(`audio/${name.replace(WAV, '.ogg')}`)) await io.remove(`audio/${name}`);
  }
  return result;
}
