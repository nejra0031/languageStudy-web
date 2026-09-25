/* Where the app keeps its state.

   There is no server and no database. Everything the app remembers lives in
   one directory, laid out the same way whichever directory that turns out to
   be:

     settings.json        the model catalogue, which model does which job,
                          voices, language, prompts
     decks/<slug>.json    one deck per file
     audio/manifest.json  the dictation bank index
     audio/quota.json     the rolling API call budget
     audio/<id>.ogg|.txt  generated speech and its transcript (.wav
                          for sentences made before Opus, or where the
                          browser cannot encode it)
     shadowing/manifest.json   the shadowing session index
     shadowing/<id>.json       one session: its lines and its feedback
     shadowing/<id>_<n>_t<k>.webm   your own voice: take k of line n. Takes
                               that were handed in are kept; one recorded
                               over before a hand-in is not
     voice/<voice>_<hash>.mp3  a word read by an Azure voice, kept so it is
                               fetched once, ever — see azure-tts.js

   Two kinds of directory can hold that layout:

     'folder'    a folder on disk the user picked — see fs-folder.js
     'browser'   the origin private file system — see fs-opfs.js

   A folder is the better store in every way that matters, but it takes a
   click, and until that click has happened there is still a session's work to
   keep. So browser storage is the floor rather than a last resort for the
   browsers that have nothing else: the app saves there from the first
   keystroke, and a folder, once chosen, takes over and is copied into.

   Chromium has both. Firefox and Safari have browser storage only, and no
   picker to offer. Exactly one store is live at a time — writes must never be
   split across two — which is what copyFromBrowser() is for.

   Both kinds are FileSystemDirectoryHandles, so every file operation below is
   the same code either way. The backend modules differ only in how the root
   handle is got and what may be assumed about keeping it.

   The API key is the one thing that never goes in here — it stays in
   localStorage, so pointing the app at a folder that happens to be a git clone
   cannot leak it. */

import * as folder from './fs-folder.js';
import * as opfs from './fs-opfs.js';

const KEY_STORAGE = 'lsw.apiKey';

export const SUPPORTS_FOLDER = folder.SUPPORTED;
export const SUPPORTS_BROWSER = opfs.SUPPORTED;

/* ── the live store ──────────────────────────────────────────────────── */

let root = null;
let kind = null;
let rootName = '';
let persisted = false;
/* Set when a folder write failed and the handle was dropped. It changes
   nothing about how the app saves — it is the difference between "you never
   chose a folder" and "the folder you chose has gone", which are different
   things to tell someone. */
let lost = false;
const listeners = new Set();

export function onStoreChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function announce() {
  for (const fn of listeners) {
    try { fn(kind); } catch (e) { console.error(e); }
  }
}

export function isConnected() {
  return !!root;
}

/* 'folder', 'browser', or null when nothing is being saved. */
export function backend() {
  return kind;
}

/* What to call the place, for the line of UI that says where saving goes. */
export function label() {
  if (kind === 'folder') return rootName;
  if (kind === 'browser') return 'this browser';
  return null;
}

/* True when a folder was being written to and the handle went stale. */
export function lostFolder() {
  return lost;
}

/* Only meaningful for browser storage: whether it is exempt from eviction. */
export function isPersisted() {
  return kind !== 'browser' || persisted;
}

async function adopt(k, handle) {
  root = handle;
  kind = k;
  lost = false;
  rootName = handle.name || '';
  persisted = k === 'browser' ? await opfs.requestPersistence() : true;
  announce();
}

function release() {
  root = null;
  kind = null;
  rootName = '';
  persisted = false;
}

/* Must be called from a click. */
export async function connect() {
  await adopt('folder', await folder.pick());
  return label();
}

/* Called once at boot. Never prompts for a folder — a prompt without a click
   is refused by the browser, and would be rude anyway.

   A remembered folder wins. Failing that the app falls back to browser
   storage, whether or not this browser could have offered a picker: the
   alternative is saving nothing at all until the user finds the button, and a
   first session lost to a reload is worse than files in a place they cannot
   browse. Choosing a folder later moves everything across.

   The one case that adopts nothing is a remembered folder whose permission has
   lapsed. Browser storage would take the writes while the real setup sat in
   the folder, and half a setup in each place is worse than a button that says
   "reconnect". */
export async function restore() {
  if (folder.SUPPORTED) {
    const saved = await folder.remembered();
    if (saved && saved.permission === 'granted') {
      await adopt('folder', saved.handle);
      return { state: 'folder', name: label() };
    }
    if (saved) return { state: 'needs-permission', name: saved.handle.name, handle: saved.handle };
  }
  if (opfs.SUPPORTED) {
    try {
      await adopt('browser', await opfs.root());
      return { state: 'browser', persisted };
    } catch (e) {
      console.error('Browser storage is there but would not open', e);
      release();
    }
  }
  return { state: 'unsupported' };
}

/* Must be called from a click. */
export async function regrant(handle) {
  if (!(await folder.regrant(handle))) return false;
  await adopt('folder', handle);
  return true;
}

/* Leaves the folder and lands back on browser storage, taking the folder's
   current contents with it. Without that copy the app would drop back to
   whatever browser storage held on the day the folder was chosen, which by
   then could be months stale. */
export async function disconnect() {
  await copyToBrowser();
  release();
  await folder.forget();
  if (opfs.SUPPORTED) {
    try {
      await adopt('browser', await opfs.root());
      return backend();
    } catch (e) {
      console.error('Browser storage would not open', e);
      release();
    }
  }
  announce();
  return backend();
}

/* A folder write failing usually means the handle went stale — the folder was
   moved, renamed, or its permission revoked. Drop it so the UI asks for a
   fresh one instead of silently losing every later write too.

   Browser storage cannot go stale that way: a failure there is the disk or the
   quota, everything already written is still readable, and there is no other
   store to fall back to — so the root is worth keeping. */
async function invalidate(err) {
  console.error('Write failed', err);
  if (kind !== 'folder') return;
  release();
  lost = true;
  await folder.forget();
  announce();
}

async function subdir(name, create) {
  if (!root) return null;
  try {
    return await root.getDirectoryHandle(name, { create });
  } catch (e) {
    return null;
  }
}

/* ── files ───────────────────────────────────────────────────────────── */

/* Walks a path under any root. Copying between two stores needs to reach into
   a directory that is not the live one, so the root is a parameter here and
   resolve() below is the live-store case of it. */
async function resolveIn(base, path, { create = false } = {}) {
  if (!base) return null;
  const parts = path.split('/');
  const file = parts.pop();
  let dir = base;
  for (const part of parts) {
    dir = await dir.getDirectoryHandle(part, { create }).catch(() => null);
    if (!dir) return null;
  }
  return dir.getFileHandle(file, { create }).catch(() => null);
}

function resolve(path, opts) {
  return resolveIn(root, path, opts);
}

export async function readText(path) {
  const handle = await resolve(path);
  if (!handle) return null;
  try {
    const file = await handle.getFile();
    return await file.text();
  } catch (e) {
    return null;
  }
}

export async function readJson(path) {
  const text = await readText(path);
  if (text === null) return null;
  try { return JSON.parse(text); } catch (e) {
    console.error(`${path} is not valid JSON`, e);
    return null;
  }
}

export async function writeText(path, text) {
  const handle = await resolve(path, { create: true });
  if (!handle) return false;
  try {
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
    return true;
  } catch (e) {
    await invalidate(e);
    return false;
  }
}

export function writeJson(path, value) {
  return writeText(path, JSON.stringify(value, null, 2) + '\n');
}

export async function writeBlob(path, blob) {
  const handle = await resolve(path, { create: true });
  if (!handle) return false;
  try {
    const writable = await handle.createWritable();
    await writable.write(blob);
    await writable.close();
    return true;
  } catch (e) {
    await invalidate(e);
    return false;
  }
}

export async function readBlob(path) {
  const handle = await resolve(path);
  if (!handle) return null;
  try {
    return await handle.getFile();
  } catch (e) {
    return null;
  }
}

export async function readBlobUrl(path) {
  const file = await readBlob(path);
  return file ? URL.createObjectURL(file) : null;
}

export async function remove(path) {
  const parts = path.split('/');
  const file = parts.pop();
  let dir = root;
  for (const part of parts) {
    if (!dir) return false;
    dir = await dir.getDirectoryHandle(part).catch(() => null);
  }
  if (!dir) return false;
  return dir.removeEntry(file).then(() => true, () => false);
}

/* entries() is the natural way to walk a directory, but the browsers that only
   have browser storage were also the slowest to the async iterators, so fall
   back to values() where entries() is missing. */
async function* handlesIn(dir) {
  if (typeof dir.entries === 'function') {
    for await (const [, entry] of dir.entries()) yield entry;
  } else if (typeof dir.values === 'function') {
    for await (const entry of dir.values()) yield entry;
  }
}

/* Every file directly inside one of the data directories, by name. */
export async function listIn(dirName) {
  const dir = await subdir(dirName, false);
  if (!dir) return [];
  const names = [];
  for await (const entry of handlesIn(dir)) {
    if (entry.kind === 'file') names.push(entry.name);
  }
  return names.sort();
}

export async function listDecks() {
  const names = await listIn('decks');
  return names.filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
}

export function ensureSubdirs() {
  return Promise.all(DATA_DIRS.map((name) => subdir(name, true)));
}

/* ── the data layout, as a set of paths ──────────────────────────────── */

const DATA_DIRS = ['decks', 'audio', 'shadowing', 'voice'];

/* Exactly the files this app owns. Everything else in a folder — a .git, a
   README, a .DS_Store, the ._name AppleDouble files macOS adds when it zips —
   belongs to whoever put it there, and is neither backed up nor restored.

   The shadowing takes carry four possible extensions because MediaRecorder
   hands back whatever its browser prefers: webm on Chrome, ogg on Firefox,
   mp4 on Safari. The file is named from the recorder's own mimeType rather
   than assumed, so a backup written on one browser opens on another. */

const DATA_FILE = /^(settings\.json|decks\/[^/.][^/]*\.json|audio\/[^/.][^/]*\.(json|wav|ogg|txt)|shadowing\/[^/.][^/]*\.(json|webm|ogg|mp4|m4a|wav)|voice\/[^/.][^/]*\.mp3)$/;

/* Maps a path from a zip or a picked folder onto the data layout, or null.
   Leading folders are dropped, because a backup that was unzipped and zipped
   again by the operating system nests everything under its own name. */
export function dataPath(raw) {
  const parts = String(raw).replace(/\\/g, '/').split('/').filter(Boolean);
  if (parts.includes('__MACOSX')) return null;
  for (let i = 0; i < parts.length; i++) {
    const candidate = parts.slice(i).join('/');
    if (DATA_FILE.test(candidate)) return candidate;
  }
  return null;
}

/* Every data file under a root, as {path, handle}. Only the app's own corners
   are walked — see DATA_FILE. */
async function* dataFilesUnder(base) {
  if (!base) return;
  const settings = await resolveIn(base, 'settings.json');
  if (settings) yield { path: 'settings.json', handle: settings };
  for (const name of DATA_DIRS) {
    const dir = await base.getDirectoryHandle(name).catch(() => null);
    if (!dir) continue;
    for await (const entry of handlesIn(dir)) {
      const path = `${name}/${entry.name}`;
      if (entry.kind === 'file' && dataPath(path) === path) yield { path, handle: entry };
    }
  }
}

/* Every data file the live store holds, as {path, data}, for a backup. */
export async function allFiles() {
  const out = [];
  for await (const { path, handle } of dataFilesUnder(root)) {
    const file = await handle.getFile().catch(() => null);
    if (file) out.push({ path, data: file });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

/* Writes files straight into the live store, for a restore. Returns how many
   landed. Paths are mapped through dataPath() first, so nothing outside the
   layout can be written whatever a zip claims to contain. */
export async function writeDataFiles(files) {
  let n = 0;
  for (const { path, data } of files) {
    const safe = dataPath(path);
    if (!safe) continue;
    if (await writeBlob(safe, data instanceof Blob ? data : new Blob([data]))) n++;
  }
  return n;
}

/* ── moving between the two stores ───────────────────────────────────── */

async function copyBetween(from, to) {
  let n = 0;
  for await (const { path, handle } of dataFilesUnder(from)) {
    const file = await handle.getFile().catch(() => null);
    if (!file) continue;
    const target = await resolveIn(to, path, { create: true });
    if (!target) continue;
    try {
      const writable = await target.createWritable();
      await writable.write(file);
      await writable.close();
      n++;
    } catch (e) {
      console.error(`Could not copy ${path}`, e);
    }
  }
  return n;
}

/* Whether the live store already holds a setup of its own. */
async function hasData() {
  if (await resolve('settings.json')) return true;
  return (await listDecks()).length > 0;
}

/* Browser storage into the folder just connected — the one-way trip a first
   folder makes, so a session practised before there was anywhere better is not
   left behind in a place the user cannot see.

   Refuses a folder that already holds a setup: that folder is the record, and
   a stale browser copy must never be allowed to write over it. */
export async function copyFromBrowser() {
  if (kind !== 'folder' || !opfs.SUPPORTED) return 0;
  if (await hasData()) return 0;
  const src = await opfs.root().catch(() => null);
  if (!src) return 0;
  await ensureSubdirs();
  return copyBetween(src, root);
}

/* The folder back into browser storage, which is what makes disconnecting
   safe: browser storage is the floor the app lands on, and it would otherwise
   still hold whatever was there on the day the folder was chosen.

   What is already there is cleared first, not written over. Copying alone
   would leave a deck that was deleted while the folder was connected sitting
   in browser storage, ready to reappear on disconnect — the folder is the
   record, so this makes browser storage match it exactly. */
async function copyToBrowser() {
  if (kind !== 'folder' || !opfs.SUPPORTED) return 0;
  const dest = await opfs.root().catch(() => null);
  if (!dest) return 0;
  /* Listed in full before anything is removed: deleting entries out of a
     directory that is still being iterated is not something to rely on. */
  const stale = [];
  for await (const { path } of dataFilesUnder(dest)) stale.push(path);
  for (const path of stale) {
    const parts = path.split('/');
    const name = parts.pop();
    const dir = parts.length ? await dest.getDirectoryHandle(parts[0]).catch(() => null) : dest;
    if (dir) await dir.removeEntry(name).catch(() => {});
  }
  for (const name of DATA_DIRS) await dest.getDirectoryHandle(name, { create: true }).catch(() => null);
  return copyBetween(root, dest);
}

/* ── the API key: localStorage only, never the store ─────────────────── */

export function getApiKey() {
  try { return localStorage.getItem(KEY_STORAGE) || ''; } catch (e) { return ''; }
}

export function setApiKey(key) {
  try {
    if (key) localStorage.setItem(KEY_STORAGE, key);
    else localStorage.removeItem(KEY_STORAGE);
  } catch (e) { /* private mode; the key just will not be remembered */ }
}

/* ── small values that must work with nothing connected ──────────────── */

export function localGet(key, fallback) {
  try {
    const raw = localStorage.getItem('lsw.' + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch (e) { return fallback; }
}

export function localSet(key, value) {
  try { localStorage.setItem('lsw.' + key, JSON.stringify(value)); } catch (e) { /* ignore */ }
}

/* Download as a file — the escape hatch for a browser that can save nothing,
   and for taking a deck, a sentence's audio or a whole backup out of the app.
   `data` is text or a Blob. */
export function download(filename, data, type = 'application/json') {
  const url = URL.createObjectURL(data instanceof Blob ? data : new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  /* A minute, not a second. Safari starts a large download only after the
     click returns, and revoking too soon cancels it — which a backup zip full
     of audio is exactly big enough to hit. */
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
