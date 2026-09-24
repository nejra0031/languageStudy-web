/* Settings: where data is saved, the key, the language, the models, the
   budget, the prompts and the voices. */

import * as storage from './storage.js';
import * as store from './store.js';
import {
  VOICES, MODEL_ROLES, rolesUsing,
  DEFAULT_SENTENCE_PROMPT, DEFAULT_SPEECH_PROMPT, DEFAULT_SHADOW_PROMPT,
} from './defaults.js';
import { fillTemplate, sentenceVars, formatWait, GeminiError, QuotaError, shadowSystem } from './gemini.js';
import { rulesToText, totalOf, RATINGS } from './shadow-rules.js';
import { serializeDeck } from './deck.js';
import { serializeBundle, parseBundle, describeBundle, bundleFilename } from './bundle.js';
import { makeZip, readZip } from './zip.js';
import { backupDue, lastPractice, firstPractice, agoLabel, DAYS } from './backup-due.js';
import * as speech from './speech.js';
import * as azure from './azure-tts.js';

const $ = (id) => document.getElementById(id);

/* One handle kept aside when a folder is remembered but its permission has
   lapsed — requestPermission() is only allowed from a click. */
let pendingHandle = null;

/* A file that has been read and understood but not yet written anywhere:
   either {kind:'bundle'} or {kind:'restore'}. Both can change every deck at
   once, so the file is described first and nothing happens until that has been
   confirmed. */
let pending = null;

const SAMPLE_TERMS = [
  { front: 'cải tiến', back: 'to improve' },
  { front: 'tận hưởng', back: 'to enjoy' },
  { front: 'rành', back: 'to know well' },
];

export function init() {
  wireStore();
  wireKey();
  wireModels();
  wireFields();
  wirePrompts();
  wireVoices();
  wireSpeech();
  wireShadowing();

  store.subscribe('settings', render);
  store.subscribe('folder', renderStore);
  store.subscribe('quota', renderQuota);
  store.subscribe('deck', renderStore);
  store.subscribe('settings', renderBackupDue);
  wireBackupDue();
  render();
  renderStore();
  renderQuota();
  setInterval(renderQuota, 1000);
}

/* ── where data is saved ─────────────────────────────────────────────── */

function wireStore() {
  $('store-choose').addEventListener('click', async () => {
    let moved = 0;
    try {
      if (pendingHandle) {
        const ok = await storage.regrant(pendingHandle);
        if (!ok) { setStoreStatus('Permission refused — the folder is still not being written to.', 'is-warn'); return; }
        pendingHandle = null;
      } else {
        await storage.connect();
        /* Everything saved in this browser so far goes with you. Refused if
           the folder already holds a setup of its own — see copyFromBrowser. */
        moved = await storage.copyFromBrowser();
      }
      await store.adoptFolder();
    } catch (e) {
      if (e && e.name === 'AbortError') return;
      console.error(e);
      setStoreStatus('Could not open that folder: ' + e.message, 'is-bad');
      return;
    }
    /* After adoptFolder(), because it emits and every emit rewrites this line. */
    if (moved) {
      setStoreStatus(`Saving to "${storage.label()}" — ${plural(moved, 'file')} moved across from this browser's storage.`, 'is-ok');
    }
  });

  $('store-disconnect').addEventListener('click', async () => {
    const was = storage.label();
    const landed = await storage.disconnect();
    if (landed) {
      await store.adoptFolder();
      setStoreStatus(`Disconnected from "${was}". Everything in it was copied back into this browser's storage, which is what is being saved to now.`, 'is-ok');
    } else {
      store.releaseFolder();
      setStoreStatus(`Disconnected from "${was}". This browser has nowhere else to save, so nothing is being saved.`, 'is-warn');
    }
  });

  $('store-export').addEventListener('click', () => {
    storage.download(`${store.state.deckName}.json`, serializeDeck(store.state.cards));
  });

  $('store-export-all').addEventListener('click', () => {
    const bundle = store.exportBundle();
    const name = bundleFilename();
    storage.download(name, serializeBundle(bundle));
    setStoreStatus(`Exported ${describeBundle(readBack(bundle))} to ${name}.`, 'is-ok');
    backedUp();
  });

  $('backup-download').addEventListener('click', async () => {
    if (!store.state.persistent) {
      setStoreStatus('Nothing is being saved, so there is nothing to back up. Use Export everything for the decks held in memory.', 'is-warn');
      return;
    }
    const files = await storage.allFiles();
    if (!files.length) {
      setStoreStatus('The store is empty — there is nothing to back up yet.', 'is-warn');
      return;
    }
    const name = backupFilename();
    const zip = await makeZip(files);
    storage.download(name, zip);
    setStoreStatus(`Backed up ${plural(files.length, 'file')} (${size(zip.size)}) to ${name}.`, 'is-ok');
    backedUp();
  });

  $('backup-restore').addEventListener('click', () => {
    if (!store.state.persistent) {
      setStoreStatus('There is nowhere to restore to. This browser is saving nothing at the moment.', 'is-warn');
      return;
    }
    $('backup-restore-file').click();
  });

  $('backup-restore-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file) return;
    showImport(null);
    let entries;
    try {
      entries = await readZip(file);
    } catch (err) {
      setStoreStatus(`${file.name} could not be read: ${err.message}`, 'is-bad');
      return;
    }
    /* Anything outside the data layout is dropped here, before the file is
       described — so what the preview promises is exactly what gets written. */
    const files = [];
    for (const { path, bytes } of entries) {
      const safe = storage.dataPath(path);
      if (safe) files.push({ path: safe, data: new Blob([bytes]) });
    }
    if (!files.length) {
      setStoreStatus(`${file.name} holds no data files this app recognises — a backup has settings.json, decks/ and audio/ in it.`, 'is-bad');
      return;
    }
    pending = { kind: 'restore', name: file.name, files };
    showImport(`${file.name} holds ${describeFiles(files)}. Restoring writes them straight into ${storage.label()}, overwriting any file of the same name. Decks you have that the backup does not are left alone.`);
  });

  $('store-import').addEventListener('click', () => {
    if (!store.state.persistent) {
      setStoreStatus('There is nowhere to import to yet. Choose a folder first, so the decks have somewhere to land.', 'is-warn');
      return;
    }
    $('store-import-file').click();
  });

  $('store-import-file').addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    /* Cleared so that picking the same file again still counts as a change. */
    e.target.value = '';
    if (!file) return;
    showImport(null);
    let text = '';
    try {
      text = await file.text();
    } catch (err) {
      setStoreStatus(`Could not read ${file.name}: ${err.message}`, 'is-bad');
      return;
    }
    const parsed = parseBundle(text);
    if (parsed.error) {
      setStoreStatus(`${file.name} cannot be imported — ${parsed.error}`, 'is-bad');
      return;
    }
    pending = { kind: 'bundle', bundle: parsed.bundle };
    showImport(`${file.name} holds ${describeBundle(parsed.bundle)}. Importing adds these decks alongside the ones you have — nothing is replaced or overwritten, and a name already in use gets a free one.`);
  });

  $('import-confirm').addEventListener('click', async () => {
    const action = pending;
    pending = null;
    showImport(null);
    if (!action) return;
    if (action.kind === 'restore') { await runRestore(action); return; }
    const bundle = action.bundle;
    let added = [];
    try {
      added = await store.importBundle(bundle);
    } catch (err) {
      setStoreStatus(`Import failed: ${err.message}`, 'is-bad');
      return;
    }
    /* After the import, because it emits and every emit rewrites this line. */
    const renamed = added.filter((a) => a.name !== a.from);
    const bits = [`Imported ${added.length} deck${added.length === 1 ? '' : 's'}`];
    if (renamed.length) {
      bits.push(`renamed to avoid a clash: ${renamed.map((r) => `"${r.from}" → "${r.name}"`).join(', ')}`);
    }
    if (bundle.settings) bits.push('settings applied');
    setStoreStatus(bits.join(' · ') + '.', 'is-ok');
  });

  $('import-cancel').addEventListener('click', () => {
    pending = null;
    showImport(null);
    setStoreStatus('Cancelled — nothing was changed.', '');
  });
}

/* Writes a checked backup into the live store and rereads everything, since a
   restore can replace the settings and every deck in one go. */
async function runRestore(action) {
  let written = 0;
  try {
    written = await storage.writeDataFiles(action.files);
  } catch (err) {
    setStoreStatus(`Restore failed: ${err.message}`, 'is-bad');
    return;
  }
  await store.adoptFolder();
  setStoreStatus(`Restored ${plural(written, 'file')} from ${action.name}.`, 'is-ok');
}

function backupFilename(now = new Date()) {
  return `language-study-backup-${now.toISOString().slice(0, 10)}.zip`;
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function size(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/* What a backup holds, counted the way someone thinks about it. */
function describeFiles(files) {
  const decks = files.filter((f) => f.path.startsWith('decks/')).length;
  const audio = files.filter((f) => /^audio[/].+[.](wav|ogg)$/.test(f.path)).length;
  const bits = [];
  if (decks) bits.push(plural(decks, 'deck'));
  if (audio) bits.push(plural(audio, 'banked sentence'));
  if (files.some((f) => f.path === 'settings.json')) bits.push('settings');
  return bits.length ? bits.join(', ') : plural(files.length, 'file');
}

/* Show the pending bundle, or hide the whole block when there is none. */
function showImport(text) {
  const box = $('import-preview');
  $('import-note').textContent = text || '';
  box.hidden = !text;
}

/* describeBundle() speaks about a parsed bundle, so an exported one is read
   back through the same parser to be described by the same code. */
function readBack(bundle) {
  const parsed = parseBundle(serializeBundle(bundle));
  return parsed.bundle || { decks: [], settings: bundle.settings || null, exported: bundle.exported || null };
}

export async function restoreStore() {
  const result = await storage.restore();
  if (result.state === 'folder' || result.state === 'browser') {
    await store.adoptFolder();
    return;
  }
  if (result.state === 'needs-permission') {
    pendingHandle = result.handle;
    $('store-choose').textContent = `Reconnect "${result.name}"`;
    setStoreStatus(`"${result.name}" is remembered but the browser needs you to allow it again.`, 'is-warn');
    return;
  }
  if (result.state === 'unsupported') {
    setStoreStatus('This browser can save nothing: it has neither a folder picker nor writable browser storage. Use Export everything to keep your work, or open this page in a current Chrome, Edge, Firefox or Safari.', 'is-warn');
  }
}

function renderStore() {
  renderBackupDue();
  const kind = storage.backend();
  const where = storage.label();
  const decks = store.state.deckNames.length;
  const banked = store.state.manifest.length;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

  /* Choosing a folder is only offered where folders exist. Elsewhere browser
     storage is already live and there is nothing to choose between. */
  $('store-choose').hidden = kind === 'folder' || !storage.SUPPORTS_FOLDER;
  $('store-disconnect').hidden = kind !== 'folder';
  $('store-export').hidden = !store.state.cards.length;
  $('store-hint').textContent = where || 'nothing is being saved';

  if (kind === 'folder') {
    setStoreStatus(`Saving to "${where}" — ${plural(decks, 'deck')}, ${plural(banked, 'banked sentence')}.`, 'is-ok');
  } else if (kind === 'browser') {
    /* Said every time, because these files are ones the user cannot go and
       copy: the only warning they will get is this line. */
    const risk = storage.isPersisted()
      ? 'Clearing site data for this page deletes it.'
      : 'The browser has not promised to keep it: clearing site data, or weeks without opening this page, deletes it.';
    const last = backupState();
    setStoreStatus(`Saving in this browser — ${plural(decks, 'deck')}, ${plural(banked, 'banked sentence')}. ${risk} Last backup: ${last.never ? 'never' : agoLabel(last.days)}.`, last.due ? 'is-warn' : 'is-ok');
  } else if (storage.lostFolder()) {
    /* Different from never having chosen one: the data is still in that
       folder, and the way back is to point at it again. */
    setStoreStatus('Lost access to the data folder — it may have been moved, renamed, or its permission withdrawn. Nothing is being saved until you choose it again.', 'is-bad');
  } else if (!pendingHandle) {
    setStoreStatus('Nothing is being saved. The app still works, but a reload loses it.', '');
  }
  updateBar();
}

/* ── the backup reminder ─────────────────────────────────────────────── */

function backupState() {
  const s = store.state.settings;
  return backupDue({
    kind: storage.backend(),
    persisted: storage.isPersisted(),
    lastBackup: s.lastBackup,
    since: s.backupSince,
    snoozedUntil: s.backupSnoozedUntil,
    practiced: lastPractice(Object.values(store.state.decks).flat(), store.state.manifest),
  });
}

function backedUp() {
  store.saveSettings({ lastBackup: new Date().toISOString(), backupSnoozedUntil: '' });
}

function wireBackupDue() {
  /* The same backup as the button in Your data, from wherever the banner is. */
  $('backup-due-save').addEventListener('click', () => $('backup-download').click());
  $('backup-due-later').addEventListener('click', () => {
    store.saveSettings({ backupSnoozedUntil: new Date(Date.now() + DAYS.snooze * 86400000).toISOString() });
  });
}

function renderBackupDue() {
  /* Counting starts from the earliest practice the decks show — so someone
     who has used the app for months without a backup hears about it now —
     or from today for a new user, who is not told they have never backed up
     before they have anything to back up. */
  if (storage.backend() && !store.state.settings.backupSince) {
    const since = firstPractice(Object.values(store.state.decks).flat()) || new Date().toISOString();
    store.saveSettings({ backupSince: since });
    return;
  }
  const state = backupState();
  $('backup-due').hidden = !state.due;
  if (!state.due) return;
  const risk = storage.isPersisted()
    ? 'Clearing this site’s data would delete everything saved here.'
    : 'Safari deletes a site’s saved data after a week of using Safari without opening the site, and any browser can clear it.';
  $('backup-due-text').textContent = (state.never
    ? `You have practised for ${state.days} days without a backup. `
    : `Your last backup was ${agoLabel(state.days)}, and you have practised since. `) + risk;
}

function setStoreStatus(text, cls) {
  const el = $('store-status');
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

export function updateBar() {
  const el = $('bar-status');
  const where = storage.label();
  const s = store.state.settings;
  const bits = [s.targetLanguage || '—', where ? `saving to ${where}` : 'not saving'];
  if (!storage.getApiKey()) bits.push('no API key');
  el.textContent = bits.join('  ·  ');
  el.className = 'bar-status ' + (where ? 'is-live' : 'is-off');
}

/* ── key ─────────────────────────────────────────────────────────────── */

function wireKey() {
  const input = $('api-key');
  input.value = storage.getApiKey();
  input.addEventListener('input', () => {
    storage.setApiKey(input.value.trim());
    updateBar();
  });

  $('key-test').addEventListener('click', async () => {
    const btn = $('key-test');
    const note = $('key-test-note');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Testing';
    note.textContent = '';
    try {
      const reply = await store.client.testKey();
      note.textContent = `Working — ${store.state.settings.textModel} replied "${reply}".`;
      note.style.color = 'var(--ok)';
    } catch (e) {
      note.textContent = describe(e);
      note.style.color = 'var(--bad)';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Test key';
      renderQuota();
    }
  });
}

export function describe(e) {
  if (e instanceof QuotaError) return `${e.message}`;
  if (e instanceof GeminiError) return e.message;
  return (e && e.message) || String(e);
}

/* ── plain fields ────────────────────────────────────────────────────── */

/* The plain settings: one input, one path, committed on change. The models
   are not among them — they are a list with their own rules, in wireModels(),
   and the three jobs are dropdowns filled from it. */
const FIELDS = [
  ['set-language', 'targetLanguage', 'text'],
  ['set-level', 'learnerLevel', 'text'],
  ['set-note', 'languageNote', 'text'],
  ['set-shadow-items', 'shadowItems', 'int'],
  ['set-revise-after', 'shadowReviseAfter', 'int'],
  ['set-wmin', 'sentenceWords.min', 'int'],
  ['set-wmax', 'sentenceWords.max', 'int'],
  ['set-terms', 'termsPerSentence', 'int'],
];

function wireFields() {
  for (const [id, path, kind] of FIELDS) {
    $(id).addEventListener('change', () => {
      const raw = $(id).value;
      const value = kind === 'int' ? Math.max(0, Math.round(Number(raw) || 0)) : raw.trim();
      store.saveSettings(setPath(store.state.settings, path, value));
      renderPreview();
    });
  }
  $('quota-reset').addEventListener('click', () => { store.resetQuota(); renderQuota(); });
}

function setPath(settings, path, value) {
  const [head, tail] = path.split('.');
  if (!tail) return { [head]: value };
  return { [head]: { ...settings[head], [tail]: value } };
}

function getPath(settings, path) {
  const [head, tail] = path.split('.');
  return tail ? settings[head][tail] : settings[head];
}

function render() {
  const s = store.state.settings;
  for (const [id, path] of FIELDS) {
    const el = $(id);
    if (document.activeElement !== el) el.value = getPath(s, path);
  }
  const sp = $('set-prompt-sentence');
  const pp = $('set-prompt-speech');
  const hp = $('set-prompt-shadowing');
  if (document.activeElement !== sp) sp.value = s.prompts.sentence;
  if (document.activeElement !== pp) pp.value = s.prompts.speech;
  if (document.activeElement !== hp) hp.value = s.prompts.shadowing;
  renderModels();
  renderVoices();
  renderShadowing();
  renderPreview();
  updateBar();
}

/* ── prompts ─────────────────────────────────────────────────────────── */

/* Each prompt has an Edit and a Preview view of one box. The preview is a
   second, read-only textarea that takes the editor's place rather than the
   editor's own text being swapped out: the editor is what draftSettings()
   reads, and what a blur commits, so it must never hold rendered text. */
const PROMPT_VIEWS = ['sentence', 'speech', 'shadowing'];

function wirePrompts() {
  const sp = $('set-prompt-sentence');
  const pp = $('set-prompt-speech');
  sp.addEventListener('input', renderPreview);
  pp.addEventListener('input', renderPreview);
  sp.addEventListener('change', () => store.saveSettings({ prompts: { ...store.state.settings.prompts, sentence: sp.value } }));
  pp.addEventListener('change', () => store.saveSettings({ prompts: { ...store.state.settings.prompts, speech: pp.value } }));

  $('prompt-sentence-reset').addEventListener('click', () => {
    sp.value = DEFAULT_SENTENCE_PROMPT;
    store.saveSettings({ prompts: { ...store.state.settings.prompts, sentence: DEFAULT_SENTENCE_PROMPT } });
    renderPreview();
  });
  $('prompt-speech-reset').addEventListener('click', () => {
    pp.value = DEFAULT_SPEECH_PROMPT;
    store.saveSettings({ prompts: { ...store.state.settings.prompts, speech: DEFAULT_SPEECH_PROMPT } });
    renderPreview();
  });

  const hp = $('set-prompt-shadowing');
  hp.addEventListener('input', renderPreview);
  hp.addEventListener('change', () => store.saveSettings({ prompts: { ...store.state.settings.prompts, shadowing: hp.value } }));
  $('prompt-shadowing-reset').addEventListener('click', () => {
    hp.value = DEFAULT_SHADOW_PROMPT;
    store.saveSettings({ prompts: { ...store.state.settings.prompts, shadowing: DEFAULT_SHADOW_PROMPT } });
    renderPreview();
  });

  for (const name of PROMPT_VIEWS) {
    const seg = document.querySelector(`.seg[data-prompt="${name}"]`);
    seg.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-view]');
      if (btn) showPromptView(name, btn.dataset.view === 'preview');
    });
  }
}

function showPromptView(name, preview) {
  const editor = $(`set-prompt-${name}`);
  const shown = $(`prompt-preview-${name}`);
  /* The preview opens at whatever height the editor was dragged to, so
     switching back and forth does not make the page jump. */
  if (preview && !editor.hidden) shown.style.height = `${editor.offsetHeight}px`;
  if (!preview && !shown.hidden) editor.style.height = `${shown.offsetHeight}px`;
  editor.hidden = preview;
  shown.hidden = !preview;
  for (const btn of document.querySelectorAll(`.seg[data-prompt="${name}"] button`)) {
    btn.setAttribute('aria-pressed', String((btn.dataset.view === 'preview') === preview));
  }
}

function renderPreview() {
  const draft = draftSettings();
  const terms = store.state.cards.slice(0, 3).map((c) => ({ front: c.front, back: c.back }));
  const sample = terms.length ? terms : SAMPLE_TERMS;

  $('prompt-preview-sentence').value = [
    `── to ${draft.textModel} ──`,
    fillTemplate(draft.prompts.sentence, sentenceVars(draft, sample)),
  ].join('\n');
  $('prompt-preview-speech').value = [
    `── to ${draft.ttsModel} ──`,
    fillTemplate(draft.prompts.speech, { sentence: '<the sentence it just wrote>' }),
  ].join('\n');
  $('prompt-preview-shadowing').value = [
    `── to ${draft.shadowModel}, as the system instruction ──`,
    shadowSystem(draft, draft.shadowItems),
    '',
    '(then one text part per line, each followed by your recording of it)',
  ].join('\n');

  /* The warnings sit under their own prompt, outside the preview, so they
     are seen while editing — which is when they can be acted on. */
  const warnings = { sentence: [], speech: [], shadowing: [] };
  if (!draft.prompts.sentence.includes('{terms}')) {
    warnings.sentence.push('The sentence prompt has no {terms} placeholder, so the model is never told which words to use.');
  }
  if (!draft.prompts.speech.includes('{sentence}')) {
    warnings.speech.push('The speech prompt has no {sentence} placeholder, so it will not read the sentence.');
  }
  /* The one part of the shadowing prompt that is not taste: a reply that
     cannot be read is treated as a failure and nothing is stored, so a prompt
     that stops asking for this shape would never produce any feedback. */
  if (!draft.prompts.shadowing.includes('notes') || !draft.prompts.shadowing.includes('itemIndex')) {
    warnings.shadowing.push('The shadowing prompt no longer asks for "notes" keyed by "itemIndex". A reply that cannot be read is treated as a failure, so no feedback would ever be stored.');
  }
  if (!draft.prompts.shadowing.includes('{rules}')) {
    /* A prompt edited before rules existed lands here: the unedited old
       default is upgraded on load, but an edited one is the user's to fix. */
    warnings.shadowing.push('The shadowing prompt has no {rules} placeholder, so the listening rules are never sent and your ratings cannot improve anything. Your prompt was edited before listening rules existed: press Reset to default under it, or add {rules} to it yourself.');
  }
  for (const name of PROMPT_VIEWS) {
    const el = $(`prompt-warn-${name}`);
    el.textContent = warnings[name].join(' ');
    el.hidden = !warnings[name].length;
  }
}

/* The preview follows what is typed, before it is committed on blur. */
function draftSettings() {
  const s = store.state.settings;
  return {
    ...s,
    targetLanguage: $('set-language').value.trim() || s.targetLanguage,
    learnerLevel: $('set-level').value.trim() || s.learnerLevel,
    languageNote: $('set-note').value,
    shadowItems: Number($('set-shadow-items').value) || s.shadowItems,
    sentenceWords: {
      min: Number($('set-wmin').value) || s.sentenceWords.min,
      max: Number($('set-wmax').value) || s.sentenceWords.max,
    },
    prompts: {
      sentence: $('set-prompt-sentence').value,
      speech: $('set-prompt-speech').value,
      shadowing: $('set-prompt-shadowing').value,
    },
  };
}

/* ── the models, and what each one does ──────────────────────────────── */

/* Which <select> carries which job. defaults.js names the jobs; this is the
   only place that knows what they look like on the page. */
const ROLE_FIELD = {
  textModel: 'set-textmodel',
  ttsModel: 'set-ttsmodel',
  shadowModel: 'set-shadowmodel',
};

/* A row typed into but not yet stored. A model with no id is not a model, so
   Add a model cannot write one into the settings — it puts an empty row on the
   page and waits to see what is typed in it. */
let draftRow = false;

/* What the catalogue looked like when it was last drawn, so a settings change
   that leaves the models alone — a language edit, a deck tick — does not
   touch the rows at all. */
let drawnModels = '';

function wireModels() {
  const list = $('model-list');
  list.addEventListener('change', onModelEdit);
  list.addEventListener('click', onModelClick);

  $('model-add').addEventListener('click', () => {
    draftRow = true;
    renderModels();
    const rows = list.querySelectorAll('input[data-k="id"]');
    const last = rows[rows.length - 1];
    if (last) last.focus();
    setModelStatus('Type the model id exactly as Google spells it, then give it its limits.', '');
  });

  for (const [key] of MODEL_ROLES) {
    $(ROLE_FIELD[key]).addEventListener('change', async (e) => {
      await store.saveSettings({ [key]: e.target.value });
      renderPreview();
    });
  }
}

/* An id, a per-minute limit or a per-day limit, committed on blur. The three
   are one handler because they are one row: the limits belong to whatever id
   is in front of them, and the id is what decides whether the row exists. */
async function onModelEdit(e) {
  const input = e.target;
  const row = input.closest('.model-row');
  if (!row || !input.dataset.k) return;
  const at = Number(row.dataset.at);
  const s = store.state.settings;
  const models = s.models.map((m) => ({ ...m }));
  /* The draft row sits one past the end of the stored list. */
  const isDraft = at >= models.length;

  if (input.dataset.k !== 'id') {
    if (isDraft) return;
    const value = Math.max(0, Math.round(Number(input.value) || 0));
    models[at] = { ...models[at], [input.dataset.k]: value };
    await store.saveSettings({ models });
    renderModels(true);
    setModelStatus(describeLimits(models[at]), 'is-ok');
    return;
  }

  const id = input.value.trim();
  const clash = models.some((m, i) => i !== at && m.id === id);

  if (!id) {
    draftRow = false;
    renderModels(true);
    setModelStatus(isDraft
      ? 'Nothing added — the row was left empty.'
      : 'A model has to have an id, so that one is unchanged. Use × to remove it.',
    isDraft ? '' : 'is-warn');
    return;
  }
  if (clash) {
    renderModels(true);
    setModelStatus(`${id} is already in the list. A model is entered once and can do as many jobs as you like — give it another job below rather than adding it twice.`, 'is-warn');
    return;
  }

  if (isDraft) {
    draftRow = false;
    models.push({ id, rpm: 0, rpd: 0 });
    await store.saveSettings({ models });
    renderModels(true);
    setModelStatus(`Added ${id}. It is unlimited until you give it limits, and idle until you give it a job below.`, 'is-ok');
    return;
  }

  /* A rename. The jobs follow it: it is the same model, newly spelt, and a job
     left pointing at the old spelling would name a model nobody has. */
  const was = models[at].id;
  if (was === id) return;
  const moved = rolesUsing(s, was);
  models[at] = { ...models[at], id };
  const patch = { models };
  for (const [key] of MODEL_ROLES) if (s[key] === was) patch[key] = id;
  await store.saveSettings(patch);
  renderModels(true);
  setModelStatus(moved.length
    ? `Renamed ${was} to ${id}. ${sentenceList(moved)} moved with it.`
    : `Renamed ${was} to ${id}.`, 'is-ok');
}

async function onModelClick(e) {
  const btn = e.target.closest('.model-drop');
  if (!btn) return;
  const at = Number(btn.closest('.model-row').dataset.at);
  const s = store.state.settings;
  const models = s.models.map((m) => ({ ...m }));
  if (at >= models.length) {
    draftRow = false;
    renderModels(true);
    setModelStatus('Nothing added.', '');
    return;
  }
  const model = models[at];
  /* A job pointing at a model nobody has is the one state the catalogue must
     not reach, so a model in use is kept and the reason is said out loud.
     Because every job always names a listed model, this is also what stops the
     list from being emptied. */
  const jobs = rolesUsing(s, model.id);
  if (jobs.length) {
    setModelStatus(`${model.id} is doing ${sentenceList(jobs).toLowerCase()}. Give ${jobs.length === 1 ? 'that job' : 'those jobs'} to another model first.`, 'is-warn');
    return;
  }
  models.splice(at, 1);
  await store.saveSettings({ models });
  renderModels(true);
  setModelStatus(`Removed ${model.id}. What it has already spent is still counted under Call budget until it ages out.`, 'is-ok');
}

/* `force` redraws even when nothing in the settings moved — which is exactly
   what a refused edit needs, since the point is to put back the value the
   settings still hold. */
function renderModels(force = false) {
  const s = store.state.settings;
  const list = $('model-list');
  const signature = JSON.stringify([s.models, draftRow, MODEL_ROLES.map(([k]) => s[k])]);

  if (force || signature !== drawnModels) {
    const caret = heldCaret(list);
    list.innerHTML = [
      '<div class="model-row model-head" aria-hidden="true">'
        + '<span>Model id</span><span>Calls / min</span><span>Calls / day</span><span></span></div>',
      ...s.models.map((m, at) => modelRow(m, at, rolesUsing(s, m.id))),
      ...(draftRow ? [modelRow({ id: '', rpm: 0, rpd: 0 }, s.models.length, [])] : []),
    ].join('');
    drawnModels = signature;
    restoreCaret(list, caret);
  }

  const used = new Set(MODEL_ROLES.map(([key]) => s[key]));
  $('models-hint').textContent = s.models.length === used.size
    ? `${plural(s.models.length, 'model')}, all in use`
    : `${plural(s.models.length, 'model')}, ${used.size} in use`;

  /* The standing description of the list. An edit says what it did instead,
     after its save has emitted and been drawn — so the last thing written
     here is the last thing that happened. */
  setModelStatus(describeCatalogue(s), '');
  renderRoles();
}

function describeCatalogue(s) {
  const idle = s.models.filter((m) => !rolesUsing(s, m.id).length).map((m) => m.id);
  if (idle.length) {
    return `${sentenceList(idle)} ${idle.length === 1 ? 'is' : 'are'} listed but doing no job`
      + `, which costs nothing — give ${idle.length === 1 ? 'it one' : 'them one'} below, or remove ${idle.length === 1 ? 'it' : 'them'}.`;
  }
  const counted = s.models.filter((m) => m.rpd);
  if (counted.length < s.models.length) {
    return `${plural(s.models.length, 'model')}, all in use, not all of them counted here.`;
  }
  const total = counted.reduce((n, m) => n + m.rpd, 0);
  return `${plural(s.models.length, 'model')}, all in use, ${total} calls a day between them — each model's allowance is its own.`;
}

/* A rebuilt row is a new element, so the field someone had moved on to would
   otherwise lose focus mid-edit. It is found again by which row and which
   column it was, which survives everything but that row being removed. */
function heldCaret(list) {
  const el = document.activeElement;
  if (!list.contains(el) || !el.dataset || !el.dataset.k) return null;
  return { at: el.closest('.model-row').dataset.at, k: el.dataset.k };
}

function restoreCaret(list, caret) {
  if (!caret) return;
  const el = list.querySelector(`.model-row[data-at="${caret.at}"] input[data-k="${caret.k}"]`);
  if (el) el.focus();
}

function modelRow(model, at, jobs) {
  const id = escapeAttr(model.id);
  return `<div class="model-row" data-at="${at}">
    <label class="model-id">
      <input type="text" data-k="id" value="${id}" spellcheck="false" autocomplete="off"
             placeholder="gemini-3.6-flash" aria-label="Model id">
      <em class="model-jobs${jobs.length ? '' : ' is-idle'}">${jobs.length ? jobs.join(' · ') : (model.id ? 'no job' : 'new model')}</em>
    </label>
    <label class="model-rpm"><span>/ min</span>
      <input type="number" data-k="rpm" min="0" value="${model.rpm}" aria-label="Calls per minute${model.id ? ` for ${id}` : ''}">
    </label>
    <label class="model-rpd"><span>/ day</span>
      <input type="number" data-k="rpd" min="0" value="${model.rpd}" aria-label="Calls per day${model.id ? ` for ${id}` : ''}">
    </label>
    <button class="model-drop" type="button" aria-label="Remove ${id || 'this row'}"
            title="${jobs.length ? `${escapeAttr(sentenceList(jobs))} run${jobs.length > 1 ? '' : 's'} on this model — give that job to another one first` : 'Remove this model'}"${jobs.length ? ' disabled' : ''}>&times;</button>
  </div>`;
}

function renderRoles() {
  const s = store.state.settings;
  const options = s.models
    .map((m) => `<option value="${escapeAttr(m.id)}">${escapeAttr(m.id)}</option>`)
    .join('');
  for (const [key] of MODEL_ROLES) {
    const sel = $(ROLE_FIELD[key]);
    if (sel.innerHTML !== options) sel.innerHTML = options;
    sel.value = s[key];
  }
  $('roles-hint').textContent =
    `${plural(MODEL_ROLES.length, 'job')} across ${plural(new Set(MODEL_ROLES.map(([k]) => s[k])).size, 'model')}`;

  /* Which models are doing more than one job, said plainly: it is the point of
     the catalogue, and the one thing three dropdowns on their own hide. */
  const shared = s.models
    .map((m) => [m, rolesUsing(s, m.id)])
    .filter(([, jobs]) => jobs.length > 1)
    .map(([m, jobs]) => `${sentenceList(jobs).toLowerCase()} both run on ${m.id}, out of its one allowance`);

  const el = $('roles-status');
  if (!/tts|speech|audio/i.test(s.ttsModel)) {
    /* A guess, and said as one — but the wrong model here is the expensive
       mistake to make quietly: only the TTS models return audio at all. */
    el.textContent = `${s.ttsModel} does not look like a speech model. Only Google's TTS models return audio, so the dictation tab would get a text reply it cannot play.`;
    el.className = 'status is-warn';
    return;
  }
  el.textContent = shared.length
    ? `${capitalise(shared.join('; '))}.`
    : 'Every job is on a model of its own, so none of them can spend another’s budget.';
  el.className = 'status is-ok';
}

function describeLimits(model) {
  const per = (n, unit) => (n ? `${n} per ${unit}` : `unlimited per ${unit}`);
  return `${model.id}: ${per(model.rpm, 'minute')}, ${per(model.rpd, 'day')}.`;
}

function setModelStatus(text, cls) {
  const el = $('models-status');
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

/* "Text", "Text and Speech", "Text, Speech and Shadowing". */
function sentenceList(items) {
  if (items.length <= 1) return items[0] || '';
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

function capitalise(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/* ── budget ──────────────────────────────────────────────────────────── */

/* One line per model, not per job: two jobs on one model run one counter
   down together, and a budget page that showed them apart would be showing
   the same calls twice. Redrawn every second, so it is written into a string
   first and only touched when something in it actually moved. */
let drawnUsage = '';

function renderQuota() {
  const s = store.state.settings;
  const q = store.quotaReport();

  const html = s.models.map((m) => {
    const u = store.limiter.usage(m.id, m.rpm, m.rpd);
    const jobs = rolesUsing(s, m.id);
    const bits = [
      `<span class="usage-num">${u.usedDay}/${u.rpd || '∞'} today</span>`,
      `<span class="usage-num">${u.usedMinute}/${u.rpm || '∞'} this minute</span>`,
    ];
    if (u.retryAfter > 0) bits.push(`<span class="usage-num">free in ${formatWait(u.retryAfter)}</span>`);
    return `<div class="usage-row${u.retryAfter > 0 ? ' is-blocked' : ''}">`
      + `<span class="usage-id">${escapeAttr(m.id)}`
      + `<span class="usage-jobs"> ${jobs.length ? ' · ' + jobs.join(' · ') : ' · idle'}</span></span>`
      + bits.join('')
      + '</div>';
  }).join('');

  if (html !== drawnUsage) {
    $('quota-usage').innerHTML = html;
    drawnUsage = html;
  }

  /* The two things the budget is actually asked: how many more dictation
     cards, and how many more shadowing sets. A card costs a text call and a
     speech call; a set costs one shadowing call however many lines it holds. */
  const parts = [
    q.cardsLeftToday === null
      ? 'new cards unlimited'
      : `${plural(q.cardsLeftToday, 'new card')} left today`,
    q.shadow.leftDay === null
      ? 'shadowing sets unlimited'
      : `${plural(q.shadow.leftDay, 'shadowing set')} left today`,
  ];
  if (q.retryAfter > 0) parts.push(`new cards blocked for ${formatWait(q.retryAfter)}`);

  const el = $('quota-status');
  el.textContent = parts.join('  ·  ');
  el.className = 'status ' + (q.retryAfter > 0 ? 'is-bad' : 'is-ok');
  $('quota-hint').textContent = q.cardsLeftToday === null
    ? 'unlimited'
    : `${plural(q.cardsLeftToday, 'new card')} left`;
}

/* ── the read-aloud voice ────────────────────────────────────────────── */

/* The browser's own voices, used by the Typing tab. Nothing here touches
   Gemini or the API budget — see speech.js. */
function wireSpeech() {
  $('set-speech-voice').addEventListener('change', (e) => {
    store.saveSettings({ speechVoice: e.target.value });
  });
  const rate = $('set-speech-rate');
  Object.assign(rate, { min: speech.RATE.min, max: speech.RATE.max, step: speech.RATE.step });
  /* The label follows the thumb; the setting is saved once it is let go. */
  rate.addEventListener('input', () => { $('set-speech-rate-val').textContent = speech.rateLabel(rate.value); });
  rate.addEventListener('change', () => store.saveSettings({ speechRate: speech.clampRate(rate.value) }));
  $('speech-sample').addEventListener('click', () => {
    /* A word from the deck being learnt says more than a stock phrase. */
    const card = store.practiceCards().find((c) => c.front) || null;
    const text = card ? card.front.replace(/\([^)]*\)/g, ' ') : 'Xin chào';
    const s = store.state.settings;
    speech.speak(text, speech.languageCode(s.targetLanguage), { voice: s.speechVoice, rate: s.speechRate });
  });
  store.subscribe('settings', renderSpeech);
  speech.onVoicesChanged(renderSpeech);
  wireAzure();
  renderSpeech();
}

/* The Azure key sits in localStorage like the Gemini key; the region is a
   setting. Either changing, or the language, reloads the list of voices. */
function wireAzure() {
  const key = $('set-azure-key');
  const region = $('set-azure-region');
  key.value = azure.getKey();
  region.value = store.state.settings.azureRegion || azure.DEFAULT_REGION;
  const reload = async () => {
    const btn = $('azure-load');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>Loading';
    await speech.loadAzure(store.state.settings.azureRegion, speech.languageCode(store.state.settings.targetLanguage));
    btn.disabled = false;
    btn.textContent = 'Load voices';
  };
  key.addEventListener('change', () => { azure.setKey(key.value.trim()); reload(); });
  region.addEventListener('change', async () => {
    const r = azure.cleanRegion(region.value) || azure.DEFAULT_REGION;
    region.value = r;
    await store.saveSettings({ azureRegion: r });
    reload();
  });
  $('azure-load').addEventListener('click', reload);
  let language = store.state.settings.targetLanguage;
  store.subscribe('settings', (s) => {
    if (s.settings.targetLanguage !== language) { language = s.settings.targetLanguage; reload(); }
  });
  if (azure.getKey()) reload();
}

function renderSpeech() {
  const s = store.state.settings;
  const code = speech.languageCode(s.targetLanguage);
  const list = speech.voicesFor(code);
  const sel = $('set-speech-voice');
  const chosen = s.speechVoice || '';
  const cloud = speech.azureStatus().voices.map((v) => speech.AZURE_PREFIX + v.name);
  const missing = chosen && !list.some((v) => v.name === chosen) && !cloud.includes(chosen);
  const any = speech.canSpeak(code);
  sel.innerHTML = speech.voiceOptions(code, chosen);
  sel.value = chosen;
  sel.disabled = !any;
  $('speech-sample').disabled = !any;
  const rate = $('set-speech-rate');
  if (document.activeElement !== rate) rate.value = speech.clampRate(s.speechRate);
  $('set-speech-rate-val').textContent = speech.rateLabel(rate.value);
  rate.disabled = !any;

  const el = $('speech-status');
  if (!code) {
    el.textContent = `"${s.targetLanguage}" is not a language name this app knows a code for — try its English name, or a code such as "vi".`;
    el.className = 'status is-warn';
  } else if (!list.length && !any) {
    el.textContent = `No ${s.targetLanguage} voice is installed on this device, so nothing is read aloud.`;
    el.className = 'status is-warn';
  } else if (!list.length) {
    el.textContent = `No ${s.targetLanguage} voice on this device.`;
    el.className = 'status is-warn';
  } else if (missing) {
    el.textContent = chosen.startsWith(speech.AZURE_PREFIX)
      ? (speech.azureStatus().key
        ? `${chosen.slice(speech.AZURE_PREFIX.length)} cannot be reached right now: words already saved still play in it, and new ones are read by the device voice.`
        : `${chosen.slice(speech.AZURE_PREFIX.length)} is an Azure voice and needs your key, so the device voice reads instead.`)
      : `"${chosen}" is not installed on this device, so ${list[0] ? list[0].name : 'the best available'} is used instead.`;
    el.className = 'status is-warn';
  } else {
    el.textContent = `${list.length} ${s.targetLanguage} voice${list.length === 1 ? '' : 's'} installed.`;
    el.className = 'status is-ok';
  }

  /* What Azure is doing, after what the device has. */
  const az = speech.azureStatus();
  if (az.key && az.problem) {
    el.textContent += `  ·  ${az.problem}`;
    el.className = 'status is-warn';
  } else if (az.key && az.voices.length) {
    el.textContent += `  ·  Azure: ${az.voices.length} ${s.targetLanguage} voice${az.voices.length === 1 ? '' : 's'} (${az.voices.map((v) => v.label).join(', ')}) · ${az.saved} word${az.saved === 1 ? '' : 's'} saved, played without calling Azure again.`;
  } else if (az.key && az.code) {
    el.textContent += `  ·  Azure has no ${s.targetLanguage} voice.`;
  }
}

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/* ── shadowing ───────────────────────────────────────────────────────── */

function wireShadowing() {
  for (const [id, key] of [['set-shadow-cards', 'cards'], ['set-shadow-bank', 'bank']]) {
    $(id).addEventListener('change', (e) => {
      /* Both off is a legal state here, unlike the voices or the ticked decks:
         "draw from nothing" has an honest answer — there is nothing to
         practise — and the tab says exactly that rather than quietly drawing
         from a source nobody asked for. */
      store.saveSettings({
        shadowSources: { ...store.state.settings.shadowSources, [key]: e.target.checked },
      });
    });
  }

  $('shadow-wipe').addEventListener('click', async () => {
    const rows = store.state.shadowSessions || [];
    if (!rows.length) {
      setShadowStatus('There are no recordings to delete.', 'is-warn');
      return;
    }
    const btn = $('shadow-wipe');
    btn.disabled = true;
    const n = await store.deleteAllSessions();
    btn.disabled = false;
    setShadowStatus(`Deleted ${plural(n, 'set')} and every recording in them. The sentence bank is untouched.`, 'is-ok');
  });

  wireRules();
  store.subscribe('shadow', renderShadowing);
}

/* The listening rules of the language being practised. The box saves on
   blur, like the prompts; a box left exactly as it was makes no new version,
   so tabbing through it costs nothing. */
function wireRules() {
  const box = $('set-rules');
  box.addEventListener('change', async () => {
    const next = await store.editRulesText(box.value);
    if (next) setShadowStatus(`Saved as version ${next.generation}. Lines you wrote or changed are kept word for word through every revision.`, 'is-ok');
  });

  $('rules-undo').addEventListener('click', async () => {
    const back = await store.undoRules();
    setShadowStatus(back ? back.reason : 'There is no earlier version to go back to.', back ? 'is-ok' : 'is-warn');
  });

  $('rules-draft').addEventListener('click', async () => {
    if (!storage.getApiKey()) {
      setShadowStatus('Drafting rules needs an API key. Paste one above, or write the rules yourself.', 'is-warn');
      return;
    }
    const btn = $('rules-draft');
    btn.disabled = true;
    setShadowStatus(`Drafting listening rules for ${store.state.settings.targetLanguage}…`, '');
    try {
      const entry = await store.redraftRules();
      setShadowStatus(`Drafted version ${entry.generation}. Undo brings the previous rules back.`, 'is-ok');
    } catch (e) {
      setShadowStatus(describe(e), 'is-bad');
    } finally {
      btn.disabled = false;
    }
  });

  $('rules-clear').addEventListener('click', async () => {
    if (!store.currentRules()) return;
    await store.clearRules();
    setShadowStatus(`Cleared. The next set you hand in in ${store.state.settings.targetLanguage} drafts new rules first.`, 'is-ok');
  });
}

function renderRules() {
  const s = store.state.settings;
  const entry = store.currentRules();
  const box = $('set-rules');
  $('rules-label').textContent = `Listening rules for ${s.targetLanguage}`;
  if (document.activeElement !== box) box.value = entry ? rulesToText(entry.rules) : '';
  $('rules-undo').disabled = !(entry && entry.history && entry.history.length);
  $('rules-clear').disabled = !entry;
  $('rules-draft').textContent = entry ? 'Draft rules again' : 'Draft rules';

  if (!entry) {
    $('rules-meta').textContent = `No rules for ${s.targetLanguage} yet.`;
    return;
  }
  const counts = store.rulesRatings(entry.generation);
  const rated = totalOf(counts);
  const bits = [`Version ${entry.generation}`];
  if (entry.revisedAt) bits.push(`since ${entry.revisedAt.slice(0, 10)}`);
  bits.push(rated
    ? `notes rated so far: ${RATINGS.filter(([k]) => counts[k]).map(([k, label]) => `${counts[k]} ${label.toLowerCase()}`).join(', ')}`
    : 'no notes rated under it yet');
  const verb = { add: 'Added', edit: 'Reworded', drop: 'Dropped' };
  const changes = (entry.changes || []).filter((c) => c.why)
    .map((c) => `${verb[c.kind]}${c.id ? ` rule ${c.id}` : ''}: ${c.why.replace(/\.$/, '')}`);
  $('rules-meta').textContent = bits.join(' · ')
    + (entry.reason ? `. ${entry.reason.replace(/\.$/, '')}.` : '.')
    + (changes.length ? ` What changed: ${changes.join('; ')}.` : '');
}

function renderShadowing() {
  const s = store.state.settings;
  const src = s.shadowSources || {};
  $('set-shadow-cards').checked = !!src.cards;
  $('set-shadow-bank').checked = !!src.bank;

  const on = [src.cards && 'flashcards', src.bank && 'the sentence bank'].filter(Boolean);
  $('shadow-hint').textContent = on.length ? on.join(' and ') : 'no source ticked';

  renderRules();

  const rows = store.state.shadowSessions || [];
  const takes = rows.reduce((sum, r) => sum + (r.recorded || 0), 0);
  $('shadow-wipe').disabled = !rows.length;
  setShadowStatus(rows.length
    ? `${plural(rows.length, 'set')} kept, ${plural(takes, 'recording')} in all.`
    : 'No sets recorded yet.', rows.length ? 'is-ok' : '');
}

function setShadowStatus(text, cls) {
  const el = $('shadow-status');
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

/* ── the dictation voices ────────────────────────────────────────────── */

function wireVoices() {
  $('voice-grid').addEventListener('change', (e) => {
    const box = e.target.closest('input[type=checkbox]');
    if (!box) return;
    const on = new Set(store.state.settings.voices);
    if (box.checked) on.add(box.value);
    else {
      /* Something has to read the sentence out. */
      if (on.size <= 1) { box.checked = true; return; }
      on.delete(box.value);
    }
    store.saveSettings({ voices: [...on] });
  });

  $('voice-all').addEventListener('click', () => store.saveSettings({ voices: VOICES.map(([n]) => n) }));
  $('voice-none').addEventListener('click', () => store.saveSettings({ voices: [store.state.settings.fallbackVoice] }));
}

function renderVoices() {
  const on = new Set(store.state.settings.voices);
  const grid = $('voice-grid');
  if (!grid.childElementCount) {
    grid.innerHTML = VOICES.map(([name, style]) =>
      `<label class="voice"><input type="checkbox" value="${name}"><span>${name}</span><em>${style}</em></label>`).join('');
  }
  for (const box of grid.querySelectorAll('input')) box.checked = on.has(box.value);
  $('voice-hint').textContent = on.size === 1
    ? `only ${[...on][0]} — every sentence sounds the same`
    : `${on.size} of ${VOICES.length} in rotation`;
}
