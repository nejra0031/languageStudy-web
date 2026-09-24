/* Shadowing: hear a line, say it back, and be told how it came out.

   Ten lines are drawn from the two things this app already has — your
   flashcards and the sentence bank the Dictation tab fills. Each line can be
   played, recorded over as many times as you like, and re-recorded until it
   sounds right. Nothing is sent anywhere until you press Submit, and then one
   call carries every recording you made, paired with the text it was supposed
   to be, and comes back with a note on each.

   Three things this tab does not do, all of them on purpose:

     It never scores you. A number out of ten for how native someone sounded is
     false precision, and reads as a verdict on the person rather than on one
     sound. The feedback is prose or it is nothing.

     It never asks you to confirm a take. Pressing Record again obviously
     replaces what is there, hearing yourself and going again IS the exercise,
     and nothing is graded until the set is handed in.

     It generates no sentences. The only thing in this app that writes a new
     sentence is the Dictation tab's New sentence button — and because both
     tabs share one bank, anything written there is here the moment it exists.

   The one honest difference from the feature this was ported from: that one
   had a server, so a student could close the page and come back to the
   feedback. This page has no server. The request lives in this tab, and the
   copy says so rather than promising something it cannot do. Your recordings
   are on disk before the call is made either way. */

import * as store from './store.js';
import * as storage from './storage.js';
import { isDictatable, inScope } from './deck.js';
import { escapeHtml } from './text.js';
import { formatWait, QuotaError } from './gemini.js';
import { createRecorder, SUPPORTED as CAN_RECORD } from './recorder.js';
import { buildSet, nextSessionId, takePath, focusFor } from './shadowing.js';
import { RATINGS, totalOf, languageKey } from './shadow-rules.js';
import { describe } from './tab-settings.js';
import * as speech from './speech.js';

const $ = (id) => document.getElementById(id);

let scope = 'all';
let session = null;
/* index -> { url, mime }. The take just made, so playback is instant and does
   not go back to disk for something that is already in hand. */
const takes = new Map();
/* Every object URL this tab has minted, so none of them leaks. A page left
   open through ten re-recorded lines would otherwise hold every discarded
   take for as long as the tab lives. */
const urls = new Set();
let recordingIndex = null;
let busy = false;
let inFlight = false;
let micDenied = false;
let player = null;
let ticker = null;
/* What the waiting box says while a set is out: drafting or revising the
   listening rules comes first when either is due, then the grading itself. */
let phase = '';
/* Said once under the feedback when a set had to be graded without rules. */
let rulesNote = '';
/* The last thing that happened to the listening rules, shown until
   dismissed: { entry } for a revision, { note } or { error } otherwise. */
let rulesNews = null;

const recorder = createRecorder({ onChange: (s) => { micDenied = s.micDenied; } });

/* ── boot ────────────────────────────────────────────────────────────── */

export function init() {
  $('sh-scope').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn) return;
    scope = btn.dataset.scope;
    setSeg('sh-scope', 'scope', scope);
    store.saveSettings({ shadowScope: scope });
    renderPool();
  });

  $('sh-new').addEventListener('click', newSet);
  $('sh-submit').addEventListener('click', submit);
  $('sh-mic-test').addEventListener('click', micTest);

  $('sh-lines').addEventListener('click', (e) => {
    const rate = e.target.closest('button[data-rate]');
    if (rate) {
      rateLine(Number(rate.closest('[data-index]').dataset.index), rate.dataset.rate);
      return;
    }
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const index = Number(btn.closest('[data-index]').dataset.index);
    if (btn.dataset.act === 'model') playModel(index);
    else if (btn.dataset.act === 'mine') playMine(index);
    else if (btn.dataset.act === 'rec') toggleRecord(index);
  });

  /* What the note missed, in your words. Saved on change, so a half-typed
     reason is never sent — and it is the only thing a revision hears from
     you beyond the rating itself. */
  $('sh-lines').addEventListener('change', (e) => {
    const input = e.target.closest('input[data-why]');
    if (!input || !session) return;
    store.setNoteWhy(session, Number(input.closest('[data-index]').dataset.index), input.value);
  });

  $('sh-feedback').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="retry"]')) submit();
  });

  $('sh-rules').addEventListener('click', async (e) => {
    if (e.target.closest('[data-act="rules-undo"]')) {
      const back = await store.undoRules();
      rulesNews = back ? { note: `${back.reason} That is version ${back.generation} now.` } : null;
      renderRulesNews();
    } else if (e.target.closest('[data-act="rules-dismiss"]')) {
      rulesNews = null;
      renderRulesNews();
    }
  });

  $('sh-history').addEventListener('click', async (e) => {
    const row = e.target.closest('[data-session]');
    if (!row) return;
    const id = row.dataset.session;
    if (e.target.closest('[data-act="delete"]')) {
      await store.deleteSession(id);
      if (session && session.id === id) { session = null; clearTakes(); }
      render();
      return;
    }
    if (e.target.closest('[data-act="open"]')) await openSession(id);
  });

  scope = store.state.settings.shadowScope || 'all';
  setSeg('sh-scope', 'scope', scope);

  store.subscribe('deck', renderPool);
  store.subscribe('bank', renderPool);
  store.subscribe('shadow', renderHistory);
  store.subscribe('folder', () => { gate(); render(); });
  store.subscribe('settings', renderQuota);
  ticker = setInterval(renderQuota, 1000);
  gate();
}

export function onShow() {
  gate();
  render();
}

/* Leaving the tab must close the microphone. Everything else can wait, but a
   stream left open keeps the browser's recording indicator lit, and something
   really would still be listening. */
export function onHide() {
  if (recordingIndex !== null) {
    recorder.dispose();
    recordingIndex = null;
  }
  stopPlayer();
  speech.stop();
}

function isActive() {
  return !$('panel-shadowing').hidden;
}

function setSeg(id, key, value) {
  for (const b of $(id).querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset[key] === value));
  }
}

/* ── the pool ────────────────────────────────────────────────────────── */

function cardPool() {
  return store.practiceCards().filter((c) => isDictatable(c) && inScope(c, scope));
}

function bankPool() {
  return store.state.manifest.filter(store.bankInScope);
}

function sources() {
  return store.state.settings.shadowSources || { cards: true, bank: true };
}

function renderPool() {
  const src = sources();
  const cards = src.cards ? cardPool().length : 0;
  const bank = src.bank ? bankPool().length : 0;
  const slips = store.practiceCards().filter((c) => c.accent_slip && isDictatable(c)).length;
  const el = $('sh-scope').querySelector('[data-scope="accents"]');
  if (el) el.textContent = slips ? `Accents (${slips})` : 'Accents';

  const decks = store.practiceDecks();
  $('sh-pool').textContent = [
    `${bank + cards} lines available`,
    `${bank} banked · ${cards} cards`,
    decks.length === 1 ? `deck ${decks[0]}` : `${decks.length} decks ticked`,
  ].join(' · ');
  $('sh-new').disabled = busy || (bank + cards) === 0;
}

function renderQuota() {
  if (!isActive() && !ticker) return;
  const el = $('sh-quota');
  if (!el) return;
  const q = store.quotaReport().shadow;
  if (q.retryAfter > 0) {
    el.textContent = `waiting ${formatWait(q.retryAfter)} · ${q.usedDay}/${q.rpd || '∞'} in 24h`;
    el.className = 'quota is-bad';
  } else {
    const left = q.leftDay;
    el.textContent = (left === null ? 'unlimited' : `${left} set${left === 1 ? '' : 's'} left`)
      + ` · ${q.usedDay}/${q.rpd || '∞'} in 24h`;
    el.className = 'quota ' + (left !== null && left <= 1 ? 'is-bad' : 'is-ok');
  }
  syncSubmit();
}

/* The one place that decides whether the set can be handed in, because two
   different things change the answer — recording a line, and the budget
   ticking over — and they arrive from different directions. Recording is free
   and never blocked; only the handing in costs anything. */
function syncSubmit() {
  const el = $('sh-submit');
  if (!el || !session) { if (el) el.hidden = true; return; }
  const recorded = session.items.filter((i) => i.file).length;
  const total = session.items.length;
  const waiting = store.quotaReport().shadow.retryAfter > 0;

  el.hidden = false;
  el.disabled = busy || !recorded || waiting;
  el.textContent = session.status === 'done'
    ? 'Ask again with these takes'
    : !recorded ? 'Hand in'
      : `Hand in ${recorded === total ? `all ${total}` : `these ${recorded}`}`;
  /* The quota line beside it already says how long, so the button does not
     need to count down as well. */
  el.title = waiting ? 'The shadowing budget is spent for the moment.' : '';
}

/* ── gating ──────────────────────────────────────────────────────────── */

function gate() {
  const el = $('sh-gate');
  const bits = [];

  if (!CAN_RECORD) {
    el.innerHTML = `<div class="gate">
      <h3>This browser cannot record audio</h3>
      <p>Shadowing needs a microphone, which this browser does not offer to a page. A current Chrome, Edge, Firefox or Safari will all do it. Everything else in the app still works here.</p>
      </div>`;
    $('sh-stage').hidden = true;
    return;
  }

  /* Deliberately not gated on a key. With material in the bank you can record,
     listen back and re-record all you like — the key buys the feedback, not
     the practice, exactly as replaying a banked sentence is free in Dictation. */
  if (!storage.getApiKey()) {
    bits.push(`<div class="banner is-warn">No API key, so a set cannot be handed in for feedback — but recording and listening back to yourself works without one. Paste a key into Settings when you want the feedback.</div>`);
  }
  if (!store.state.persistent) {
    bits.push(`<div class="banner is-warn">Nothing is being saved — recordings you make now are gone on reload, and past sets cannot be kept. See Settings for what this browser can keep.</div>`);
  }
  el.innerHTML = bits.join('');
  $('sh-stage').hidden = false;
  renderQuota();
}

/* ── building a set ──────────────────────────────────────────────────── */

async function newSet() {
  if (busy) return;
  const src = sources();
  if (!src.cards && !src.bank) {
    showError('Both sources are unticked in Settings, so there is nothing to draw a set from. Tick your flashcards, the sentence bank, or both.');
    return;
  }

  const items = buildSet({
    cards: src.cards ? cardPool() : [],
    bank: src.bank ? bankPool() : [],
    count: store.state.settings.shadowItems || 10,
    sources: src,
    deckOf: store.deckOf,
  });

  if (!items.length) {
    idle(bankPool().length || cardPool().length
      ? 'Nothing in the ticked sources matches this filter. Widen it, or tick another deck in the Flashcards tab.'
      : 'Nothing to shadow yet for the decks you have ticked. Add some cards in the Flashcards tab, or write a sentence on the Dictation tab — it will be here the moment it is made.');
    return;
  }

  /* The ratings given to the last set are the ones most likely to make a
     revision due, and between sets nobody is waiting on anything, so it runs
     here in the background and says so when it lands. */
  reviseRules();

  clearTakes();
  const s = store.state.settings;
  session = {
    id: nextSessionId(store.state.shadowSessions),
    created: new Date().toISOString().slice(0, 10),
    language: s.targetLanguage,
    level: s.learnerLevel,
    scope,
    status: 'recording',
    attempts: 0,
    error: null,
    items,
    feedback: null,
    failed: false,
  };
  showError('');
  await store.saveSession(session);
  render();
}

async function openSession(id) {
  const loaded = await store.loadSession(id);
  if (!loaded) { showError('That set could not be read back from the folder.'); return; }
  clearTakes();
  session = loaded;
  scope = loaded.scope || scope;
  setSeg('sh-scope', 'scope', scope);
  showError('');
  render();
  $('sh-lines').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/* ── recording ───────────────────────────────────────────────────────── */

async function toggleRecord(index) {
  if (busy) return;
  if (recordingIndex === index) { await finishRecording(); return; }
  /* Recording another line while one is open replaces nothing and loses
     nothing: the open one is kept first, then the new one starts. */
  if (recordingIndex !== null) await finishRecording();

  stopPlayer();
  speech.stop();
  const ok = await recorder.start();
  if (!ok) {
    showError(micDenied
      ? 'The microphone is blocked for this page. Allow it in your browser’s address bar, then try again.'
      : 'The microphone could not be started. Check that this site is allowed to use it, and that something is plugged in.');
    render();
    return;
  }
  showError('');
  recordingIndex = index;
  render();
}

async function finishRecording() {
  const index = recordingIndex;
  recordingIndex = null;
  const blob = await recorder.stop();
  if (!blob || !blob.size) {
    showError('Nothing was recorded. Try again, and give it a moment before you speak.');
    render();
    return;
  }

  const item = session.items[index];
  /* Stopping is keeping: the take is saved the moment it exists, with no
     "do you want this one?" step in between. */
  const previous = item.file;
  const path = takePath(session.id, index, blob.type);
  if (store.state.persistent) {
    const written = await storage.writeBlob(path, blob);
    if (!written) {
      showError('That recording could not be saved. Record the line again.');
      render();
      return;
    }
    /* A different browser session can produce a different container, which
       means a different filename — the old one would otherwise sit there
       orphaned and ride along in every backup. */
    if (previous && previous !== path) await storage.remove(previous);
    item.file = path;
  } else {
    item.file = path;      // nominal: nothing is on disk, but the set knows it has a take
  }
  item.mime = blob.type || 'audio/webm';

  const old = takes.get(index);
  if (old) revoke(old.url);
  takes.set(index, { url: mintUrl(blob), mime: item.mime, blob });

  /* A set that was graded and is now being re-recorded is a new attempt: the
     old feedback described takes that no longer exist. */
  if (session.status === 'done' || session.status === 'error') {
    session.status = 'recording';
    session.feedback = null;
    session.failed = false;
    session.error = null;
  }
  await store.saveSession(session);
  render();
}

async function micTest() {
  if (busy || recordingIndex !== null) return;
  const btn = $('sh-mic-test');
  const ok = await recorder.start();
  if (!ok) {
    showError(micDenied
      ? 'The microphone is blocked for this page. Allow it in your browser’s address bar, then try again.'
      : 'The microphone could not be started. Check that this site is allowed to use it.');
    return;
  }
  showError('');
  btn.innerHTML = '<span class="spinner"></span>Listening… say anything';
  btn.disabled = true;
  await new Promise((r) => setTimeout(r, 5000));
  const blob = await recorder.stop();
  btn.disabled = false;
  btn.textContent = 'Test the microphone';
  if (!blob || !blob.size) {
    showError('The microphone test captured nothing. Check that the right input is selected in your system settings.');
    return;
  }
  /* Never saved and never uploaded — replaced on every test, revoked when it
     has been heard. */
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.onended = () => URL.revokeObjectURL(url);
  audio.play().catch(() => URL.revokeObjectURL(url));
  showError('');
  $('sh-mic-note').textContent = 'That is what the microphone hears. It was not saved and not uploaded.';
}

/* ── playback ────────────────────────────────────────────────────────── */

function stopPlayer() {
  if (player) { player.pause(); player = null; }
}

function mintUrl(blob) {
  const url = URL.createObjectURL(blob);
  urls.add(url);
  return url;
}

function revoke(url) {
  if (!url) return;
  urls.delete(url);
  URL.revokeObjectURL(url);
}

function clearTakes() {
  for (const url of urls) URL.revokeObjectURL(url);
  urls.clear();
  takes.clear();
}

async function playModel(index) {
  const item = session && session.items[index];
  if (!item) return;
  stopPlayer();
  speech.stop();
  if (recordingIndex !== null) return;    // never play into an open microphone

  if (item.source === 'bank' && item.audio) {
    const url = await storage.readBlobUrl(item.audio);
    if (!url) { showError('The recording for this line is missing from the sentence bank.'); return; }
    urls.add(url);
    player = new Audio(url);
    player.play().catch(() => {});
    return;
  }
  /* A flashcard has no recording — the device's own voice reads it, free and
     offline, the same voice the Typing tab uses. */
  const s = store.state.settings;
  speech.speak(item.text, speech.languageCode(session.language || s.targetLanguage), { voice: s.speechVoice, rate: s.speechRate });
}

async function playMine(index) {
  const item = session && session.items[index];
  if (!item || !item.file) return;
  stopPlayer();
  speech.stop();
  if (recordingIndex !== null) return;

  const held = takes.get(index);
  const url = held ? held.url : await storage.readBlobUrl(item.file);
  if (!url) { showError('That recording could not be read back.'); return; }
  if (!held) urls.add(url);
  player = new Audio(url);
  player.play().catch(() => {});
}

/* ── handing it in ───────────────────────────────────────────────────── */

async function submit() {
  if (busy || !session) return;
  if (recordingIndex !== null) await finishRecording();

  const recorded = session.items.filter((i) => i.file);
  if (!recorded.length) return;
  if (!storage.getApiKey()) {
    showError('No API key. Paste your Gemini key into Settings to get feedback — your recordings are saved either way.');
    return;
  }
  try {
    store.client.shadowPreflight();
  } catch (e) {
    showError(describe(e));
    return;
  }

  busy = true;
  inFlight = true;
  showError('');
  session.status = 'grading';
  await store.saveSession(session);
  render();

  try {
    await prepareRules();
    phase = '';
    renderFeedback();

    const clips = [];
    for (const item of recorded) {
      const bytes = await bytesFor(item);
      if (bytes && bytes.length) clips.push({ itemIndex: item.index, mime: item.mime, bytes });
    }
    if (!clips.length) throw new Error('None of the recordings in this set could be read back.');

    const graded = await store.client.gradeShadowing({
      items: session.items,
      clips,
      focus: focusFor(scope, session.language, session.items),
      itemCount: session.items.length,
    });

    session.feedback = graded;
    session.status = 'done';
    session.failed = false;
    session.error = null;
    session.graded_at = new Date().toISOString();

    /* The bank entries this set used have now been read in full, which is what
       stops Dictation offering them as a blind dictation. */
    const used = session.items
      .filter((i) => i.source === 'bank' && i.bankId)
      .map((i) => store.state.manifest.find((e) => e.id === i.bankId))
      .filter(Boolean);
    if (used.length) await store.markShadowed(used);
  } catch (e) {
    console.error(e);
    session.attempts = (session.attempts || 0) + 1;
    session.error = describe(e);
    session.status = 'error';
    session.failed = true;
    if (e instanceof QuotaError) showError(describe(e));
  } finally {
    busy = false;
    inFlight = false;
    phase = '';
    await store.saveSession(session);
    render();
    renderQuota();
  }
}

/* ── the listening rules ─────────────────────────────────────────────── */

/* Before a set goes up, a language with no rules gets them drafted, and one
   whose rules are due a revision gets it, so the set is graded by the best
   rules there are. Neither can stop the grading: if either fails, the set is
   graded with whatever there is, and a line under the feedback says so. */
async function prepareRules() {
  rulesNote = '';
  const language = store.state.settings.targetLanguage;
  if (store.currentRules()) {
    await reviseRules({ waiting: true });
    return;
  }
  phase = `Drafting listening rules for ${language} first. This happens once per language…`;
  renderFeedback();
  try {
    await store.ensureRules();
  } catch (e) {
    console.error(e);
    rulesNote = `No listening rules could be drafted for ${language}, so this set was graded without them. ${describe(e)}`;
  }
}

/* Revises the rules if your ratings say it is due, and does nothing (no
   call, no message) when they do not. Running out of text-model budget is
   not worth a message either: the revision is still due, and is tried again
   at the next set. */
async function reviseRules({ waiting = false } = {}) {
  const s = store.state.settings;
  if (waiting && store.shouldReviseRules()) {
    phase = `Revising the ${s.targetLanguage} listening rules from your ratings first…`;
    renderFeedback();
  }
  try {
    const next = await store.reviseRulesIfDue(session);
    if (next) rulesNews = { entry: next };
  } catch (e) {
    console.error(e);
    if (!(e instanceof QuotaError)) {
      rulesNews = { error: `The listening rules could not be revised this time, and were left as they were. ${describe(e)}` };
    }
  }
  renderRulesNews();
}

async function rateLine(index, rating) {
  if (!session || !session.feedback) return;
  await store.rateNote(session, index, rating);
  renderLines();
  renderFeedback();
  /* A rating that is not "useful" is most use with a reason, so the box for
     one is where the cursor goes — typing nothing is fine. */
  const why = $('sh-lines').querySelector(`[data-index="${index}"] input[data-why]`);
  if (why && !why.value) why.focus();
}

function renderRulesNews() {
  const el = $('sh-rules');
  const news = rulesNews;
  if (!news) { el.innerHTML = ''; return; }
  const dismiss = '<button class="btn btn--sm" data-act="rules-dismiss">OK</button>';
  if (news.error || news.note) {
    el.innerHTML = `<div class="banner${news.error ? ' is-warn' : ''} sh-news">
      <span>${escapeHtml(news.error || news.note)}</span><div class="row">${dismiss}</div></div>`;
    return;
  }
  const entry = news.entry;
  const tally = { add: 0, edit: 0, drop: 0 };
  for (const c of entry.changes || []) tally[c.kind]++;
  const summary = [
    tally.add && `${tally.add} added`,
    tally.edit && `${tally.edit} reworded`,
    tally.drop && `${tally.drop} dropped`,
  ].filter(Boolean).join(', ');
  const verb = { add: 'Added', edit: 'Reworded', drop: 'Dropped' };
  const whys = (entry.changes || []).filter((c) => c.why)
    .map((c) => `<li>${escapeHtml(`${verb[c.kind]}${c.id ? ` rule ${c.id}` : ''}: ${c.why}`)}</li>`);
  el.innerHTML = `<div class="banner sh-news">
    <div>
      <strong>Your ratings revised the ${escapeHtml(store.state.settings.targetLanguage)} listening rules. They are version ${entry.generation} now${summary ? `: ${summary}` : ''}.</strong>
      ${entry.reason ? `<p class="note">${escapeHtml(entry.reason)}</p>` : ''}
      ${whys.length ? `<details><summary>What changed</summary><ul>${whys.join('')}</ul></details>` : ''}
      <p class="note">You can read and edit the rules in Settings → Shadowing.</p>
    </div>
    <div class="row"><button class="btn btn--sm" data-act="rules-undo">Undo</button>${dismiss}</div>
    </div>`;
}

async function bytesFor(item) {
  const held = takes.get(item.index);
  const blob = held ? held.blob : await storage.readBlob(item.file);
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/* ── rendering ───────────────────────────────────────────────────────── */

function render() {
  renderPool();
  renderQuota();
  renderHistory();
  renderRulesNews();

  if (!session) {
    $('sh-card').hidden = true;
    if ($('sh-idle').hidden) {
      idle('Draw a set and start reading. Lines come from your flashcards and from the sentence bank the Dictation tab fills — whichever you have ticked in Settings.');
    }
    return;
  }
  $('sh-idle').hidden = true;
  $('sh-card').hidden = false;
  renderLines();
  renderFeedback();

  const recorded = session.items.filter((i) => i.file).length;
  $('sh-count').textContent = `${recorded} of ${session.items.length} recorded`;
  syncSubmit();
}

/* Only a note graded under a version of the rules can be rated. A rating on
   one graded without them, or before rules existed, would count towards
   nothing, and a button that does nothing should not be there. */
function canRate() {
  const fb = session && session.feedback;
  return !!(fb && session.status === 'done' && Number.isInteger(fb.rulesGeneration) && fb.rulesGeneration > 0);
}

function ratingRow(note) {
  const buttons = RATINGS.map(([key, label]) =>
    `<button data-rate="${key}" aria-pressed="${note.rating === key}">${label}</button>`).join('');
  const why = note.rating && note.rating !== 'useful'
    ? `<input type="text" data-why maxlength="200" aria-label="What the note missed" placeholder="What did it miss? (optional)" value="${escapeHtml(note.why || '')}">`
    : '';
  return `<div class="sh-rate"><div class="seg" role="group" aria-label="How useful was this note?">${buttons}</div>${why}</div>`;
}

function renderLines() {
  const notes = new Map(((session.feedback && session.feedback.notes) || [])
    .map((n) => [n.itemIndex, n]));
  const rateable = canRate();

  $('sh-lines').innerHTML = session.items.map((item) => {
    const isRec = recordingIndex === item.index;
    const has = !!item.file;
    const note = notes.get(item.index);
    const comment = note && note.comment;
    return `<div class="sh-row${has ? ' is-done' : ''}" data-index="${item.index}">
      <div class="sh-main">
        <button class="play play--sm" data-act="model" title="${item.source === 'bank' ? 'Play the recording' : 'Read it aloud with your device’s voice'}" aria-label="Play line ${item.index + 1}">▶</button>
        <div class="sh-text">
          <div class="sh-line" lang="${escapeHtml(speech.languageCode(session.language) || '')}">${escapeHtml(item.text)}</div>
          ${item.gloss ? `<div class="sh-gloss">${escapeHtml(item.gloss)}</div>` : ''}
        </div>
        <div class="sh-acts">
          <button class="btn btn--sm${isRec ? ' btn--danger is-rec' : ''}" data-act="rec">${isRec ? '■ Stop' : (has ? '● Again' : '● Record')}</button>
          <button class="play play--sm" data-act="mine" aria-label="Play your recording of line ${item.index + 1}" ${has ? '' : 'disabled'}>▶</button>
        </div>
      </div>
      ${comment ? `<div class="sh-comment">${escapeHtml(comment)}${rateable ? ratingRow(note) : ''}</div>` : ''}
    </div>`;
  }).join('');
}

/* The waiting box and the finished feedback are the same box in the same
   place: pressing Submit draws it at once with a moving indicator, and the
   feedback replaces the animation without anything jumping. Feedback always
   sits below the lines it is about — a paragraph about work you cannot see,
   above the work itself, pushes the work off the screen. */
function renderFeedback() {
  const el = $('sh-feedback');
  const fb = session.feedback;

  if (session.status === 'grading' && inFlight) {
    const n = session.items.filter((i) => i.file).length;
    el.hidden = false;
    el.innerHTML = `<div class="notes-box sh-box">
      <div class="row"><span class="spinner"></span><strong>${phase ? escapeHtml(phase) : `Your ${n} recording${n === 1 ? ' is' : 's are'} in, and ${n === 1 ? 'is' : 'are'} being listened to now.`}</strong></div>
      <p class="note" style="margin-top:8px">This page has no server behind it, so the request lives in this tab — keep it open until the feedback lands. Your recordings are saved either way.</p>
      </div>`;
    return;
  }

  if (session.status === 'error' || (session.status === 'grading' && !inFlight)) {
    el.hidden = false;
    el.innerHTML = `<div class="notes-box sh-box">
      <strong>Automatic feedback didn’t come back for this one.</strong>
      <p class="note" style="margin-top:8px">Your recordings are saved — nothing was lost, and you can ask again.${session.error ? ` The API said: ${escapeHtml(session.error)}` : ''}</p>
      <div class="row" style="margin-top:10px"><button class="btn btn--sm btn--primary" data-act="retry">Ask for feedback again</button></div>
      </div>`;
    return;
  }

  if (!fb) { el.hidden = true; el.innerHTML = ''; return; }

  el.hidden = false;
  el.innerHTML = `<div class="notes-box sh-box">
    <strong>How you sounded</strong>
    ${fb.overall ? `<p style="margin-top:8px">${escapeHtml(fb.overall)}</p>` : ''}
    ${fb.focusNote ? `<div style="margin-top:14px"><strong>The accents you keep missing</strong><p style="margin-top:6px">${escapeHtml(fb.focusNote)}</p></div>` : ''}
    ${rulesNote ? `<p class="note" style="margin-top:12px">${escapeHtml(rulesNote)}</p>` : ''}
    ${canRate() ? `<p class="note" style="margin-top:12px">${escapeHtml(rateHint(fb.rulesGeneration))}</p>` : ''}
    <div class="sh-meta" style="margin-top:12px">${escapeHtml(fb.model || '')}${fb.attached && fb.attached < session.items.length ? ` · ${fb.attached} of ${session.items.length} lines sent` : ''}${Number.isInteger(fb.rulesGeneration) ? ` · ${fb.rulesGeneration ? `listening rules v${fb.rulesGeneration}` : 'no listening rules'}` : ''}</div>
    </div>`;
}

/* Where the ratings stand, in the terms that matter: how far this version is
   from being revised, or why it is not going to be. */
function rateHint(generation) {
  const lead = 'Rate each note: your ratings are what the listening rules are rewritten from.';
  const entry = store.currentRules();
  if (!entry || entry.generation !== generation
    || languageKey(session.language) !== languageKey(store.state.settings.targetLanguage)) {
    return `${lead} These notes were graded under an earlier version of the rules, so rating them no longer changes anything.`;
  }
  const counts = store.rulesRatings(generation);
  const rated = totalOf(counts);
  const need = store.state.settings.shadowReviseAfter;
  if (rated < need) return `${lead} ${rated} of ${need} rated under this version so far.`;
  return rated > counts.useful
    ? `${lead} That is enough: the rules are revised when you start the next set.`
    : `${lead} Every note rated under this version was useful, so there is nothing to revise.`;
}

function renderHistory() {
  const rows = store.state.shadowSessions || [];
  $('sh-history-hint').textContent = rows.length
    ? `${rows.length} set${rows.length === 1 ? '' : 's'}`
    : 'nothing yet';
  $('sh-history').innerHTML = rows.length
    ? rows.map((r) => `<div class="sh-hist" data-session="${escapeHtml(r.id)}">
        <button class="sh-hist-open" data-act="open">
          <span class="sh-hist-id">${escapeHtml(r.id)}</span>
          <span class="sh-hist-sub">${escapeHtml(r.created || '')} · ${r.recorded}/${r.itemCount} recorded · ${escapeHtml(statusWord(r.status))}${r.decks && r.decks.length ? ` · ${escapeHtml(r.decks.join(', '))}` : ''}</span>
        </button>
        <button class="btn btn--sm btn--danger" data-act="delete" title="Delete this set and its recordings">Delete</button>
      </div>`).join('')
    : `<p class="note">Sets you hand in are kept here with their recordings, so you can listen back to what the feedback is about.</p>`;
}

function statusWord(status) {
  if (status === 'done') return 'feedback in';
  if (status === 'error') return 'no feedback';
  if (status === 'grading') return 'unfinished';
  return 'in progress';
}

/* ── small helpers ───────────────────────────────────────────────────── */

function showError(text) {
  const el = $('sh-error');
  el.innerHTML = text ? `<div class="banner is-bad">${escapeHtml(text)}</div>` : '';
}

function idle(text) {
  const el = $('sh-idle');
  if (!text) { el.hidden = true; return; }
  $('sh-card').hidden = true;
  el.hidden = false;
  el.innerHTML = `<p>${escapeHtml(text)}</p>`;
}
