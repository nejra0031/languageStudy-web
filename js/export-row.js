/* The Export row: the one button, tickbox and note that each tab with a
   kept record puts beside it. The file itself is built by export-html.js,
   which has no DOM; this is the press, the reading of the recordings and
   the download, written once for the four tabs that have it.

   A row is markup in index.html: a button with data-export, a label
   holding a tickbox with data-export-audio, and a note with
   data-export-note. `job()` is the tab's: null when there is nothing to
   export, or {kind, record, read, build}, where `read(path)` gives a
   recording as a Blob and `build(record, {audio, withAudio})` is one of
   export-html.js's functions. */

import * as storage from './storage.js';
import { audioPaths, gatherAudio, sizeLabel } from './export-html.js';

const ABOUT = 'One .html file that opens in any browser, to send to someone else: nothing to unzip.';

export function wireExport(row, job) {
  const btn = row.querySelector('[data-export]');
  const box = row.querySelector('[data-export-audio]');
  const note = row.querySelector('[data-export-note]');
  let saved = null;

  function say(text, bad = false) {
    note.textContent = text;
    note.classList.toggle('is-bad', bad);
  }

  btn.addEventListener('click', async () => {
    const j = job();
    if (!j) return;
    const paths = audioPaths(j.kind, j.record);
    const withAudio = paths.length > 0 && box.checked;
    btn.disabled = true;
    say(withAudio ? 'Reading the recordings…' : '');
    try {
      const got = withAudio ? await gatherAudio(paths, j.read) : { audio: new Map(), missing: [] };
      const { filename, html } = j.build(j.record, { audio: got.audio, withAudio });
      const blob = new Blob([html], { type: 'text/html' });
      storage.download(filename, blob, 'text/html');
      saved = j.record;
      const lost = got.missing.length;
      say(`Saved ${filename} (${sizeLabel(blob.size)})${!withAudio && paths.length ? ', without audio' : ''}.`
        + (lost ? ` ${lost} recording${lost === 1 ? '' : 's'} could not be read, and the file says so.` : ''), lost > 0);
    } catch (e) {
      console.error(e);
      say(`Could not export this: ${(e && e.message) || e}`, true);
    } finally {
      btn.disabled = false;
    }
  });

  /* Called whenever the tab redraws: the row is there while there is a
     record, the tickbox only while that record has recordings, and what
     was said about the last export stays only while its record does. */
  return function sync() {
    const j = job();
    row.hidden = !j;
    if (!j) { saved = null; return; }
    box.closest('label').hidden = audioPaths(j.kind, j.record).length === 0;
    if (saved !== j.record) {
      saved = null;
      say(ABOUT);
    }
  };
}
