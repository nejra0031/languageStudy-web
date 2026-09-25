/* The selection popup: select some text anywhere on the page, and a small
   form opens under it to make it a flashcard — the word, its translation and
   notes, with Add, or Update when the chosen deck has the word already.

   Not a tab: it belongs to every tab at once, which is why it has a module of
   its own rather than living in one of the tab-*.js files. The decisions it
   makes — which way round, whether the card exists, what the sentence was —
   are plain functions in lookup.js; the request is translate.js. This file is
   only the DOM and the order things happen in. Off unless turned on in
   Settings. */

import * as store from './store.js';
import * as storage from './storage.js';
import { cleanSelection, sentenceAround, findCard, codeFor, nameFor, hasGap } from './lookup.js';
import { isPattern, setPattern } from './deck.js';
import { translate } from './translate.js';
import { escapeHtml } from './text.js';

const $ = (id) => document.getElementById(id);

let pop = null;
/* What the popup is open for. `token` goes up with every new selection, so a
   translation or a note that arrives after the student has moved on to
   another word is dropped rather than written into the wrong one. */
let open = null;
let token = 0;
/* A mouse button held down means a selection is still being dragged out;
   opening on every selectionchange of the drag would chase the pointer. */
let pointerDown = false;
let idle = 0;

export function init() {
  pop = $('lookup-pop');
  pop.innerHTML = `
    <div class="lookup-head">
      <span class="lookup-deck" id="lp-deck"></span>
      <button type="button" class="lookup-close" id="lp-close" aria-label="Close">&times;</button>
    </div>
    <div class="lookup-body">
      <div class="lookup-pair">
        <label class="field"><span id="lp-front-label">Word</span>
          <input type="text" id="lp-front" spellcheck="false" autocomplete="off"></label>
        <button type="button" class="btn btn--sm lookup-swap" id="lp-swap"
                title="Swap the word and the translation" aria-label="Swap the word and the translation">&#8644;</button>
        <label class="field"><span id="lp-back-label">Translation</span>
          <input type="text" id="lp-back" spellcheck="false" autocomplete="off"></label>
      </div>
      <label class="lookup-pattern"><input type="checkbox" id="lp-pattern">
        <span>Grammar pattern</span><em>write each gap as …</em></label>
      <div class="field">
        <div class="field-head">
          <label for="lp-notes">Notes</label>
          <button type="button" class="btn btn--sm" id="lp-ask">Ask for notes</button>
        </div>
        <textarea id="lp-notes" rows="3" spellcheck="false"></textarea>
      </div>
      <div class="row row--end">
        <button type="button" class="btn btn--primary btn--sm" id="lp-save">Add</button>
      </div>
    </div>
    <div class="status" id="lp-status" role="status"></div>`;

  $('lp-close').addEventListener('click', close);
  $('lp-swap').addEventListener('click', swap);
  $('lp-front').addEventListener('input', () => { followGap(); recheck(); });
  $('lp-pattern').addEventListener('change', () => { if (open) open.patternSaid = true; });
  $('lp-ask').addEventListener('click', askNotes);
  $('lp-save').addEventListener('click', save);

  document.addEventListener('mousedown', (e) => {
    pointerDown = true;
    if (open && !pop.contains(e.target)) close();
  });
  document.addEventListener('mouseup', () => { pointerDown = false; setTimeout(check, 0); });
  document.addEventListener('keyup', (e) => { if (e.key !== 'Escape') setTimeout(check, 0); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open) close(); });
  /* A phone selects with a long press and drags the handles after it; no
     mouseup ever comes, so the selection itself is watched, and acted on
     once it has held still for a moment. Its own timer: the selectionchange
     that follows a mouseup must not put off the check the mouseup asked for.
     A selection both of them see is opened once — see `where` in check(). */
  document.addEventListener('selectionchange', () => {
    if (pointerDown) return;
    clearTimeout(idle);
    idle = setTimeout(check, 450);
  });

  store.subscribe('settings', (s) => { if (!s.settings.lookupEnabled && open) close(); });
}

/* Fields text is typed into. A focused tickbox or button says nothing about
   the selection, so it does not keep the popup shut. */
const TYPING = 'textarea, [contenteditable]:not([contenteditable="false"]), '
  + 'input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="range"]):not([type="file"])';

/* ── opening ─────────────────────────────────────────────────────────── */

function check() {
  if (!store.state.settings.lookupEnabled || !store.state.ready) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return;
  /* A selection inside a text field is someone editing, not reading: the deck
     editor, an answer being typed, a prompt. And never the popup itself. */
  const active = document.activeElement;
  if (active && active.matches(TYPING)) return;
  const range = sel.getRangeAt(0);
  const node = range.commonAncestorContainer;
  const el = node.nodeType === 1 ? node : node.parentElement;
  if (!el || el.closest('input, textarea, select, [contenteditable], #lookup-pop')) return;

  const raw = sel.toString();
  const text = cleanSelection(raw);
  if (!text) return;
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) return;

  /* The same selection, still standing: nothing new to do. */
  const where = `${text}|${Math.round(rect.left + window.scrollX)}|${Math.round(rect.top + window.scrollY)}`;
  if (open && open.where === where) return;

  openFor(text, rect, contextOf(el, range, raw), where);
}

/* The sentence the selection sits in, read from the nearest block around it.
   A block by how it is laid out, not by its tag: Dictation's answer is one
   inline span per word, and the word's own span is no sentence at all. */
function contextOf(el, range, raw) {
  let block = el;
  while (block.parentElement && block !== document.body
         && getComputedStyle(block).display.startsWith('inline')) {
    block = block.parentElement;
  }
  try {
    const before = document.createRange();
    before.selectNodeContents(block);
    before.setEnd(range.startContainer, range.startOffset);
    const start = before.toString().length;
    return sentenceAround(block.textContent, start, start + raw.length);
  } catch (e) {
    return '';
  }
}

function languages() {
  const s = store.state.settings;
  const learning = s.lookupLearning || codeFor(s.targetLanguage);
  return {
    learning,
    native: s.lookupNative,
    learningName: s.lookupLearning ? nameFor(s.lookupLearning) : s.targetLanguage,
    nativeName: nameFor(s.lookupNative),
  };
}

async function openFor(text, rect, context, where) {
  const mine = ++token;
  const deck = store.lookupDeck();
  const langs = languages();
  /* patternSaid: the tickbox has been set by someone who knows — the student
     ticking it, or a stored card saying what it is — and is no longer
     guessed from the word. */
  open = { where, context, deck, card: null, langs, patternSaid: false };

  $('lp-deck').innerHTML = `into <b>${escapeHtml(deck)}.json</b>`;
  $('lp-front-label').textContent = langs.learningName || 'Word';
  $('lp-back-label').textContent = langs.nativeName || 'Translation';
  $('lp-front').value = text;
  $('lp-back').value = '';
  $('lp-back').placeholder = '';
  $('lp-notes').value = '';
  followGap();
  $('lp-ask').disabled = false;
  $('lp-ask').textContent = 'Ask for notes';
  pop.hidden = false;
  place(rect);

  /* A word already in the deck is shown as it is stored, and costs nothing:
     the card's own meaning is the one the student chose. */
  const known = findCard(deckCards(), { front: text, back: text });
  if (known) {
    fillFrom(known);
    status(`Already in ${deck}.json. Change it and press Update.`, '');
    return;
  }
  setMode(null);
  $('lp-back').placeholder = 'Translating…';
  status('Asking Google Translate…', '');

  try {
    const found = await translate(text, langs);
    if (mine !== token) return;
    $('lp-front').value = found.front;
    $('lp-back').value = found.back;
    $('lp-back').placeholder = '';
    followGap();
    const existing = found.direction === 'reverse' ? findCard(deckCards(), { front: found.front }) : null;
    if (existing) {
      fillFrom(existing);
      status(`${found.front} is already in ${deck}.json. Change it and press Update.`, '');
    } else {
      status(found.direction === 'reverse'
        ? `That was ${langs.nativeName}, so it is the meaning. ⇄ swaps them if not.`
        : 'Translated by Google Translate. Correct it if it is off.', '');
    }
  } catch (e) {
    if (mine !== token) return;
    $('lp-back').placeholder = 'Type the meaning';
    status(e.message || String(e), 'is-warn');
  }
}

function deckCards() {
  return (open && store.state.decks[open.deck]) || [];
}

function fillFrom(card) {
  $('lp-front').value = card.front;
  $('lp-back').value = card.back;
  $('lp-notes').value = card.notes || '';
  $('lp-pattern').checked = isPattern(card);
  open.patternSaid = true;
  setMode(card);
}

/* Until it has been said, the tickbox follows the word: a gap written into
   it makes it a pattern, and taking the gap out again unticks it. */
function followGap() {
  if (open && !open.patternSaid) $('lp-pattern').checked = hasGap($('lp-front').value);
}

function setMode(card) {
  open.card = card;
  $('lp-save').textContent = card ? 'Update' : 'Add';
}

/* Under the selection, inside the page's width with the same gutter the page
   keeps at phone width. Placed in page coordinates, so it scrolls with the
   text it belongs to. */
function place(rect) {
  const gutter = 16;
  const width = pop.offsetWidth;
  const view = document.documentElement.clientWidth;
  const left = Math.max(gutter, Math.min(rect.left, view - width - gutter));
  pop.style.left = `${left + window.scrollX}px`;
  pop.style.top = `${rect.bottom + window.scrollY + 6}px`;
}

function close() {
  token++;
  open = null;
  pop.hidden = true;
}

function status(text, cls) {
  const el = $('lp-status');
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

/* ── the form ────────────────────────────────────────────────────────── */

/* The button follows the word in the Word field: Update while the deck has
   it, Add when it does not. A card whose notes are on screen keeps them when
   the word is edited back and forth; a new match brings its own. */
function recheck() {
  if (!open) return;
  const card = findCard(deckCards(), { front: $('lp-front').value });
  if (card && card !== open.card) {
    $('lp-notes').value = card.notes || $('lp-notes').value;
    $('lp-back').value = card.back;
    $('lp-pattern').checked = isPattern(card);
    open.patternSaid = true;
  }
  setMode(card);
}

function swap() {
  const front = $('lp-front');
  const back = $('lp-back');
  [front.value, back.value] = [back.value, front.value];
  recheck();
}

async function askNotes() {
  if (!open) return;
  const front = $('lp-front').value.trim();
  const back = $('lp-back').value.trim();
  if (!front) { status('Notes need a word to be about.', 'is-warn'); return; }
  if (!storage.getApiKey()) { status('Notes are written by Gemini. Add your key in Settings first.', 'is-warn'); return; }
  const mine = token;
  const btn = $('lp-ask');
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Writing';
  status(`Asking ${store.state.settings.notesModel}…`, '');
  try {
    const notes = await store.client.writeNotes({
      front, back, context: open.context, pattern: $('lp-pattern').checked,
      learningName: open.langs.learningName, nativeName: open.langs.nativeName,
    });
    if (mine !== token) return;
    const box = $('lp-notes');
    box.value = box.value.trim() ? `${box.value.trimEnd()}\n${notes}` : notes;
    status(`Notes from ${store.state.settings.notesModel}. Edit them as you like, then ${open.card ? 'Update' : 'Add'}.`, 'is-ok');
  } catch (e) {
    if (mine !== token) return;
    status((e && e.message) || String(e), 'is-bad');
  } finally {
    if (mine === token) {
      btn.disabled = false;
      btn.textContent = 'Ask for notes';
    }
  }
}

/* Update changes the meaning, the notes and whether the card is a pattern,
   and nothing else: the score and the history are the card's record of
   practice, and a new meaning is no reason to forget it. */
async function save() {
  if (!open) return;
  const front = $('lp-front').value.trim();
  const back = $('lp-back').value.trim();
  const notes = $('lp-notes').value.trim();
  const pattern = $('lp-pattern').checked;
  if (!front || !back) { status('A card needs both a word and a meaning.', 'is-warn'); return; }
  const deck = open.deck;
  const where = store.state.persistent ? `${deck}.json` : `${deck}.json, in memory only — nothing is being saved`;

  let ok;
  if (open.card) {
    const card = open.card;
    card.back = back;
    if (notes) card.notes = notes;
    else delete card.notes;
    setPattern(card, pattern);
    ok = await store.saveCardDecks(card);
    if (ok) status(`Updated ${card.front} in ${where}.`, 'is-ok');
  } else {
    /* The card is in the deck either way, so the button becomes Update
       whether or not the write landed: pressing it again retries the write
       rather than adding the word twice. */
    const added = await store.addCard(deck, setPattern({ front, back, notes }, pattern));
    setMode(added.card);
    ok = added.ok;
    if (ok) status(`Added ${front} to ${where}.`, 'is-ok');
  }
  if (!ok) status(`Could not write ${deck}.json. Reconnect the data folder in Settings and try again.`, 'is-bad');
}
