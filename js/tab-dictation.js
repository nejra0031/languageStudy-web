/* Dictation: hear a sentence, type it back.

   A sentence is written by the text model around two or three of your weakest
   cards, then spoken by the speech model. What comes back is diffed word by
   word, and only the target words move a score — everything else is shown but
   not judged, because the sentence around them was not something you were
   asked to know.

   The target words stay masked until you submit. They are the answer: they are
   the exact strings matched against what you type. Showing them first would
   turn the exercise into copying.

   One sentence is built from one deck, never a mixture. A sentence that
   welded a word from your kitchen deck onto one from your legal deck would be
   a strange thing to hear, and the deck it was built from is written onto the
   entry, so a sentence only ever comes back while its deck is ticked. */

import * as store from './store.js';
import * as storage from './storage.js';
import { isDictatable, isPattern, inScope, pickWeighted, pickGroup, recordResult, SCORE_LABEL } from './deck.js';
import { words, contains, containsLoosely, diff, escapeHtml, scoreMark } from './text.js';
import { formatWait, QuotaError } from './gemini.js';
import { describe } from './tab-settings.js';
import { languageCode } from './speech.js';

const $ = (id) => document.getElementById(id);

let scope = 'all';
let rate = 1;
let current = null;
let audio = null;
let audioUrl = null;
let answered = false;
let busy = false;
const heard = new Set();
let ticker = null;

export function init() {
  $('dc-scope').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn) return;
    scope = btn.dataset.scope;
    setSeg('dc-scope', 'scope', scope);
    store.saveSettings({ dictationScope: scope });
    renderBankInfo();
  });

  $('dc-rate').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-rate]');
    if (!btn) return;
    rate = Number(btn.dataset.rate);
    setSeg('dc-rate', 'rate', String(rate));
    if (audio) audio.playbackRate = rate;
  });

  $('dc-play').addEventListener('click', play);
  $('dc-new').addEventListener('click', generate);
  $('dc-bank-btn').addEventListener('click', fromBank);
  $('dc-check').addEventListener('click', check);
  $('dc-next').addEventListener('click', advance);
  $('dc-download').addEventListener('click', downloadAudio);

  $('dc-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); check(); }
    else if (e.key === 'Enter' && answered) { e.preventDefault(); advance(); }
  });

  document.addEventListener('keydown', (e) => {
    if (!isActive()) return;
    if (e.key === ' ' && e.target.tagName !== 'TEXTAREA' && e.target.tagName !== 'INPUT') {
      e.preventDefault();
      play();
    }
  });

  scope = store.state.settings.dictationScope || 'all';
  setSeg('dc-scope', 'scope', scope);
  setSeg('dc-rate', 'rate', '1');

  store.subscribe('deck', () => {
    renderBankInfo();
    /* Same rule as the typing tab: a sentence from a deck that has just been
       unticked is no longer something to be asked, unless it has already been
       answered and what is on screen is the marking. */
    if (current && !answered && !inBankScope(current)) fromBank();
  });
  store.subscribe('folder', () => { gate(); renderBankInfo(); });
  /* Shadowing writes nothing to the bank, but a restore or a disconnect
     replaces it wholesale, and the counts on screen must follow. */
  store.subscribe('bank', renderBankInfo);
  store.subscribe('settings', renderQuota);
  ticker = setInterval(renderQuota, 1000);
  gate();
}

export function onShow() {
  gate();
  renderBankInfo();
  if (!current && canRun()) {
    if (store.state.manifest.some(inBankScope)) fromBank();
    else idle('Nothing banked for the decks you have ticked. Write the first sentence — it costs one call to each model, and it will be built from one deck and tagged with it.');
  }
}

function isActive() {
  return !document.getElementById('panel-dictation').hidden;
}

function setSeg(id, key, value) {
  for (const b of $(id).querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset[key] === value));
  }
}

/* ── gating ──────────────────────────────────────────────────────────── */

function canRun() {
  return !!storage.getApiKey() || store.state.manifest.length > 0;
}

function gate() {
  const key = storage.getApiKey();
  const banked = store.state.manifest.length;
  const el = $('dc-gate');

  if (!key && !banked) {
    el.innerHTML = `<div class="gate">
      <h3>Add a Gemini API key first</h3>
      <p>Dictation writes and speaks each sentence through the Gemini API, using your own key. Paste one into the Settings tab and this tab comes to life. Sentences you have already made stay playable for free, forever, without a key.</p>
      </div>`;
    $('dc-stage').hidden = true;
    return;
  }

  /* Worded without naming a folder: where there is no store at all, the
     browser has none to offer, and telling the user to connect one would send
     them to a button that is not there. */
  el.innerHTML = !store.state.persistent
    ? `<div class="banner is-warn">Nothing is being saved — a sentence you generate can be played now, but it is gone on reload and will not score your cards. See Settings for what this browser can keep.</div>`
    : '';
  $('dc-stage').hidden = false;
  renderQuota();
}

/* ── pool ────────────────────────────────────────────────────────────── */

/* The ticked decks, kept apart: a sentence is written from one of them, so the
   groups must not be flattened before the deck is chosen. */
function groups() {
  return store.practiceGroups()
    .map((g) => ({ name: g.name, cards: g.cards.filter((c) => isDictatable(c) && inScope(c, scope)) }))
    .filter((g) => g.cards.length);
}

function pool() {
  return groups().flatMap((g) => g.cards);
}

/* Banked sentences from decks that are no longer ticked stay on disk but out
   of rotation. The rule itself lives in the store, because the Shadowing tab
   draws from the same bank and the two must agree about what is in scope. */
const inBankScope = store.bankInScope;

function renderBankInfo() {
  const slips = store.practiceCards().filter((c) => c.accent_slip && isDictatable(c)).length;
  $('dc-scope').querySelector('[data-scope="accents"]').textContent = slips ? `Accents (${slips})` : 'Accents';
  const dictatable = store.practiceCards().filter(isDictatable).length;
  const banked = store.state.manifest.filter(inBankScope).length;
  const decks = store.practiceDecks();
  $('dc-bank').textContent = [
    `${banked} of ${store.state.manifest.length} in bank`,
    `${pool().length} of ${dictatable} usable cards in scope`,
    decks.length === 1 ? `deck ${decks[0]}` : `${decks.length} decks ticked`,
  ].join(' · ');
}

/* ── the budget readout ──────────────────────────────────────────────── */

function renderQuota() {
  if (!isActive() && !ticker) return;
  const q = store.quotaReport();
  const el = $('dc-quota');
  if (!el) return;

  const usage = `text ${q.text.usedDay}/${q.text.rpd || '∞'} · speech ${q.tts.usedDay}/${q.tts.rpd || '∞'} in 24h`;
  if (q.retryAfter > 0) {
    el.textContent = `waiting ${formatWait(q.retryAfter)} · ${usage}`;
    el.className = 'quota is-bad';
  } else {
    const left = q.cardsLeftToday;
    el.textContent = (left === null ? 'unlimited' : `${left} new card${left === 1 ? '' : 's'} left`) + ' · ' + usage;
    el.className = 'quota ' + (left !== null && left <= 2 ? 'is-bad' : 'is-ok');
  }
  /* Replays are free, so only the paid button is ever disabled. */
  $('dc-new').disabled = busy || q.retryAfter > 0 || !storage.getApiKey();
  $('dc-bank-btn').disabled = busy || !store.state.manifest.length;
}

/* ── generating ──────────────────────────────────────────────────────── */

async function generate() {
  if (busy) return;
  const gs = groups();
  if (!gs.length && scope === 'accents') {
    showError('No accent slips to build a sentence around. A word lands in Accents when you type the right word with the wrong accents, and leaves once you type it exactly.');
    return;
  }
  if (!gs.length) {
    showError(store.practiceCards().length
      ? 'No cards in this scope can be used for dictation. Widen the filter, tick another deck in the Flashcards tab, or check the cards themselves — entries like "X vs Y" or "verb + noun" have no single phrase to listen for, so they are skipped.'
      : 'Add some cards in the Flashcards tab first, or tick a deck that has some.');
    return;
  }

  /* One deck, chosen by the same weighting that picks a card, so the decks
     holding your weakest words come up most often. */
  const group = pickGroup(gs);
  const n = Math.min(store.state.settings.termsPerSentence, group.cards.length);
  const terms = pickWeighted(group.cards, n);

  busy = true;
  showError('');
  const btn = $('dc-new');
  btn.innerHTML = '<span class="spinner"></span>Writing &amp; speaking';
  btn.disabled = true;
  $('dc-bank-btn').disabled = true;
  idle(`Writing a sentence around ${terms.length} of your weakest words from ${group.name}, then reading it aloud…`);

  try {
    const { entry, audio: clip, sidecar } = await store.client.generateCard(terms, store.state.manifest, group.name);
    if (store.state.persistent) {
      await storage.writeBlob(entry.file, clip);
      await storage.writeText(entry.text_file, sidecar);
    } else {
      /* Nothing is being saved: keep it playable for this session only. */
      entry.blobUrl = URL.createObjectURL(clip);
    }
    store.state.manifest.push(entry);
    await store.saveManifest();
    heard.add(entry.id);
    renderBankInfo();
    await loadCard(entry);
  } catch (e) {
    console.error(e);
    showError(describe(e));
    if (e instanceof QuotaError) idle('Out of budget for now — pull one from the bank instead, replays are free.');
    else idle('');
  } finally {
    busy = false;
    btn.textContent = 'New sentence';
    renderQuota();
  }
}

function fromBank() {
  const bank = store.state.manifest;
  if (!bank.length) { idle('The bank is empty. Write the first sentence above.'); return; }

  const scoped = bank.filter(inBankScope);
  /* Any banked sentence will do for the wider filters, but Accents means
     these words — better to say none are banked than to play something else. */
  if (scope === 'accents') {
    const wanted = new Set(pool().map((c) => c.front));
    const drills = scoped.filter((e) => (e.terms || []).some((t) => wanted.has(t)));
    if (!drills.length) {
      idle(wanted.size
        ? 'No banked sentence uses your accent-slip words yet. Write a new one to drill them.'
        : 'No accent slips in the ticked decks right now — nothing to drill.');
      return;
    }
    const pick = drills[Math.floor(Math.random() * drills.length)];
    heard.add(pick.id);
    loadCard(pick);
    return;
  }
  if (!scoped.length) {
    idle('Nothing in the bank belongs to the decks you have ticked. Tick the deck those sentences were made from in the Flashcards tab, or write a new sentence above.');
    return;
  }
  let candidates = scoped.filter((e) => !heard.has(e.id));
  if (!candidates.length) {
    /* Been through everything in scope this session; start over rather than
       refusing. */
    heard.clear();
    candidates = scoped;
  }
  /* A sentence you have shadowed is one you have already read in full, so it
     is no longer a blind dictation. Those are kept for when nothing else is
     left rather than dropped — they cost real API calls to make. */
  const unread = candidates.filter((e) => !(e.times_shadowed > 0));
  if (unread.length) candidates = unread;
  const entry = candidates[Math.floor(Math.random() * candidates.length)];
  heard.add(entry.id);
  loadCard(entry);
}

function advance() {
  const banked = store.state.manifest.filter(inBankScope).length;
  if (banked > 1 || !storage.getApiKey()) fromBank();
  else generate();
}

/* ── the card ────────────────────────────────────────────────────────── */

async function loadCard(entry) {
  current = entry;
  answered = false;
  showError('');
  $('dc-idle').hidden = true;
  $('dc-card').hidden = false;

  /* Stop the last sentence before its URL goes, or a load still in flight
     fails against a revoked blob. */
  if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
  if (audioUrl) { URL.revokeObjectURL(audioUrl); audioUrl = null; }
  /* With no server there is no URL to point at — the audio has to be pulled out
     of the folder and turned into a blob URL each time. */
  const src = entry.blobUrl || await storage.readBlobUrl(entry.file);
  if (!entry.blobUrl) audioUrl = src;
  audio = src ? new Audio(src) : null;
  if (audio) audio.playbackRate = rate;
  $('dc-play').disabled = !audio;
  $('dc-download').disabled = !audio;

  const count = (entry.terms || []).length;
  const wordCount = words(entry.sentence).length;
  $('dc-meta').innerHTML = [
    escapeHtml(entry.id),
    `${wordCount} words`,
    entry.deck ? `deck ${escapeHtml(entry.deck)}` : '',
    entry.difficulty ? escapeHtml(entry.difficulty) : '',
    entry.voice ? `voice ${escapeHtml(entry.voice)}` : '',
    entry.language ? escapeHtml(entry.language) : '',
    `played ${entry.times_practiced || 0}×`,
    entry.times_shadowed ? `shadowed ${entry.times_shadowed}×` : '',
  ].filter(Boolean).map((s) => `<span>${s}</span>`).join('');

  $('dc-terms').innerHTML = count
    ? Array(count).fill('<span class="chip chip--masked">•••</span>').join('')
      + `<span class="chip-count">${count} word${count === 1 ? '' : 's'} graded</span>`
    : '<span class="chip-count">no target words on this card</span>';

  const input = $('dc-input');
  input.lang = languageCode(entry.language || store.state.settings.targetLanguage);
  input.value = '';
  input.disabled = false;
  $('dc-check').hidden = false;
  $('dc-check').disabled = false;
  $('dc-next').hidden = true;
  $('dc-result').hidden = true;
  input.focus();

  if (!audio) showError('The audio file for this sentence is missing from the sentence bank.');
  else play();
}

/* The sentence's audio as a file, named by its bank id. The transcript is not
   bundled with it: that is the answer, and it is on screen once you have
   checked. */
async function downloadAudio() {
  if (!current) return;
  const blob = current.blobUrl
    ? await fetch(current.blobUrl).then((r) => r.blob()).catch(() => null)
    : await storage.readBlob(current.file);
  if (!blob) { showError('The audio for this sentence could not be read.'); return; }
  /* Named after what is in the file: older sentences are WAV, newer Ogg. */
  const ext = (/\.(\w+)$/.exec(current.file || '') || [, 'wav'])[1];
  storage.download(`${current.id}.${ext}`, blob);
}

function play() {
  if (!audio) return;
  audio.currentTime = 0;
  audio.playbackRate = rate;
  audio.play().catch(() => { /* autoplay refused until the user clicks */ });
}

/* ── checking ────────────────────────────────────────────────────────── */

function check() {
  if (answered || !current) return;
  const typed = $('dc-input').value.trim();
  if (!typed) { $('dc-input').focus(); return; }
  answered = true;

  const refWords = words(current.sentence);
  const usrWords = words(typed);
  const d = diff(refWords, usrWords);

  $('dc-input').disabled = true;
  $('dc-check').hidden = true;
  $('dc-next').hidden = false;
  $('dc-next').focus();

  const scored = scoreTerms(usrWords);

  let verdictClass = 'is-bad';
  let verdictText;
  if (!d.accent && !d.missing && !d.extra) {
    verdictClass = 'is-ok';
    verdictText = 'Word perfect';
  } else if (!d.missing && !d.extra) {
    verdictClass = 'is-warn';
    verdictText = `Every word heard, ${d.accent} with the wrong accents`;
  } else {
    const bits = [];
    if (d.accent) bits.push(`${d.accent} wrong accents`);
    if (d.missing) bits.push(`${d.missing} missed`);
    if (d.extra) bits.push(`${d.extra} extra`);
    verdictText = `${d.ok}/${refWords.length} words exact — ${bits.join(', ')}`;
  }

  $('dc-result').hidden = false;
  $('dc-result').innerHTML = `
    <div class="verdict ${verdictClass}">${verdictText}</div>
    <div class="diff" style="margin-top:10px">${d.tokens.map(token).join(' ')}</div>
    <div class="legend" style="margin-top:8px">
      <span><i class="w w-accent">word</i> wrong accent</span>
      <span><i class="w w-missing">word</i> not typed</span>
      <span><i class="w w-extra">word</i> not in the sentence</span>
    </div>
    <div class="notes-box" style="margin-top:12px">
      <div>${escapeHtml(current.sentence)}</div>
      ${current.english ? `<div style="margin-top:6px;color:var(--fg-dim)">${escapeHtml(current.english)}</div>` : ''}
    </div>
    ${scored}`;

  markPractised();
}

function token({ kind, text }) {
  const cls = { ok: '', accent: 'w-accent', missing: 'w-missing', extra: 'w-extra' }[kind];
  return `<span class="w ${cls}">${escapeHtml(text)}</span>`;
}

/* Per-term, not per-sentence. A target word counts only if it appears exactly
   as written, accents and all. A word the sentence writer silently dropped is
   skipped — scoring it wrong would punish the learner for the model. */
function scoreTerms(usrWords) {
  const refWords = words(current.sentence);
  const chips = [];
  const rows = [];
  const changed = [];

  for (const termText of current.terms || []) {
    const found = store.findCard(termText, current.deck);
    const card = found && found.card;
    if (!card) {
      chips.push(`<span class="chip">${escapeHtml(termText)}</span>`);
      rows.push(`<div>${escapeHtml(termText)} — no longer in the deck, not scored</div>`);
      continue;
    }
    const pattern = isPattern(card);
    if (!contains(refWords, card.front, pattern)) {
      chips.push(`<span class="chip">${escapeHtml(card.front)}</span>`);
      rows.push(`<div>${escapeHtml(card.front)} — the sentence never used it, not scored</div>`);
      continue;
    }

    const ok = contains(usrWords, card.front, pattern);
    /* Heard but mis-accented is the same near miss the Typing tab flags, and
       it belongs on the same list. */
    const accentSlip = !ok && containsLoosely(usrWords, card.front, pattern);
    chips.push(`<span class="chip ${ok ? 'chip--ok' : 'chip--bad'}">${escapeHtml(card.front)}</span>`);
    const move = recordResult(card, ok, { accentSlip });
    changed.push(card);
    const moved = move.before !== move.after
      ? ` ${scoreMark(move.before)} → ${scoreMark(move.after, SCORE_LABEL[move.after].toLowerCase())}` : '';
    rows.push(`<div>${ok ? '✓' : '✗'} ${escapeHtml(card.front)}${accentSlip ? ' — right word, wrong accents' : ''} (${move.correct}/${move.encounters})${moved}</div>`);
  }

  $('dc-terms').innerHTML = chips.join('');
  if (changed.length) store.cardAnswered(...changed);

  return rows.length
    ? `<div class="notes-box" style="margin-top:12px"><strong>Scored</strong>${rows.join('')}</div>`
    : '';
}

function markPractised() {
  return store.markPractised(current);
}

/* ── small helpers ───────────────────────────────────────────────────── */

function showError(text) {
  const el = $('dc-error');
  el.innerHTML = text ? `<div class="banner is-bad">${escapeHtml(text)}</div>` : '';
}

function idle(text) {
  const el = $('dc-idle');
  if (!text) { el.hidden = true; return; }
  $('dc-card').hidden = true;
  el.hidden = false;
  el.innerHTML = `<p>${escapeHtml(text)}</p>`;
}
