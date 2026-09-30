/* Translate: six English sentences, each written in the language you are
   learning, checked together in one call.

   The sentences come from the bank Dictation fills, so a set costs nothing
   to make: the English is the prompt, the banked sentence is one right
   answer, and its target words are the cards it practises. The bank is only
   read here. When too few of its sentences belong to the ticked decks, the
   tab says so and offers what there is; it never writes new ones, which is
   Dictation's New sentence and nothing else.

   Check answers sends every item, blanks included, to the feedback model.
   Afterwards the answers lock, each row says whether it was right, shows
   one correct answer where it was not, and plays the banked audio; the
   cards move as translation.js decides. A set is not kept, as a Typing
   session is not: what stays is the scores. The one being worked on is,
   though, until it is checked: it is saved as its answers are typed
   (autosave.js), so a reload brings back the same sentences with the
   answers in them. The logic that has no DOM is translation.js. */

import * as store from './store.js';
import * as storage from './storage.js';
import { recordResult, SCORE_LABEL } from './deck.js';
import {
  MAX_ANSWER, pickTranslationItems, translationScores, cleanAnswer, translationDraft, restoreDraft,
} from './translation.js';
import { createAutosave } from './autosave.js';
import { escapeHtml, scoreMark } from './text.js';
import { formatWait } from './gemini.js';
import { describe } from './tab-settings.js';
import { languageCode } from './speech.js';
import { errorSpot } from './error-spot.js';

const $ = (id) => document.getElementById(id);

/* The set on screen, what was typed for each item, and once checked, the
   grader's results and what they did to each card: moves.get(item) is a
   Map from the card's place in that item to its move. */
let items = [];
let answers = [];
let results = null;
let moves = null;
let saved = null;
/* The set out to be checked, if one is. New set is never blocked by it: the
   check still scores that set's cards when it comes back, and is shown only
   if that set is still the one on screen. */
let checking = null;
/* Saves the set on screen and its answers while they are being typed. A
   set that has been checked, or is out to be checked, is not one to bring
   back with a reload, so it is not saved. `restoring` is a kept set being
   read back, so two showings of the tab do not both draw. */
const saver = createAutosave(() => (items.length && !results ? store.saveTranslateDraft(translationDraft(items, answers)) : null));
let restoring = false;
/* The one sentence playing, and its URL when this tab made it. */
let player = null;
let playerUrl = null;

export function init() {
  $('tr-new').addEventListener('click', newSet);
  $('tr-check').addEventListener('click', check);
  $('tr-error').addEventListener('click', (e) => { if (e.target.closest('[data-act="retry"]')) check(); });
  placeError = errorSpot($('tr-error'));
  const list = $('tr-list');
  list.addEventListener('input', (e) => {
    const input = e.target.closest('input[data-i]');
    if (!input) return;
    answers[Number(input.dataset.i)] = input.value;
    saver.touch();
    renderCheck();
  });
  /* A page being hidden may be a page being closed. */
  document.addEventListener('visibilitychange', () => { if (document.hidden) saver.flush(); });
  list.addEventListener('keydown', (e) => {
    const input = e.target.closest('input[data-i]');
    if (!input || e.key !== 'Enter') return;
    e.preventDefault();
    /* Enter walks down the list, and on the last item checks the set. */
    const next = list.querySelector(`input[data-i="${Number(input.dataset.i) + 1}"]`);
    if (next) next.focus();
    else if (!$('tr-check').disabled) check();
  });
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-play]');
    if (btn) play(Number(btn.dataset.play));
  });

  store.subscribe('bank', renderPool);
  store.subscribe('deck', renderPool);
  store.subscribe('folder', () => { gate(); items = []; results = null; render(); });
  store.subscribe('ready', () => { if (isActive()) onShow(); });
  store.subscribe('quota', renderQuota);
  setInterval(renderQuota, 1000);
  gate();
  render();
}

export async function onShow() {
  gate();
  renderPool();
  /* The first set is drawn when the tab is first looked at, once the store
     has been read: it costs nothing, and an empty tab asking to be told to
     draw one would be a click for no reason. A set left half answered, by
     a reload or a closed tab, comes back instead, answers and all. */
  if (!items.length && !restoring && store.state.ready) {
    restoring = true;
    try {
      const kept = restoreDraft(await store.loadTranslateDraft(), store.state.manifest);
      if (!items.length) drawSet(kept);
    } finally {
      restoring = false;
    }
  }
  render();
}

export function onHide() {
  stopPlayer();
  saver.flush();
}

function isActive() {
  return !$('panel-translate').hidden;
}

/* ── gating ──────────────────────────────────────────────────────────── */

function gate() {
  const el = $('tr-gate');
  if (!storage.getApiKey()) {
    el.innerHTML = `<div class="gate">
      <h3>Add a Gemini API key first</h3>
      <p>Your translations are checked by the Gemini API, using your own key and one call from the feedback model's budget for each set. Paste a key into the Settings tab.</p>
      </div>`;
    $('tr-stage').hidden = true;
    return;
  }
  el.innerHTML = !store.state.persistent
    ? '<div class="banner is-warn">Nothing is being saved — you can translate and have sets checked, but what they do to your cards is gone on reload. See Settings for what this browser can keep.</div>'
    : '';
  $('tr-stage').hidden = false;
  renderQuota();
}

function inScope() {
  return store.state.manifest.filter(store.bankInScope);
}

function renderPool() {
  const n = inScope().filter((e) => String(e.english || '').trim()).length;
  const decks = store.practiceDecks();
  $('tr-pool').textContent = [
    `${n} banked sentence${n === 1 ? '' : 's'} in scope`,
    decks.length === 1 ? `deck ${decks[0]}` : `${decks.length} decks ticked`,
  ].join(' · ');
}

/* ── the set ─────────────────────────────────────────────────────────── */

/* A new set from the bank, or `kept`, the set that was being worked on.
   A new one has nothing typed in it, so what was kept of the old one goes;
   the new one is kept from its first keystroke. */
function drawSet(kept = null) {
  stopPlayer();
  const s = store.state.settings;
  if (kept) {
    ({ items, answers } = kept);
  } else {
    saver.cancel();
    store.clearTranslateDraft();
    items = pickTranslationItems(inScope(), s.translateItems, store.findCard, s.translateOrder);
    answers = items.map(() => '');
  }
  results = null;
  moves = null;
  saved = null;
  showError('');
}

function newSet() {
  drawSet();
  render();
  const first = $('tr-list').querySelector('input[data-i="0"]');
  if (first) first.focus();
}

function render() {
  renderPool();
  const lang = languageCode(store.state.settings.targetLanguage);
  const language = store.state.settings.targetLanguage;
  const idle = $('tr-idle');
  if (!items.length) {
    idle.hidden = false;
    idle.innerHTML = `<h3>No sentences to translate yet</h3>
      <p>A set is made from the sentence bank, for the decks ticked in the Flashcards tab. Dictation's <strong>New sentence</strong> writes those sentences, and each one turns up here as soon as it exists. Nothing on this tab writes new ones.</p>`;
    $('tr-card').hidden = true;
    $('tr-short').hidden = true;
    return;
  }
  idle.hidden = true;
  $('tr-card').hidden = false;
  const want = store.state.settings.translateItems;
  const short = items.length < want;
  $('tr-short').hidden = !short;
  $('tr-short').textContent = short
    ? `Only ${items.length} banked sentence${items.length === 1 ? ' is' : 's are'} in scope, so this set has ${items.length}. Dictation's New sentence adds more.`
    : '';

  $('tr-list').innerHTML = items.map((it, i) => {
    const r = results && results[i];
    const blank = !cleanAnswer(answers[i]);
    const wrong = r && (blank || (r.graded && !r.correct));
    const cls = !r ? '' : wrong ? ' is-bad' : r.graded ? ' is-ok' : ' is-ungraded';
    return `<li class="tr-item${cls}">
      <div class="tr-en">${escapeHtml(it.english)}</div>
      <input type="text" class="answer-input tr-input${!r ? '' : wrong ? ' is-bad' : r.graded ? ' is-ok' : ''}" data-i="${i}"
        maxlength="${MAX_ANSWER}" spellcheck="false" autocomplete="off" lang="${escapeHtml(lang)}"
        placeholder="In ${escapeHtml(language)}…" aria-label="Item ${i + 1} in ${escapeHtml(language)}"
        value="${escapeHtml(answers[i] || '')}"${r ? ' readonly' : ''}>
      ${r ? verdictHtml(it, r, i, blank, wrong, lang) : ''}
    </li>`;
  }).join('');
  renderCheck();
  renderSummary();
}

function verdictHtml(it, r, i, blank, wrong, lang) {
  let head;
  if (wrong) head = `One correct answer: <b lang="${escapeHtml(lang)}">${escapeHtml(it.sentence)}</b>`;
  else if (!r.graded) head = 'This one could not be checked.';
  else head = '<span class="tr-ok">Correct.</span>';
  const why = blank && !r.explanation ? 'You left this one blank.' : r.explanation;
  const cardMoves = moves && moves.get(i);
  const chips = it.cards.map((c, k) => {
    const m = cardMoves && cardMoves.get(k);
    const cls = !m ? '' : m.ok ? ' chip--ok' : ' chip--bad';
    const moved = !m || m.before === m.after ? ''
      : Number.isInteger(m.before) ? ` ${scoreMark(m.before)}→${scoreMark(m.after)}` : ` →${scoreMark(m.after)}`;
    const title = m ? `${m.ok ? 'Scored right' : 'Scored wrong'}${m.before !== m.after ? `: ${SCORE_LABEL[m.before] || 'new'} → ${SCORE_LABEL[m.after]}` : ''}` : 'Not scored';
    return `<span class="chip${cls}" lang="${escapeHtml(lang)}" title="${escapeHtml(title)}">${escapeHtml(c.front)}${moved}</span>`;
  }).join('');
  return `<div class="tr-verdict">
      <div class="tr-head">
        ${it.audio ? `<button type="button" class="play play--sm" data-play="${i}" aria-label="Play this sentence" title="Play the banked recording">▶</button>` : ''}
        <span>${head}</span>
      </div>
      ${why ? `<div class="tr-why">${escapeHtml(why)}</div>` : ''}
      ${chips ? `<div class="term-chips">${chips}</div>` : ''}
    </div>`;
}

function renderSummary() {
  const el = $('tr-summary');
  if (!results) { el.innerHTML = ''; return; }
  const right = results.filter((r, i) => r.graded && r.correct && cleanAnswer(answers[i])).length;
  const unchecked = results.filter((r, i) => !r.graded && cleanAnswer(answers[i])).length;
  let tail = '';
  if (saved === false) tail = ' <span class="is-bad">Your decks could not be written. Reconnect the data folder in Settings.</span>';
  else if (!store.state.persistent) tail = ' · the scores are not saved, nothing is being saved';
  el.innerHTML = `${right} of ${items.length} correct${unchecked ? ` · ${unchecked} could not be checked` : ''}${tail}`;
}

/* Live once anything is typed, and not while a check is out or once the
   set has been checked. */
function renderCheck() {
  const btn = $('tr-check');
  if (checking && checking === items) return;
  btn.textContent = 'Check answers';
  const g = store.jobUsage('translateModel');
  btn.disabled = !!checking || !!results || !answers.some((a) => cleanAnswer(a)) || g.retryAfter > 0 || !storage.getApiKey();
  btn.hidden = !!results;
  const wait = $('tr-wait');
  wait.hidden = !(g.retryAfter > 0 && !results && items.length);
  if (!wait.hidden) wait.textContent = `${g.model} is out of budget for now: next call in ${formatWait(g.retryAfter)}.`;
}

/* ── checking ────────────────────────────────────────────────────────── */

async function check() {
  if (checking || results || !items.length) return;
  const set = items;
  const typed = answers.map(cleanAnswer);
  checking = set;
  /* What was typed is on disk before the call, so a check that fails, or a
     page closed while it is out, keeps the answers. */
  saver.touch();
  saver.flush();
  showError('');
  const btn = $('tr-check');
  btn.innerHTML = '<span class="spinner"></span>Checking';
  btn.disabled = true;
  for (const input of $('tr-list').querySelectorAll('input')) input.readOnly = true;
  try {
    const { results: got } = await store.client.gradeTranslations(set, typed);
    /* Scored whether or not a new set has been drawn meanwhile: the
       answers were given, and the cards should move with them. */
    const scored = await score(set, got, typed);
    /* Checked: it is no longer a set being worked on. If a new set has been
       drawn meanwhile, that one is the kept one now, and stays. */
    if (items !== set) return;
    saver.cancel();
    store.clearTranslateDraft();
    results = got;
    moves = scored.moves;
    saved = scored.saved;
  } catch (e) {
    console.error(e);
    if (items === set) showError(`Could not check these just now. Try again in a moment. ${describe(e)}`, true, btn.closest('.row'));
  } finally {
    checking = null;
    btn.textContent = 'Check answers';
    if (items === set) render();
    renderQuota();
  }
}

/* Each move goes through recordResult on the card as the deck has it now,
   and every card touched is written back to its own deck. A card the deck
   no longer has is skipped. */
async function score(set, got, typed) {
  const out = new Map();
  const touched = [];
  for (const { item, card, ok } of translationScores(got, set, typed, { blankWrong: store.state.settings.translateBlankWrong })) {
    const c = set[item].cards[card];
    const found = c && store.findCard(c.front, c.deck);
    if (!found) continue;
    const move = recordResult(found.card, ok, { typedFront: false });
    if (!out.has(item)) out.set(item, new Map());
    out.get(item).set(card, { ...move, ok });
    touched.push(found.card);
  }
  const ok = touched.length ? await store.saveCardDecks(...touched) : true;
  return { moves: out, saved: ok };
}

/* ── the banked audio ────────────────────────────────────────────────── */

async function play(i) {
  const it = items[i];
  if (!it) return;
  stopPlayer();
  const entry = store.state.manifest.find((e) => e.id === it.bankId);
  const got = await store.bankAudioUrl(entry);
  if (!got) { showError('The recording of this sentence could not be read.'); return; }
  if (got.owned) playerUrl = got.url;
  player = new Audio(got.url);
  player.play().catch(() => {});
}

function stopPlayer() {
  if (player) { player.pause(); player = null; }
  if (playerUrl) { URL.revokeObjectURL(playerUrl); playerUrl = null; }
}

/* ── the budget readout ──────────────────────────────────────────────── */

function renderQuota() {
  if (!isActive()) return;
  const g = store.jobUsage('translateModel');
  const el = $('tr-quota');
  const usage = `feedback ${g.usedDay}/${g.rpd || '∞'} in 24h`;
  if (g.retryAfter > 0) {
    el.textContent = `feedback waits ${formatWait(g.retryAfter)} · ${usage}`;
    el.className = 'quota is-bad';
  } else {
    el.textContent = (g.leftDay === null ? 'unlimited' : `${g.leftDay} feedback call${g.leftDay === 1 ? '' : 's'} left`) + ' · ' + usage;
    el.className = 'quota ' + (g.leftDay !== null && g.leftDay <= 2 ? 'is-bad' : 'is-ok');
  }
  $('tr-check').title = `One call on ${g.model} for the whole set`;
  renderCheck();
}

/* `at` is the row of the button that was waiting: an error from checking
   takes the spinner's place, at the foot of the set, rather than at the
   top of the panel out of sight. */
let placeError = () => {};

function showError(text, retry = false, at = null) {
  const el = $('tr-error');
  placeError(text ? at : null);
  el.innerHTML = text
    ? `<div class="banner is-bad">${escapeHtml(text)}${retry ? ' <button class="btn btn--sm" data-act="retry">Try again</button>' : ''}</div>`
    : '';
}
