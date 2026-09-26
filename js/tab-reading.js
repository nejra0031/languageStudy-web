/* Reading: a text written around your cards, to read and look words up in.

   The text model writes a story, an article or whatever the request box
   asks for, using words and grammar patterns drawn from the ticked decks,
   and marks every place it used one. Those places are coloured — words one
   way, patterns another — and clicking one opens a small popup under it.

   The popup asks first and shows second: did you understand it? Only after
   ✅ or ❌ does the meaning appear, because a meaning already on screen
   answers the question for you. The answer is scored like any other, through
   recordResult, and a change of mind once the meaning is read goes through
   the amend functions beside it, never by editing the score. One verdict per
   card per text, however many times the card appears in it.

   The popup is the selection popup's shape and sits where it would: its
   styles are lookup-popup's, and so is the code that places it. The two
   never open together — the selection popup ignores a marked word. The rest
   of the text is ordinary text, so an unmarked word you do not know can be
   selected and added as a card. The logic that has no DOM is reading.js.

   Every text is kept, and listed above the form: it cost a call to write.
   Read aloud has the speech model read the whole text in one call, in the
   voice picked beside it, and the audio is kept beside the text; the list
   says which texts have some. Reading it aloud again replaces the audio,
   and Delete audio takes it off, leaving the text. Answers are
   not kept with a text — reading it again another day is practice again. */

import * as store from './store.js';
import * as storage from './storage.js';
import {
  isPattern, inScope, recordResult, amendLastToRight, amendLastToWrong, accepted, SCORE_LABEL,
} from './deck.js';
import {
  READING_PRESETS, pickReadingCards, clampTerms, nextReadingId, speakableText,
} from './reading.js';
import { escapeHtml, scoreMark } from './text.js';
import { formatWait } from './gemini.js';
import { VOICES } from './defaults.js';
import { describe } from './tab-settings.js';
import { languageCode } from './speech.js';
import { placeUnder } from './lookup-popup.js';

const $ = (id) => document.getElementById(id);

let scope = 'all';
let busy = false;
let ticker = null;
/* The text on screen: what readReading() gave back, plus `items`, one per
   card it was asked to use, in the order of the list the model was given.
   An item is a copy of what the card said when the text was written; the
   card itself is looked up again when it is scored, because the deck may
   have been edited and reloaded since. */
let current = null;
/* The audio of the text on screen, as an object URL, and its player. */
let audioUrl = null;
let rate = 1;
/* The row whose Delete has been pressed once, waiting for the second press
   that means it; and the timer that stands it down again. */
let armed = null;
let disarm = 0;
/* The same for Delete audio, which is one button for whichever text is
   open, so a flag is enough. */
let audioArmed = false;
let audioDisarm = 0;
/* item index -> { ok, before, move, saved } */
const verdicts = new Map();
let pop = null;
/* Which item the popup is open on, and the mark it was opened from, so
   Escape can hand focus back to it. */
let openItem = null;
let openAnchor = null;

export function init() {
  pop = $('reading-pop');

  $('rd-scope').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn) return;
    scope = btn.dataset.scope;
    setSeg('rd-scope', 'scope', scope);
    store.saveSettings({ readingScope: scope });
    renderPool();
  });

  $('rd-presets').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-preset]');
    const preset = btn && READING_PRESETS.find((p) => p.id === btn.dataset.preset);
    if (!preset) return;
    $('rd-request').value = preset.request;
    $('rd-terms').value = String(preset.terms);
    store.saveSettings({ readingRequest: preset.request, readingTerms: preset.terms });
    renderPool();
    $('rd-request').focus();
  });

  $('rd-request').addEventListener('change', (e) => store.saveSettings({ readingRequest: e.target.value }));
  $('rd-terms').addEventListener('change', (e) => {
    const n = clampTerms(e.target.value);
    e.target.value = String(n);
    store.saveSettings({ readingTerms: n });
    renderPool();
  });
  $('rd-new').addEventListener('click', generate);
  $('rd-speak').addEventListener('click', readAloud);
  $('rd-unspeak').addEventListener('click', unspeak);
  const voice = $('rd-voice');
  voice.innerHTML = '<option value="">Any of your dictation voices</option>'
    + VOICES.map(([name, style]) => `<option value="${escapeHtml(name)}">${escapeHtml(name)} — ${escapeHtml(style)}</option>`).join('');
  voice.addEventListener('change', () => store.saveSettings({ readingVoice: voice.value }));
  $('rd-download').addEventListener('click', downloadAudio);
  $('rd-rate').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-rate]');
    if (!btn) return;
    rate = Number(btn.dataset.rate);
    setSeg('rd-rate', 'rate', String(rate));
    $('rd-audio').playbackRate = rate;
  });
  /* A new source resets the speed, so it is put back each time one loads. */
  $('rd-audio').addEventListener('loadedmetadata', (e) => { e.target.playbackRate = rate; });
  setSeg('rd-rate', 'rate', '1');

  $('rd-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-reading]');
    if (!row) return;
    const id = row.dataset.reading;
    if (e.target.closest('[data-act="delete"]')) remove(id);
    else if (e.target.closest('[data-act="open"]')) openReading(id);
  });

  /* A marked word is a button in all but name: a real <button> inside a
     paragraph would break the line and the selection around it. */
  const text = $('rd-text');
  text.addEventListener('click', (e) => {
    const mark = e.target.closest('.rd-mark');
    /* The end of a drag across the text is a click too, and a selection is
       someone reading, not asking. */
    const sel = window.getSelection();
    if (!mark || (sel && !sel.isCollapsed)) return;
    openPop(Number(mark.dataset.item), mark, false);
  });
  text.addEventListener('keydown', (e) => {
    const mark = e.target.closest('.rd-mark');
    if (!mark || (e.key !== 'Enter' && e.key !== ' ')) return;
    e.preventDefault();
    openPop(Number(mark.dataset.item), mark, true);
  });

  pop.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'close') closePop(true);
    else if (act === 'yes') judge(true);
    else if (act === 'no') judge(false);
  });
  document.addEventListener('mousedown', (e) => {
    if (pop.hidden || pop.contains(e.target) || e.target.closest('.rd-mark')) return;
    closePop(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !pop.hidden) closePop(true);
  });

  const s = store.state.settings;
  scope = s.readingScope || 'all';
  setSeg('rd-scope', 'scope', scope);
  syncFields();

  store.subscribe('deck', () => {
    renderPool();
    if (!pop.hidden) renderPop();
  });
  store.subscribe('folder', () => { gate(); renderPool(); forgetIfGone(); });
  store.subscribe('reading', renderList);
  /* A store adopted at boot brings its own settings.json, and with it the
     request last typed there. */
  store.subscribe('settings', syncFields);
  store.subscribe('quota', renderQuota);
  ticker = setInterval(renderQuota, 1000);
  gate();
  renderList();
}

export function onShow() {
  gate();
  renderPool();
  renderList();
}

export function onHide() {
  closePop(false);
  $('rd-audio').pause();
}

function isActive() {
  return !$('panel-reading').hidden;
}

function setSeg(id, key, value) {
  for (const b of $(id).querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset[key] === value));
  }
}

/* The box keeps what is being typed into it: only a field that is not
   being edited follows the settings. */
function syncFields() {
  const s = store.state.settings;
  const request = $('rd-request');
  const terms = $('rd-terms');
  if (document.activeElement !== request) request.value = s.readingRequest || READING_PRESETS[0].request;
  if (document.activeElement !== terms) terms.value = String(s.readingTerms);
  $('rd-voice').value = s.readingVoice;
}

/* ── gating ──────────────────────────────────────────────────────────── */

function gate() {
  const el = $('rd-gate');
  if (!storage.getApiKey()) {
    el.innerHTML = `<div class="gate">
      <h3>Add a Gemini API key first</h3>
      <p>Each text is written by the Gemini API, using your own key and one call from the text model's budget. Paste a key into the Settings tab to write new ones. Texts you already have stay readable, and their audio playable, without a key.</p>
      </div>`;
    $('rd-stage').hidden = true;
    return;
  }
  el.innerHTML = !store.state.persistent
    ? '<div class="banner is-warn">Nothing is being saved — you can write and read texts and mark words, but the texts, their audio and what you mark are gone on reload. See Settings for what this browser can keep.</div>'
    : '';
  $('rd-stage').hidden = false;
  renderQuota();
}

/* ── pool ────────────────────────────────────────────────────────────── */

function pool() {
  return store.practiceCards().filter((c) => inScope(c, scope));
}

function renderPool() {
  const cards = pool();
  const patterns = cards.filter(isPattern).length;
  const decks = store.practiceDecks();
  $('rd-pool').textContent = [
    `${cards.length} cards in scope`,
    patterns ? `${patterns} of them patterns` : 'no grammar patterns',
    decks.length === 1 ? `deck ${decks[0]}` : `${decks.length} decks ticked`,
  ].join(' · ');
}

/* ── the budget readout ──────────────────────────────────────────────── */

function renderQuota() {
  if (!isActive()) return;
  const t = store.quotaReport().text;
  const el = $('rd-quota');
  const usage = `text ${t.usedDay}/${t.rpd || '∞'} in 24h`;
  if (t.retryAfter > 0) {
    el.textContent = `waiting ${formatWait(t.retryAfter)} · ${usage}`;
    el.className = 'quota is-bad';
  } else {
    el.textContent = (t.leftDay === null ? 'unlimited' : `${t.leftDay} text call${t.leftDay === 1 ? '' : 's'} left`) + ' · ' + usage;
    el.className = 'quota ' + (t.leftDay !== null && t.leftDay <= 2 ? 'is-bad' : 'is-ok');
  }
  $('rd-new').disabled = busy || t.retryAfter > 0 || !storage.getApiKey();
  renderSpeak();
}

/* Read aloud spends a call on the speech model, whose budget is its own. */
function renderSpeak() {
  const btn = $('rd-speak');
  if (speaking) return;
  const tts = store.quotaReport().tts;
  btn.disabled = !current || !storage.getApiKey() || tts.retryAfter > 0;
  btn.title = `One call on ${tts.model}: speech ${tts.usedDay}/${tts.rpd || '∞'} in 24h`;
  /* Why the button is greyed out is said in the note, not only in a
     tooltip, which a phone never shows. */
  const wait = current && storage.getApiKey() && tts.retryAfter > 0
    ? ` ${tts.model} is out of budget for now: next call in ${formatWait(tts.retryAfter)}.` : '';
  $('rd-speak-note').textContent = speakNote + wait;
}

/* ── writing a text ──────────────────────────────────────────────────── */

async function generate() {
  if (busy) return;
  const cards = pool();
  if (!cards.length) {
    showError(store.practiceCards().length
      ? 'No cards in this scope. Widen the filter, or tick another deck in the Flashcards tab.'
      : 'Add some cards in the Flashcards tab first, or tick a deck that has some.');
    return;
  }
  const n = clampTerms($('rd-terms').value);
  const picked = pickReadingCards(cards, n);
  const request = $('rd-request').value;
  const s = store.state.settings;

  busy = true;
  showError('');
  const btn = $('rd-new');
  btn.innerHTML = '<span class="spinner"></span>Writing';
  btn.disabled = true;
  $('rd-writing').hidden = false;
  $('rd-writing').textContent = `Writing a text around ${picked.length} of your cards with ${s.textModel}. A long text can take a minute.`;

  try {
    const reading = await store.client.writeReading({ cards: picked, request });
    const record = {
      id: nextReadingId(store.state.readings),
      created: new Date().toISOString().slice(0, 10),
      ...reading,
      request,
      items: picked.map((c) => ({
        front: c.front,
        back: c.back,
        alternatives: accepted(c, 'back').slice(1),
        notes: c.notes || '',
        pattern: isPattern(c),
        deck: store.deckOf(c),
      })),
      level: s.learnerLevel,
      language: s.targetLanguage,
      audio: null,
    };
    await show(record);
    if (!(await store.saveReading(record))) {
      showError(`The text is on screen but could not be written to ${storage.label()}. Reconnect the data folder in Settings; it will be lost on reload.`);
    }
  } catch (e) {
    console.error(e);
    showError(describe(e));
  } finally {
    busy = false;
    btn.textContent = 'Write a text';
    $('rd-writing').hidden = true;
    renderQuota();
  }
}

/* ── the list of texts ───────────────────────────────────────────────── */

function renderList() {
  const rows = store.state.readings || [];
  $('rd-list-hint').textContent = rows.length
    ? `${rows.length} text${rows.length === 1 ? '' : 's'} · ${rows.filter((r) => r.audio).length} with audio`
    : 'nothing yet';
  $('rd-list').innerHTML = rows.length
    ? rows.map((r) => `<div class="sh-hist rd-row${current && current.id === r.id ? ' is-open' : ''}" data-reading="${escapeHtml(r.id)}">
        <button class="sh-hist-open" data-act="open">
          <span class="rd-row-head">
            <span class="sh-hist-id rd-row-title">${escapeHtml(r.title || r.id)}</span>
            ${r.audio
              ? '<span class="rd-badge rd-badge--audio">♪ Audio</span>'
              : '<span class="rd-badge">No audio</span>'}
          </span>
          <span class="sh-hist-sub">${[
            r.created, r.decks && r.decks.length ? r.decks.join(', ') : '', `${r.used}/${r.items} cards`, r.level, r.language,
          ].filter(Boolean).map(escapeHtml).join(' · ')}</span>
        </button>
        <button class="btn btn--sm btn--danger" data-act="delete" title="Delete this text${r.audio ? ' and its audio' : ''}">${armed === r.id ? 'Really delete?' : 'Delete'}</button>
      </div>`).join('')
    : '<p class="note">Every text you write is kept here, with its audio once it has been read aloud. Click one to read it again.</p>';
}

async function openReading(id) {
  if (current && current.id === id) {
    $('rd-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  const record = await store.loadReading(id);
  if (!record) {
    showError(`That text could not be read from ${storage.label()}. Its file may have been moved or deleted outside the app.`);
    return;
  }
  showError('');
  await show(record);
  $('rd-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/* Delete asks twice, in place: a text and its audio cost calls to make, and
   a dialog would stop the page. The second press within a few seconds
   deletes; otherwise the button stands down. */
async function remove(id) {
  clearTimeout(disarm);
  if (armed !== id) {
    armed = id;
    renderList();
    disarm = setTimeout(() => { armed = null; renderList(); }, 4000);
    return;
  }
  armed = null;
  if (current && current.id === id) clear();
  await store.deleteReading(id);
}

/* The text on screen went with the store it came from. */
function forgetIfGone() {
  if (current && !store.state.readings.some((r) => r.id === current.id)) clear();
}

function clear() {
  closePop(false);
  current = null;
  verdicts.clear();
  setAudio(null);
  $('rd-card').hidden = true;
  renderList();
}

/* ── the text ────────────────────────────────────────────────────────── */

async function show(record) {
  closePop(false);
  verdicts.clear();
  current = record;
  renderReading();
  renderList();
  await loadAudio();
}

function renderReading() {
  $('rd-card').hidden = false;
  const decks = [...new Set(current.items.map((it) => it.deck))];
  $('rd-meta').innerHTML = [
    escapeHtml(current.model),
    current.level ? escapeHtml(current.level) : '',
    decks.length === 1 ? `deck ${escapeHtml(decks[0])}` : `${decks.length} decks`,
    `${current.used.length} of ${current.items.length} cards used`,
    current.created ? escapeHtml(current.created) : '',
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join('');

  $('rd-title').textContent = current.title;
  $('rd-title').hidden = !current.title;
  const lang = languageCode(current.language);
  $('rd-title').lang = lang;
  const text = $('rd-text');
  text.lang = lang;
  text.innerHTML = current.paragraphs.map((runs) => `<p>${runs.map(runHtml).join('')}</p>`).join('');
  renderSummary();
}

function runHtml(run) {
  const text = escapeHtml(run.text).replace(/\n/g, '<br>');
  if (run.item === undefined) return text;
  const item = current.items[run.item];
  const label = item.pattern ? 'Grammar pattern' : 'Word';
  return `<span class="rd-mark ${item.pattern ? 'rd-mark--pattern' : 'rd-mark--word'}${verdictClass(run.item)}"`
    + ` data-item="${run.item}" role="button" tabindex="0" aria-haspopup="dialog"`
    + ` aria-label="${label}: ${escapeHtml(run.text)}">${text}</span>`;
}

function verdictClass(item) {
  const v = verdicts.get(item);
  return v ? (v.ok ? ' is-ok' : ' is-bad') : '';
}

/* Every mark for one card changes together: it is one card, however many
   times the text uses it. */
function paint(item) {
  const v = verdicts.get(item);
  for (const el of $('rd-text').querySelectorAll(`.rd-mark[data-item="${item}"]`)) {
    el.classList.toggle('is-ok', !!v && v.ok);
    el.classList.toggle('is-bad', !!v && !v.ok);
  }
}

function renderSummary() {
  const right = [...verdicts.values()].filter((v) => v.ok).length;
  const wrong = verdicts.size - right;
  const left = current.used.length - verdicts.size;
  const unused = current.items.filter((_, i) => !current.used.includes(i));
  $('rd-summary').innerHTML = `
    <div>✅ ${right} understood · ❌ ${wrong} not · ${left} still to check</div>
    ${unused.length ? `<div class="note">Not in the text, so not scored: ${unused.map((it) => escapeHtml(it.front)).join(', ')}</div>` : ''}`;
}

/* ── the audio ───────────────────────────────────────────────────────── */

let speaking = false;
/* What the note under Read aloud says about the audio; renderSpeak adds
   the wait to it while the speech model is out of budget. */
let speakNote = '';

async function loadAudio() {
  const blob = await store.readReadingAudio(current);
  setAudio(blob);
}

/* One player, whose source follows the text on screen. The last URL is let
   go first, or every text opened would hold its audio in memory. */
function setAudio(blob) {
  const player = $('rd-audio');
  player.pause();
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
  if (blob) {
    audioUrl = URL.createObjectURL(blob);
    player.src = audioUrl;
  } else {
    player.removeAttribute('src');
    player.load();
  }
  const has = !!blob;
  $('rd-player').hidden = !has;
  /* The same button either way; with audio already there, it says that
     pressing it replaces what is there. Delete audio is offered whenever
     the text names a file, even one that can no longer be read. */
  $('rd-speak').textContent = has ? 'Read aloud again' : 'Read aloud';
  $('rd-unspeak').hidden = !(current && current.audio);
  disarmAudio();
  if (current && current.audio && !has) {
    speakNote = 'This text had audio, but its file could not be read. Read it aloud again to replace it.';
  } else if (has) {
    speakNote = 'Reading it again spends another speech call and replaces this audio once the new one has been saved.';
  } else {
    speakNote = 'One call on the speech model, which has the smallest budget. The audio is kept with the text.';
  }
  if (current && current.audio && has) {
    $('rd-audio-meta').textContent = [current.audio.voice && `voice ${current.audio.voice}`, current.audio.model].filter(Boolean).join(' · ');
  }
  renderSpeak();
}

async function readAloud() {
  if (!current || speaking) return;
  const record = current;
  speaking = true;
  const btn = $('rd-speak');
  btn.disabled = true;
  $('rd-unspeak').disabled = true;
  $('rd-voice').disabled = true;
  btn.innerHTML = '<span class="spinner"></span>Reading aloud';
  $('rd-speak-note').textContent = 'The whole text in one call. A long one can take a minute or two.';
  showError('');
  try {
    const spoken = await store.client.speakReading(speakableText(record), $('rd-voice').value);
    const ok = await store.saveReadingAudio(record, spoken);
    if (!ok) {
      showError(`The audio could not be written to ${storage.label()}. Reconnect the data folder in Settings and read it aloud again.`);
      return;
    }
    if (current === record) setAudio(spoken.blob);
  } catch (e) {
    console.error(e);
    showError(describe(e));
  } finally {
    speaking = false;
    $('rd-unspeak').disabled = false;
    $('rd-voice').disabled = false;
    /* Whatever the call did, the button and note say what is there now. */
    if (current === record) await loadAudio();
    else renderSpeak();
  }
}

/* Asks twice, in place, like Delete in the list: the audio cost a speech
   call. The text stays. */
async function unspeak() {
  if (!current || !current.audio || speaking) return;
  clearTimeout(audioDisarm);
  if (!audioArmed) {
    audioArmed = true;
    $('rd-unspeak').textContent = 'Really delete audio?';
    audioDisarm = setTimeout(disarmAudio, 4000);
    return;
  }
  const record = current;
  disarmAudio();
  const ok = await store.deleteReadingAudio(record);
  if (!ok) showError(`The text could not be written to ${storage.label()}. Reconnect the data folder in Settings.`);
  if (current === record) setAudio(null);
}

function disarmAudio() {
  clearTimeout(audioDisarm);
  audioArmed = false;
  $('rd-unspeak').textContent = 'Delete audio';
}

/* Named after the text's id, which is also its file's name in the folder. */
async function downloadAudio() {
  if (!current || !current.audio) return;
  const blob = await store.readReadingAudio(current);
  if (!blob) { showError('The audio for this text could not be read.'); return; }
  const ext = (/\.(\w+)$/.exec(current.audio.file) || [, 'ogg'])[1];
  storage.download(`${current.id}.${ext}`, blob);
}

/* ── the popup ───────────────────────────────────────────────────────── */

function openPop(item, anchor, byKeyboard) {
  if (!current || !current.items[item]) return;
  openItem = item;
  openAnchor = anchor;
  renderPop();
  pop.hidden = false;
  placeUnder(pop, anchor.getBoundingClientRect());
  if (byKeyboard) {
    /* The question, not the ×, which comes first on the page. */
    (pop.querySelector('.lookup-body [data-act]') || pop.querySelector('[data-act="close"]')).focus();
  }
}

function closePop(returnFocus) {
  if (pop.hidden) return;
  pop.hidden = true;
  if (returnFocus && openAnchor && openAnchor.isConnected) openAnchor.focus();
  openItem = null;
  openAnchor = null;
}

/* The card as it is now, when the deck still has it; otherwise the copy
   taken when the text was written, which can be shown but not scored. */
function liveCard(item) {
  const found = store.findCard(item.front, item.deck);
  return found ? found.card : null;
}

function renderPop() {
  if (openItem === null || !current) return;
  const item = current.items[openItem];
  const card = liveCard(item);
  const shown = card
    ? { front: card.front, back: card.back, alternatives: accepted(card, 'back').slice(1), notes: card.notes || '' }
    : item;
  const v = verdicts.get(openItem);
  const lang = languageCode(current.language);

  const ask = `
    <p class="rd-pop-ask">Did you understand it? Say so before you see the meaning.</p>
    <div class="rd-verdict">
      <button type="button" class="btn" data-act="yes">✅ Understood</button>
      <button type="button" class="btn" data-act="no">❌ Not understood</button>
    </div>`;

  const reveal = v ? `
    <div class="rd-pop-meaning">${escapeHtml(shown.back)}</div>
    ${shown.alternatives.length ? `<div class="rd-pop-alts">also: ${shown.alternatives.map(escapeHtml).join('; ')}</div>` : ''}
    ${shown.notes ? `<div class="rd-pop-notes">${escapeHtml(shown.notes)}</div>` : ''}
    <div class="rd-pop-score">${verdictLine(v, card)}</div>
    ${card ? `<div class="row row--end"><button type="button" class="btn btn--sm" data-act="${v.ok ? 'no' : 'yes'}">${v.ok ? '❌ I had it wrong' : '✅ I had it right'}</button></div>` : ''}`
    : '';

  pop.innerHTML = `
    <div class="lookup-head">
      <span class="lookup-deck">${item.pattern ? 'Grammar pattern · ' : ''}from <b>${escapeHtml(item.deck)}.json</b></span>
      <button type="button" class="lookup-close" data-act="close" aria-label="Close">&times;</button>
    </div>
    <div class="lookup-body">
      <div class="rd-pop-front" lang="${escapeHtml(lang)}">${escapeHtml(shown.front)}</div>
      ${v ? reveal : ask}
    </div>`;
}

function verdictLine(v, card) {
  if (!card) return 'This card is no longer in its deck, so nothing was scored.';
  const said = v.ok ? 'Counted as understood' : 'Counted as not understood';
  const m = v.move;
  const moved = m.before !== m.after
    ? ` · ${scoreMark(m.before)} → ${scoreMark(m.after, SCORE_LABEL[m.after].toLowerCase())}` : '';
  let saved = '';
  if (v.saved === false) saved = ` <span class="is-bad">Could not write ${escapeHtml(store.deckOf(card))}.json. Reconnect the data folder in Settings.</span>`;
  else if (!store.state.persistent) saved = ' · not saved, nothing is being saved';
  return `${said} (${m.correct}/${m.encounters})${moved}${saved}`;
}

/* The first answer for a card is recorded; a second, different one replaces
   it through the amend functions, so the card holds one answer for this text
   either way. `before` stays the score from before the first answer, so the
   move shown is the whole of what this text did to the card. */
async function judge(ok) {
  if (openItem === null || !current) return;
  const index = openItem;
  const item = current.items[index];
  const prev = verdicts.get(index);
  if (prev && prev.ok === ok) return;

  const card = liveCard(item);
  if (!card) {
    verdicts.set(index, { ok, move: null });
    paint(index);
    renderSummary();
    const hadFocus = pop.contains(document.activeElement);
    renderPop();
    if (hadFocus) pop.querySelector('[data-act="close"]').focus();
    return;
  }
  const move = prev && prev.move
    ? { ...(ok ? amendLastToRight(card) : amendLastToWrong(card)), before: prev.move.before }
    : recordResult(card, ok, { typedFront: false });
  const v = { ok, move, saved: null };
  verdicts.set(index, v);
  paint(index);
  renderSummary();
  /* Redrawing takes away the button that had focus. It goes to ×, not to
     the change-of-mind button in the same place, where a second Enter would
     undo the answer just given. */
  const hadFocus = pop.contains(document.activeElement);
  renderPop();
  if (hadFocus) pop.querySelector('[data-act="close"]').focus();

  v.saved = await store.cardAnswered(card);
  if (openItem === index && verdicts.get(index) === v) renderPop();
}

/* ── small helpers ───────────────────────────────────────────────────── */

function showError(text) {
  const el = $('rd-error');
  el.innerHTML = text ? `<div class="banner is-bad">${escapeHtml(text)}</div>` : '';
}
