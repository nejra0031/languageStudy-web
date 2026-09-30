/* Writing: a piece of your own writing, graded, with your cards scored.

   Two kinds of task, both built from what you already have. A summary of
   one of your kept Reading texts, with the cards that text used as the ones
   to try to use; or an opinion piece on a question the text model writes
   around a few of your weakest cards, or on a topic you type yourself,
   which costs nothing. Either way the task says how many words it wants,
   and Hand in is live only inside that range.

   Handing in is one call on the feedback model. It comes back as feedback
   in sections, or as "this is not an attempt at the task", which is a
   verdict and scores nothing, or as something that cannot be read, which is
   a failure: the writing stays in the box and Try again sends it again.
   Nothing is retried behind your back, since every attempt is a call.

   A piece is kept from the moment its task is set, as a draft, and saved
   as it is written (autosave.js), so a question that cost a call and the
   text written to it survive a reload; the newest draft is back on screen
   when the tab is shown. Handing in completes that same record. Every
   piece is listed under the form: a draft opens to carry on with, a piece
   handed in opens as it was, and Write again starts a new piece on the same
   task. The logic that has no DOM is writing.js. */

import * as store from './store.js';
import * as storage from './storage.js';
import { isPattern, inScope, recordResult, SCORE_LABEL } from './deck.js';
import { pickReadingCards, speakableText, nextDatedId } from './reading.js';
import {
  MAX_TEXT, countWords, wordBounds, wordStatus, writingTitle, draftRecord, isDraft,
} from './writing.js';
import { createAutosave } from './autosave.js';
import { escapeHtml, scoreMark } from './text.js';
import { formatWait } from './gemini.js';
import { describe } from './tab-settings.js';
import { languageCode } from './speech.js';
import { errorSpot } from './error-spot.js';

const $ = (id) => document.getElementById(id);

let kind = 'opinion';
let scope = 'all';
/* The task being written to: {kind, brief, readingId, readingTitle,
   sourceText, sourceWords, cards}. `cards` are copies of what each card said
   when the task was set, {front, back, type, deck}; the card itself is
   looked up again when it is scored, since the deck may have changed. */
let task = null;
/* A kept piece on screen, read-only, and what scoring it did to each card,
   by the card's place in task.cards. The moves are there only right after a
   hand-in: a piece reopened from the list shows its verdicts, not moves. */
let shown = null;
let moves = null;
let saved = null;
/* The piece being written: its record, a draft until it is handed in. It
   is written to the store when its task is set and again as its text
   changes, through `saver`, which saves whichever draft was last typed
   in. */
let draft = null;
let unsaved = null;
const saver = createAutosave(() => (unsaved ? store.saveWriting(unsaved) : null));
/* A draft being read back when the tab is shown, so two showings of the
   tab do not both resume it. */
let resuming = false;
/* The task whose piece is out to be read, if one is. Only that task's box
   is locked meanwhile: a new question, topic or summary can be started, or
   a kept piece opened, and the feedback is still kept and scored when it
   comes back, and shown if its task is still the one on screen. One
   hand-in at a time. `gradingRecord` is that piece's record: opened from
   the list meanwhile, it is this object that goes on screen, locked, and
   not a copy from disk that could be typed into and saved over the
   feedback. */
let grading = null;
let gradingRecord = null;
let asking = false;
/* The row whose Delete has been pressed once, and the timer that stands it
   down again. */
let armed = null;
let disarm = 0;

export function init() {
  $('wr-kind').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-kind]');
    if (!btn || asking) return;
    kind = btn.dataset.kind;
    setSeg('wr-kind', 'kind', kind);
    renderChooser();
  });
  $('wr-scope').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn) return;
    scope = btn.dataset.scope;
    setSeg('wr-scope', 'scope', scope);
    store.saveSettings({ writingScope: scope });
    renderPool();
  });
  $('wr-ask').addEventListener('click', askForQuestion);
  $('wr-use-topic').addEventListener('click', useTopic);
  $('wr-topic').addEventListener('keydown', (e) => { if (e.key === 'Enter') useTopic(); });
  $('wr-start-summary').addEventListener('click', startSummary);
  $('wr-text').addEventListener('input', () => { renderCount(); typed(); });
  /* A page being hidden may be a page being closed: what is waiting to be
     saved is saved now. */
  document.addEventListener('visibilitychange', () => { if (document.hidden) saver.flush(); });
  $('wr-hand-in').addEventListener('click', handIn);
  $('wr-again').addEventListener('click', writeAgain);
  $('wr-error').addEventListener('click', (e) => { if (e.target.closest('[data-act="retry"]')) handIn(); });
  placeError = errorSpot($('wr-error'));
  $('wr-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-writing]');
    if (!row) return;
    const id = row.dataset.writing;
    if (e.target.closest('[data-act="delete"]')) remove(id);
    else if (e.target.closest('[data-act="open"]')) openWriting(id);
  });

  scope = store.state.settings.writingScope || 'all';
  setSeg('wr-scope', 'scope', scope);
  setSeg('wr-kind', 'kind', kind);

  store.subscribe('deck', renderPool);
  store.subscribe('reading', renderChooser);
  store.subscribe('writing', renderList);
  store.subscribe('folder', () => { gate(); renderPool(); forgetIfGone(); });
  store.subscribe('settings', (st) => {
    scope = st.settings.writingScope || 'all';
    setSeg('wr-scope', 'scope', scope);
    if (task && !shown) renderBounds();
  });
  store.subscribe('ready', () => { if (isActive()) onShow(); });
  store.subscribe('quota', renderQuota);
  setInterval(renderQuota, 1000);
  gate();
  renderChooser();
  renderList();
}

export async function onShow() {
  gate();
  renderPool();
  renderChooser();
  renderList();
  /* A piece left unfinished, by a reload or a closed tab, is back where it
     was: the newest draft, with its task and what was written. */
  if (task || resuming || !store.state.ready) return;
  const row = (store.state.writings || []).find((r) => r.ended === false);
  if (!row) return;
  resuming = true;
  try {
    const record = await store.loadWriting(row.id);
    if (record && isDraft(record) && !task) await showDraft(record, { scroll: false });
  } finally {
    resuming = false;
  }
}

/* Leaving the tab saves what was being typed. */
export function onHide() {
  saver.flush();
}

function isActive() {
  return !$('panel-writing').hidden;
}

function setSeg(id, key, value) {
  for (const b of $(id).querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset[key] === value));
  }
}

/* ── gating ──────────────────────────────────────────────────────────── */

function gate() {
  const el = $('wr-gate');
  if (!storage.getApiKey()) {
    el.innerHTML = `<div class="gate">
      <h3>Add a Gemini API key first</h3>
      <p>Feedback on your writing comes from the Gemini API, using your own key and one call from the feedback model's budget. Paste a key into the Settings tab. What you have already handed in stays readable without one.</p>
      </div>`;
    $('wr-stage').hidden = true;
    return;
  }
  el.innerHTML = !store.state.persistent
    ? '<div class="banner is-warn">Nothing is being saved — you can write and get feedback, but your writing and what it did to your cards are gone on reload. See Settings for what this browser can keep.</div>'
    : '';
  $('wr-stage').hidden = false;
  renderQuota();
}

/* ── choosing a task ─────────────────────────────────────────────────── */

function pool() {
  return store.practiceCards().filter((c) => inScope(c, scope));
}

function renderPool() {
  const cards = pool();
  const decks = store.practiceDecks();
  $('wr-pool').textContent = [
    `${cards.length} cards in scope`,
    decks.length === 1 ? `deck ${decks[0]}` : `${decks.length} decks ticked`,
  ].join(' · ');
}

function renderChooser() {
  $('wr-opinion').hidden = kind !== 'opinion';
  $('wr-summary').hidden = kind !== 'summary';
  const rows = store.state.readings || [];
  const sel = $('wr-reading');
  const html = rows.map((r) => `<option value="${escapeHtml(r.id)}">${escapeHtml(r.title || r.id)} · ${escapeHtml(r.created)}</option>`).join('');
  if (sel.dataset.drawn !== html) {
    const was = sel.value;
    sel.innerHTML = html;
    sel.dataset.drawn = html;
    if (rows.some((r) => r.id === was)) sel.value = was;
  }
  sel.disabled = !rows.length;
  $('wr-start-summary').disabled = !rows.length;
  $('wr-summary-note').textContent = rows.length
    ? 'The text is shown with the task, and the cards it used are the ones to try to use. No call is spent until you hand in.'
    : 'You have no reading texts yet. Write one on the Reading tab, then come back to summarise it.';
}

/* Cards copied as they are now, with the deck each came from. */
function copyCard(card, deck) {
  const out = { front: card.front, back: card.back || '', deck: deck || store.deckOf(card) };
  if (isPattern(card)) out.type = 'pattern';
  return out;
}

function drawCards() {
  return pickReadingCards(pool(), store.state.settings.writingTerms).map((c) => copyCard(c));
}

async function askForQuestion() {
  if (asking) return;
  const cards = drawCards();
  if (!cards.length) {
    showError(store.practiceCards().length
      ? 'No cards in this scope. Widen the filter, or tick another deck in the Flashcards tab.'
      : 'Add some cards in the Flashcards tab first, or tick a deck that has some.', false, $('wr-ask').closest('.row'));
    return;
  }
  asking = true;
  showError('');
  const btn = $('wr-ask');
  btn.innerHTML = '<span class="spinner"></span>Writing a question';
  btn.disabled = true;
  try {
    const { brief } = await store.client.writeWritingBrief(cards);
    setTask({ kind: 'opinion', brief, cards });
  } catch (e) {
    console.error(e);
    showError(describe(e), false, btn.closest('.row'));
  } finally {
    asking = false;
    btn.textContent = 'Write me a question';
    renderQuota();
  }
}

/* A topic of your own costs no call. The cards to try to use are drawn all
   the same, so the piece still practises something. */
function useTopic() {
  if (asking) return;
  const topic = $('wr-topic').value.trim();
  if (!topic) {
    showError('Type a topic first, or press Write me a question.', false, $('wr-topic').closest('.row'));
    $('wr-topic').focus();
    return;
  }
  showError('');
  setTask({ kind: 'opinion', brief: topic.slice(0, 300), cards: drawCards() });
}

async function startSummary() {
  if (asking) return;
  const id = $('wr-reading').value;
  const record = id && await store.loadReading(id);
  if (!record) {
    showError(`That text could not be read from ${storage.label()}. Its file may have been moved or deleted outside the app.`, false, $('wr-reading').closest('.row'));
    return;
  }
  showError('');
  setTask(summaryTask(record));
}

/* The cards a text used, as they were when it was written. */
function summaryTask(record) {
  const cards = (record.used || [])
    .map((i) => record.items[i])
    .filter(Boolean)
    .map((it) => {
      const out = { front: it.front, back: it.back || '', deck: it.deck || '' };
      if (it.pattern) out.type = 'pattern';
      return out;
    });
  const sourceText = speakableText(record);
  return {
    kind: 'summary',
    brief: '',
    readingId: record.id,
    readingTitle: record.title || record.id,
    sourceText,
    sourceWords: countWords(sourceText),
    cards,
  };
}

/* Whether the task on screen is the one out to be read: only then is its
   box locked. */
function busy() {
  return !!grading && grading === task;
}

/* A new task frees the box even while an earlier piece is out: that piece
   is kept and scored when its feedback comes back. */
function unlockBox() {
  $('wr-text').readOnly = false;
  $('wr-busy').hidden = true;
  $('wr-hand-in').textContent = 'Hand in';
}

function lockBox() {
  const btn = $('wr-hand-in');
  btn.innerHTML = '<span class="spinner"></span>Reading your writing';
  btn.disabled = true;
  $('wr-text').readOnly = true;
  $('wr-busy').hidden = false;
  $('wr-busy').textContent = `${store.state.settings.writingGradeModel} is reading it. This can take half a minute.`;
}

/* A task is set: a piece starts, and is kept from now, before a word of
   it is written, so a question that cost a call is not lost with the page. */
async function setTask(next, { scroll = true } = {}) {
  await leaveDraft({ replaced: true });
  unlockBox();
  const s = store.state.settings;
  task = next;
  shown = null;
  moves = null;
  saved = null;
  draft = draftRecord(next, {
    id: nextDatedId('w', store.state.writings),
    created: new Date().toISOString().slice(0, 10),
    language: s.targetLanguage,
    level: s.learnerLevel,
  });
  const mine = draft;
  $('wr-text').value = '';
  renderCard();
  if (scroll) $('wr-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
  $('wr-text').focus({ preventScroll: true });
  const kept = await store.saveWriting(mine);
  if (!kept && draft === mine) {
    showError(`This piece could not be written to ${storage.label()}. Reconnect the data folder in Settings; it will be lost on reload.`, false, $('wr-count-row'));
  }
}

/* The box changed: the draft has the text, and it is saved shortly. */
function typed() {
  if (!draft || shown || busy()) return;
  draft.text = $('wr-text').value.slice(0, MAX_TEXT);
  unsaved = draft;
  saver.touch();
}

/* The draft on screen is being left, for a new task or for another piece.
   What was typed is saved first. One that is being replaced by a new task
   and has nothing written to it is deleted: a row for every question asked
   and never answered would bury the pieces worth finding. One that is only
   being left to look at another piece stays, empty or not, to come back
   to. The piece out to be read is not touched. */
async function leaveDraft({ replaced = false } = {}) {
  const d = draft;
  draft = null;
  if (!d || d === gradingRecord) return;
  if (replaced && !String(d.text || '').trim()) {
    if (unsaved === d) { saver.cancel(); unsaved = null; }
    await store.deleteWriting(d.id);
    return;
  }
  await saver.flush();
}

/* A draft put on screen to carry on with, from the list or on resuming. */
async function showDraft(record, { scroll = true } = {}) {
  const out = record === gradingRecord;
  task = out ? grading : await taskOf(record);
  draft = record;
  shown = null;
  moves = null;
  saved = null;
  $('wr-text').value = record.text || '';
  unlockBox();
  if (out) lockBox();
  renderCard();
  renderList();
  if (task.missingSource) {
    showError('The reading text this piece summarises has since been deleted, so it cannot be handed in as a summary. Pick another text above.', false, $('wr-count-row'));
  }
  if (scroll) $('wr-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/* ── the task and the writing ────────────────────────────────────────── */

function bounds() {
  return wordBounds(store.state.settings, task.kind, task.sourceWords || 0);
}

function renderCard() {
  const card = $('wr-card');
  if (!task) { card.hidden = true; return; }
  card.hidden = false;
  const lang = languageCode(store.state.settings.targetLanguage);
  const record = shown;

  $('wr-meta').innerHTML = [
    task.kind === 'summary' ? 'Summary' : 'Opinion',
    record ? escapeHtml(record.created) : 'not handed in yet',
    record && record.model ? escapeHtml(record.model) : '',
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join('');

  const brief = $('wr-brief');
  if (task.kind === 'summary') {
    brief.textContent = `Summarise “${task.readingTitle}” in your own words.`;
    brief.removeAttribute('lang');
  } else {
    brief.textContent = task.brief;
    brief.lang = lang;
  }
  $('wr-source').hidden = task.kind !== 'summary';
  $('wr-source-text').textContent = task.sourceText || '';
  $('wr-source-text').lang = lang;

  /* Each card with its meaning in plain view, as Conversation lists them:
     a meaning in a tooltip is one a phone never shows. */
  $('wr-try').innerHTML = task.cards.length
    ? `<div class="cv-facts-head">Try to use these</div>
      <ul>${task.cards.map((c) => `<li>
        <span class="try-front" lang="${escapeHtml(lang)}">${escapeHtml(c.front)}</span>
        <span class="try-back">${c.type === 'pattern' ? 'grammar pattern · ' : ''}${escapeHtml(c.back || '')}</span>
      </li>`).join('')}</ul>`
    : '';
  $('wr-try').hidden = !task.cards.length;

  const editing = !record;
  $('wr-text').hidden = !editing;
  $('wr-text').lang = lang;
  $('wr-count-row').hidden = !editing;
  $('wr-written').hidden = editing;
  $('wr-written').lang = lang;
  if (record) $('wr-written').textContent = record.text;
  $('wr-again-row').hidden = editing;
  $('wr-result').innerHTML = record ? resultHtml(record) : '';
  renderBounds();
}

function renderBounds() {
  if (!task) return;
  const b = bounds();
  $('wr-bounds').textContent = `Write between ${b.min} and ${b.max} words.`;
  renderCount();
}

function renderCount() {
  if (!task || shown) return;
  const n = countWords($('wr-text').value);
  const st = wordStatus(n, bounds());
  const el = $('wr-count');
  let text = `${n} word${n === 1 ? '' : 's'}`;
  if (st.short) text += ` · ${st.short} more to go`;
  if (st.over) text += ` · ${st.over} over the limit`;
  el.textContent = text;
  el.className = 'wr-count' + (!st.empty && !st.ok ? ' is-bad' : st.ok ? ' is-ok' : '');
  renderHandIn();
}

function renderHandIn() {
  const btn = $('wr-hand-in');
  if (busy()) return;
  const g = store.jobUsage('writingGradeModel');
  const ok = task && !shown && !task.missingSource && wordStatus(countWords($('wr-text').value), bounds()).ok;
  btn.disabled = !ok || !!grading || g.retryAfter > 0 || !storage.getApiKey();
  /* Why a piece that is the right length cannot go in yet is said beside
     the button, not only in a tooltip, which a phone never shows. */
  const wait = $('wr-busy');
  wait.hidden = !(ok && (grading || g.retryAfter > 0));
  if (!wait.hidden) {
    wait.textContent = grading
      ? 'Your last piece is still being read. Hand this one in when its feedback is back.'
      : `${g.model} is out of budget for now: next call in ${formatWait(g.retryAfter)}.`;
  }
}

/* ── handing in ──────────────────────────────────────────────────────── */

async function handIn() {
  if (grading || !task || shown || !draft || task.missingSource) return;
  const text = $('wr-text').value.slice(0, MAX_TEXT);
  if (!wordStatus(countWords(text), bounds()).ok) return;
  const s = store.state.settings;
  const at = task;
  const record = draft;

  grading = at;
  gradingRecord = record;
  showError('');
  const btn = $('wr-hand-in');
  lockBox();

  try {
    /* The text as it is handed in is on disk before the call, so a call
       that fails, or a page closed while it is out, keeps it. */
    record.text = text;
    if (unsaved === record) saver.cancel();
    await store.saveWriting(record);
    const { result, model } = await store.client.gradeWriting({
      kind: at.kind, brief: at.brief, sourceText: at.sourceText, cards: at.cards, text,
    });
    /* The draft becomes the piece: the same record, now with its feedback,
       dated the day it was handed in. */
    record.result = result;
    record.model = model;
    record.ended = true;
    record.created = new Date().toISOString().slice(0, 10);
    record.language = s.targetLanguage;
    record.level = s.learnerLevel;
    record.title = writingTitle(record);
    /* "Not an attempt" scores nothing; feedback scores the cards it
       judged right or wrong, and leaves the ones not used alone. */
    const scored = result.valid ? await scoreVerdicts(result.cards, at.cards) : { moves: new Map(), saved: true };
    /* Kept whether or not another task has been started meanwhile: it is
       in the list below either way. */
    const kept = await store.saveWriting(record);
    if (task !== at) return;
    shown = record;
    draft = null;
    moves = scored.moves;
    saved = scored.saved;
    renderCard();
    if (!kept) {
      showError(`The feedback is on screen but could not be written to ${storage.label()}. Reconnect the data folder in Settings; it will be lost on reload.`, false, $('wr-count-row'));
    }
    $('wr-result').scrollIntoView({ block: 'start', behavior: 'smooth' });
  } catch (e) {
    console.error(e);
    if (task === at) showError(describe(e), true, $('wr-count-row'));
  } finally {
    grading = null;
    gradingRecord = null;
    btn.textContent = 'Hand in';
    if (task === at) {
      $('wr-text').readOnly = false;
      $('wr-busy').hidden = true;
    }
    renderQuota();
    renderHandIn();
  }
}

/* Each verdict of right or wrong is recorded on the card it names, through
   recordResult like any other answer; 'absent' is left unscored. Nothing
   is typed letter by letter, so the accent flag is left alone. A card the
   deck no longer has is skipped. Returns what each card moved by, keyed by
   its place in `cards`, and whether the decks were written. Conversation
   scores its cards through this too. */
export async function scoreVerdicts(verdicts, cards) {
  const out = new Map();
  const touched = [];
  for (const v of verdicts || []) {
    if (v.verdict !== 'right' && v.verdict !== 'wrong') continue;
    const c = cards[v.index];
    const found = c && store.findCard(c.front, c.deck);
    if (!found) continue;
    out.set(v.index, recordResult(found.card, v.verdict === 'right', { typedFront: false }));
    touched.push(found.card);
  }
  const ok = touched.length ? await store.saveCardDecks(...touched) : true;
  return { moves: out, saved: ok };
}

function writeAgain() {
  if (!task || busy()) return;
  if (task.missingSource) {
    showError('The reading text this piece summarised has since been deleted, so there is nothing to summarise again. Pick another text above.', false, $('wr-again-row'));
    return;
  }
  showError('');
  setTask(task, { scroll: false });
}

/* ── the feedback ────────────────────────────────────────────────────── */

function resultHtml(record) {
  const r = record.result;
  const lang = escapeHtml(languageCode(record.language || store.state.settings.targetLanguage));
  if (!r.valid) {
    return `<div class="banner is-warn wr-fb"><strong>This was not counted as an attempt at the task.</strong> ${escapeHtml(r.reason)} Nothing was scored.</div>`;
  }
  const parts = [];
  if (r.detectedLevel) parts.push(`<p class="wr-level">This reads at <b>${escapeHtml(r.detectedLevel)}</b></p>`);
  if (r.languageNote) parts.push(`<p>${escapeHtml(r.languageNote)}</p>`);
  if (r.contentNote) parts.push(`<p>${escapeHtml(r.contentNote)}</p>`);

  if (r.taskPoints.length) {
    parts.push('<h4>What the task asked for</h4>');
    parts.push(`<ul class="wr-points">${r.taskPoints.map((p) => `<li class="${p.met ? 'is-ok' : 'is-bad'}">
      <span class="wr-mark" aria-label="${p.met ? 'Done' : 'Missed'}">${p.met ? '✓' : '✗'}</span>
      <span>${escapeHtml(p.point)}${!p.met && p.note ? `<span class="wr-sub">${escapeHtml(p.note)}</span>` : ''}</span>
    </li>`).join('')}</ul>`);
  }

  parts.push('<h4>Grammar and spelling</h4>');
  parts.push(r.grammarMistakes.length
    ? `<ul class="wr-list">${r.grammarMistakes.map((g) => {
      const card = g.cardNumber ? record.cards[g.cardNumber - 1] : null;
      return `<li>${escapeHtml(g.description)}${g.correction ? ` → <b lang="${lang}">${escapeHtml(g.correction)}</b>` : ''}
        ${card ? `<span class="wr-sub">One of your patterns: <span lang="${lang}">${escapeHtml(card.front)}</span></span>` : ''}</li>`;
    }).join('')}</ul>`
    : '<p class="note">No mistakes found.</p>');

  if (r.vocabStyle.length) {
    parts.push('<h4>Ways to say it a level up</h4>');
    parts.push(`<ul class="wr-list">${r.vocabStyle.map((v) => `<li>
      <span class="wr-tag">${v.category === 'STYLE' ? 'Style' : 'Word choice'}</span>
      <span lang="${lang}">“${escapeHtml(v.original)}”</span> → <b lang="${lang}">${v.suggestions.map(escapeHtml).join(' / ')}</b>
      ${v.reason ? `<span class="wr-sub">${escapeHtml(v.reason)}</span>` : ''}
    </li>`).join('')}</ul>`);
  }

  if (record.cards.length) {
    parts.push('<h4>Your cards</h4>');
    parts.push(cardsResultHtml(record.cards, r.cards, moves, saved, lang));
  }
  return `<div class="wr-fb">${parts.join('')}</div>`;
}

const VERDICT_LABEL = { right: 'Right', wrong: 'Wrong', absent: 'Not used' };

/* What one answer did to a card's score: nothing when it stayed put, and
   only where it landed for a card that had no score before this. */
export function moveHtml(m) {
  if (m.before === m.after) return '';
  const after = scoreMark(m.after, SCORE_LABEL[m.after].toLowerCase());
  return Number.isInteger(m.before) ? ` · ${scoreMark(m.before)} → ${after}` : ` · → ${after}`;
}

/* One line per card: its verdict, the grader's note, and, right after a
   hand-in, what the score did. A card the grader said nothing about is
   listed as not judged, and scored nothing. Conversation draws its cards
   through this too. `cards` are {front, deck}; `verdicts` come from
   cardVerdicts(); `moved` is a Map from a card's place to its move, or null
   for a piece reopened from the list; `ok` is whether the decks were
   written. */
export function cardsResultHtml(cards, verdicts, moved, ok, lang = '') {
  const byIndex = new Map((verdicts || []).map((v) => [v.index, v]));
  const rows = cards.map((c, i) => {
    const v = byIndex.get(i);
    const verdict = v ? v.verdict : null;
    const cls = verdict === 'right' ? 'chip--ok' : verdict === 'wrong' ? 'chip--bad' : '';
    const m = moved && moved.get(i);
    const move = m ? moveHtml(m) : '';
    const gone = !store.findCard(c.front, c.deck) ? ' · no longer in its deck, so nothing was scored' : '';
    return `<li>
      <span class="chip ${cls}" lang="${escapeHtml(lang)}">${escapeHtml(c.front)}</span>
      <span class="wr-verdict">${verdict ? VERDICT_LABEL[verdict] : 'Not judged'}${move}${gone}</span>
      ${v && v.note ? `<span class="wr-sub" lang="">${escapeHtml(v.note)}</span>` : ''}
    </li>`;
  });
  let tail = '';
  if (ok === false) tail = '<p class="note is-bad">Your decks could not be written. Reconnect the data folder in Settings.</p>';
  else if (moved && !store.state.persistent) tail = '<p class="note">Not saved: nothing is being saved in this browser.</p>';
  return `<ul class="wr-cards">${rows.join('')}</ul>${tail}`;
}

/* ── the list of pieces ──────────────────────────────────────────────── */

function renderList() {
  const rows = store.state.writings || [];
  const on = shown || draft;
  $('wr-list-hint').textContent = rows.length ? `${rows.length} piece${rows.length === 1 ? '' : 's'}` : 'nothing yet';
  $('wr-list').innerHTML = rows.length
    ? rows.map((r) => `<div class="sh-hist rd-row${on && on.id === r.id ? ' is-open' : ''}" data-writing="${escapeHtml(r.id)}">
        <button class="sh-hist-open" data-act="open">
          <span class="rd-row-head">
            <span class="sh-hist-id rd-row-title">${escapeHtml(r.title || r.id)}</span>
            ${r.ended === false ? '<span class="rd-badge rd-badge--audio">Draft</span>' : ''}
          </span>
          <span class="sh-hist-sub">${[
            r.created, r.kind === 'summary' ? 'summary' : 'opinion', r.decks && r.decks.length ? r.decks.join(', ') : '', r.language,
          ].filter(Boolean).map(escapeHtml).join(' · ')}</span>
        </button>
        <button class="btn btn--sm btn--danger" data-act="delete" title="${r.ended === false ? 'Delete this draft' : 'Delete this piece and its feedback'}">${armed === r.id ? 'Really delete?' : 'Delete'}</button>
      </div>`).join('')
    : '<p class="note">Everything you write is kept here: a piece you have not handed in yet as a draft, to carry on with, and every piece handed in with its feedback. Click one to open it.</p>';
}

async function openWriting(id) {
  if (draft && draft.id === id) {
    $('wr-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  /* The piece out to be read is taken as it is in memory, which is where
     its feedback will land, not as the copy on disk. */
  const record = gradingRecord && gradingRecord.id === id ? gradingRecord : await store.loadWriting(id);
  if (!record) {
    showError(`That piece could not be read from ${storage.label()}. Its file may have been moved or deleted outside the app.`);
    return;
  }
  showError('');
  await leaveDraft();
  if (isDraft(record)) {
    await showDraft(record);
    return;
  }
  unlockBox();
  task = await taskOf(record);
  shown = record;
  moves = null;
  saved = null;
  renderCard();
  renderList();
  $('wr-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/* The task a kept piece was written to, rebuilt so Write again can set it
   again: the cards as the decks have them now, and a summary's source read
   from its text, which may have been deleted since. */
async function taskOf(record) {
  const cards = (record.cards || []).map((c) => {
    const found = store.findCard(c.front, c.deck);
    return found ? copyCard(found.card, found.deck) : { front: c.front, back: '', deck: c.deck };
  });
  if (record.kind !== 'summary') return { kind: 'opinion', brief: record.brief, cards };
  const reading = record.readingId ? await store.loadReading(record.readingId) : null;
  const sourceText = reading ? speakableText(reading) : '';
  return {
    kind: 'summary',
    brief: '',
    readingId: record.readingId,
    readingTitle: record.readingTitle || '',
    sourceText,
    sourceWords: countWords(sourceText),
    cards,
    missingSource: !reading,
  };
}

async function remove(id) {
  /* Not the piece out to be read: its feedback is on its way to it. */
  if (gradingRecord && gradingRecord.id === id) return;
  clearTimeout(disarm);
  if (armed !== id) {
    armed = id;
    renderList();
    disarm = setTimeout(() => { armed = null; renderList(); }, 4000);
    return;
  }
  armed = null;
  if ((shown && shown.id === id) || (draft && draft.id === id)) clear();
  await store.deleteWriting(id);
}

function forgetIfGone() {
  const on = shown || draft;
  if (on && on !== gradingRecord && !store.state.writings.some((r) => r.id === on.id)) clear();
}

function clear() {
  if (unsaved && unsaved === draft) { saver.cancel(); unsaved = null; }
  task = null;
  draft = null;
  shown = null;
  moves = null;
  saved = null;
  renderCard();
  renderList();
}

/* ── the budget readout ──────────────────────────────────────────────── */

function renderQuota() {
  if (!isActive()) return;
  const g = store.jobUsage('writingGradeModel');
  const t = store.jobUsage('writingBriefModel');
  const el = $('wr-quota');
  const usage = `feedback ${g.usedDay}/${g.rpd || '∞'} in 24h`;
  if (g.retryAfter > 0) {
    el.textContent = `feedback waits ${formatWait(g.retryAfter)} · ${usage}`;
    el.className = 'quota is-bad';
  } else {
    el.textContent = (g.leftDay === null ? 'unlimited' : `${g.leftDay} feedback call${g.leftDay === 1 ? '' : 's'} left`) + ' · ' + usage;
    el.className = 'quota ' + (g.leftDay !== null && g.leftDay <= 2 ? 'is-bad' : 'is-ok');
  }
  if (!asking) {
    $('wr-ask').disabled = t.retryAfter > 0 || !storage.getApiKey();
    $('wr-ask').title = t.retryAfter > 0
      ? `${t.model} is out of budget for now: next call in ${formatWait(t.retryAfter)}.`
      : `One call on ${t.model}: text ${t.usedDay}/${t.rpd || '∞'} in 24h`;
  }
  $('wr-hand-in').title = `One call on ${g.model}`;
  renderHandIn();
}

/* ── small helpers ───────────────────────────────────────────────────── */

/* A failed hand-in offers Try again beside the error; the writing is still
   in the box. `at` is the row of the button that was pressed: an error
   from a wait takes the spinner's place (errorSpot), under Hand in rather
   than above the task. */
let placeError = () => {};

function showError(text, retry = false, at = null) {
  const el = $('wr-error');
  placeError(text ? at : null);
  el.innerHTML = text
    ? `<div class="banner is-bad">${escapeHtml(text)}${retry ? ' <button class="btn btn--sm" data-act="retry">Try again</button>' : ''}</div>`
    : '';
}
