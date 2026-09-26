/* Typing practice: one side shown, the other typed.

   An answer is right only if the accents are right — that is the whole skill
   being drilled. But "right word, wrong accents" is a different mistake from
   "wrong word", and a learner needs to be told which one they made, so the
   near miss gets its own verdict, the offending characters are marked, and the
   card is flagged for the Accents filter until it is typed exactly.

   Meanings are looser than words: there is more than one fair way to say
   something in English. So a meaning is right if it matches the back or any of
   the card's alternatives, and a miss can be accepted on the spot — which
   records it as an alternative and turns the answer right.

   With Read aloud on, a word that is the prompt is heard rather than read: it
   stays hidden until you ask to see it, or until you answer. */

import * as store from './store.js';
import {
  pickWeighted, inScope, recordResult, amendLastToRight, addAlternative, setAlternatives, meanings,
  stats, SCORE_LABEL,
} from './deck.js';
import * as speech from './speech.js';
import { compareAnswer, compareMeaning, normalize, words, base, diff, accentMarks, escapeHtml, scoreMark } from './text.js';

const $ = (id) => document.getElementById(id);

let scope = 'all';
let current = null;
let shownSide = 'front';
let answered = false;
let previous = null;
/* The card just answered. It becomes "Last card" only once you move on —
   while it is still on screen, its own feedback already says everything. */
let justAnswered = null;
/* The answer just checked, kept so it can still be accepted. */
let last = null;
const tally = { total: 0, right: 0, wrong: 0 };

export function init() {
  scope = store.state.settings.typingScope || 'all';
  setSeg('ty-scope', 'scope', scope);
  setSeg('ty-dir', 'dir', store.state.settings.typingDirection);

  $('ty-scope').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn) return;
    scope = btn.dataset.scope;
    setSeg('ty-scope', 'scope', scope);
    store.saveSettings({ typingScope: scope });
    next();
  });

  $('ty-dir').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-dir]');
    if (!btn) return;
    setSeg('ty-dir', 'dir', btn.dataset.dir);
    store.saveSettings({ typingDirection: btn.dataset.dir });
    next();
  });

  $('ty-speak').addEventListener('click', () => {
    const on = !store.state.settings.typingSpeak;
    store.saveSettings({ typingSpeak: on });
    /* No sound from here on, so a hidden word has to be shown. */
    if (!on) { speech.stop(); showWord(); }
    renderSpeak();
  });
  store.subscribe('settings', renderSpeak);
  speech.onVoicesChanged(renderSpeak);
  speech.onSpoken(renderVoiceNote);
  wireSpeechPanel();
  renderSpeak();

  /* The card is redrawn for every draw and its feedback for every answer, so
     the buttons inside it are handled here, once, rather than rebound each
     time something is rendered. */
  $('ty-card').addEventListener('click', (e) => {
    const hit = (sel) => e.target.closest(sel);
    if (hit('[data-say]')) say(true);
    else if (hit('#ty-accept')) acceptAnswer();
    else if (hit('#ty-notes-edit') || hit('#ty-fix-meaning')) renderNotes(true);
    else if (hit('#ty-notes-save')) saveNotes();
    else if (hit('#ty-notes-cancel')) renderNotes(false);
  });
  $('ty-card').addEventListener('keydown', (e) => {
    if (!e.target.closest('.card-edit')) return;
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveNotes(); }
    else if (e.key === 'Escape') { e.preventDefault(); renderNotes(false); }
  });

  /* Redrawn when the pool changes under it: a card whose deck has just been
     unticked, or which was edited out of the deck file, must not stay on
     screen as the thing being asked. An answered card stays put — the
     feedback on it is about what has already happened, and saving that answer
     is itself what fired this. */
  store.subscribe('deck', () => {
    renderPool();
    if (!current || (!answered && !pool().includes(current))) next();
  });
  store.subscribe('ready', () => next());
  next();
}

export function onShow() {
  const input = $('ty-input');
  if (input && !input.disabled) input.focus();
  /* A card drawn while another tab was open was not read aloud then. */
  if (current && !answered && shownSide === 'front') say();
}

function setSeg(id, key, value) {
  for (const b of $(id).querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset[key] === value));
  }
}

/* Every ticked deck at once — the Flashcards tab decides which those are. */
function pool() {
  return store.practiceCards().filter((c) => inScope(c, scope));
}

function renderPool() {
  const all = store.practiceCards();
  const decks = store.practiceDecks();
  $('ty-pool').textContent = `${pool().length} of ${all.length} cards in scope · `
    + (decks.length === 1 ? `deck ${decks[0]}` : `${decks.length} decks ticked`);
  const slips = all.filter((c) => c.accent_slip).length;
  $('ty-scope').querySelector('[data-scope="accents"]').textContent = slips ? `Accents (${slips})` : 'Accents';
}

/* ── the card ────────────────────────────────────────────────────────── */

function next() {
  /* A skipped card has no answer to look back on, so it never replaces the
     last one that did. */
  if (justAnswered) { previous = justAnswered; justAnswered = null; }
  /* Until boot has found the stored decks, the only cards in memory are the
     starter deck's. Drawing one would put a word from a deck the user may
     have deleted on screen, and read it aloud; wait instead. */
  if (!store.state.ready) {
    current = null;
    $('ty-card').innerHTML = '<div class="gate"><p>Loading your cards…</p></div>';
    return;
  }
  renderPool();
  const p = pool();
  if (!p.length) {
    current = null;
    $('ty-card').innerHTML = emptyState();
    return;
  }

  current = pickWeighted(p, 1)[0];
  answered = false;
  last = null;
  const dir = store.state.settings.typingDirection;
  /* Accents live on the front, so that is always the side asked for when
     drilling them, whatever the direction setting says. */
  shownSide = scope === 'accents' ? 'back'
    : dir === 'random' ? (Math.random() < 0.5 ? 'front' : 'back') : (dir === 'back-to-front' ? 'back' : 'front');

  const shown = current[shownSide];
  const code = targetCode();
  /* With Read aloud on, a word that is the prompt is heard, not read: it is
     hidden until you choose to see it, or until you answer. Only when it can
     actually be heard — with no voice, hiding it would leave nothing to go on. */
  const listening = shownSide === 'front' && store.state.settings.typingSpeak && speech.canSpeak(code);
  const askFor = shownSide === 'front' ? 'the meaning' : store.state.settings.targetLanguage;
  const { encounters, correct } = stats(current);

  $('ty-card').innerHTML = `
    <div class="card">
      <div class="card-meta">
        <span class="score-chip"><i class="score-dot s-${current.score}"></i>${SCORE_LABEL[current.score]}</span>
        <span>${correct}/${encounters || 0} recent</span>
        ${squares(current.recent)}
        ${current.accent_slip ? '<span class="is-warn">accents slipped last time</span>' : ''}
        <span class="spacer"></span>
        ${store.practiceDecks().length > 1 ? `<span>${escapeHtml(store.deckOf(current))}</span>` : ''}
        <span>${current.last_seen ? 'last seen ' + current.last_seen : 'new card'}</span>
      </div>
      <div class="card-body">
        <div class="prompt-label">${shownSide === 'front' ? escapeHtml(store.state.settings.targetLanguage) : 'Meaning'}</div>
        <div class="prompt" id="ty-prompt" lang="${shownSide === 'front' ? code : 'en'}" ${listening ? 'hidden' : ''}>${escapeHtml(shown)}</div>
        ${listening ? `<input type="text" class="answer-input" id="ty-hear" lang="${code}" placeholder="Type what you hear"
          aria-label="Type what you hear" autocomplete="off" autocapitalize="off" spellcheck="false">` : ''}
        ${shownSide === 'front' ? `<div class="row" style="margin-top:8px">
          <button class="btn btn--sm" data-say>Listen again</button>
          ${listening ? '<button class="btn btn--sm" id="ty-hear-btn"></button>' : ''}
          <span class="note voice-note"></span>
        </div>` : ''}
        ${listening ? '<div id="ty-heard" style="margin-top:12px" hidden></div>' : ''}
        <label class="field" style="margin-top:24px">
          <span id="ty-ask">Type ${escapeHtml(askFor)}</span>
          <input type="text" class="answer-input" id="ty-input" lang="${shownSide === 'front' ? 'en' : code}" autocomplete="off" autocapitalize="off" spellcheck="false">
        </label>
        <div class="row" style="margin-top:12px">
          <button class="btn btn--primary" id="ty-check"></button>
          <button class="btn btn--primary" id="ty-next" hidden>Next card</button>
          <button class="btn" id="ty-skip" title="Moves on without counting anything">Skip</button>
        </div>
        <div id="ty-feedback" style="margin-top:16px"></div>
      </div>
    </div>`;

  /* One button, two jobs, decided by whether anything has been typed: with
     an empty box there is nothing to check, so it offers the answer; the
     moment there is something, it checks it. Two buttons side by side meant
     a stray click on Show answer threw away an answer that could have been
     marked. */
  $('ty-check').addEventListener('click', () => ($('ty-input').value.trim() ? check() : reveal()));
  $('ty-next').addEventListener('click', next);
  $('ty-skip').addEventListener('click', next);
  const input = $('ty-input');
  input.addEventListener('input', renderCheck);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    /* Enter never gives up on a card: a second Enter after Next would land
       on the new, empty box and count a miss nobody meant. */
    if (answered) next(); else if (input.value.trim()) check();
  });
  renderCheck();
  if (listening) wireHear(); else input.focus();
  renderPrevious();
  /* The word is on screen, so hear it now. When it is the answer it waits
     until the answer is in — see settle(). */
  if (shownSide === 'front') say();
}

/* Uncover a word hidden for listening. Harmless when nothing is hidden. */
function showWord() {
  const word = $('ty-prompt');
  if (!word || !word.hidden) return;
  word.hidden = false;
  /* Once the word is visible, transcribing it would be copying. */
  document.getElementById('ty-hear')?.remove();
  document.getElementById('ty-hear-btn')?.remove();
}

function emptyState() {
  const total = store.practiceCards().length;
  const decks = store.practiceDecks();
  const where = decks.length === 1 ? `the ticked deck (${escapeHtml(decks[0])})` : `the ${decks.length} ticked decks`;
  if (!total) {
    return `<div class="gate"><h3>No cards yet</h3>
      <p>There is nothing in ${where}. Add cards in the Flashcards tab — it is a plain JSON list, and there is a three-card example already in it to copy the shape from — or tick another deck in the deck menu there.</p></div>`;
  }
  if (scope === 'accents') {
    return `<div class="gate"><h3>No accent slips</h3>
      <p>A word lands here when you type it with the right letters but the wrong accents, and leaves once you type it exactly. Nothing in ${where} is waiting right now.</p></div>`;
  }
  return `<div class="gate"><h3>Nothing in scope</h3>
    <p>All ${total} cards in ${where} are stronger than this filter allows. Widen it to <strong>All</strong>, tick another deck in the Flashcards tab, or practise more to move cards down.</p></div>`;
}

function squares(recent) {
  const list = Array.isArray(recent) ? recent : [];
  const pad = Array(Math.max(0, 8 - list.length)).fill(null);
  return '<span class="sq-row">' + [...pad, ...list]
    .map((r) => `<i class="sq ${r === null ? 'sq--empty' : r ? 'sq--hit' : 'sq--miss'}"></i>`)
    .join('') + '</span>';
}

/* ── speech ──────────────────────────────────────────────────────────── */

function targetCode() {
  return speech.languageCode(store.state.settings.targetLanguage);
}

/* Reads the current card's word. `asked` is a click on Listen again, which
   plays even with Read aloud turned off. Bracketed notes are not read out. */
function say(asked = false) {
  if (!current || (!asked && !store.state.settings.typingSpeak)) return;
  /* Cards are drawn in the background too — on load, or when the ticked decks
     change from another tab. Only speak to someone looking at this one. */
  if ($('panel-typing').hidden) return;
  const s = store.state.settings;
  speech.speak(current.front.replace(/\([^)]*\)/g, ' '), targetCode(), { voice: s.speechVoice, rate: s.speechRate });
}

/* A speaker with sound waves when on, struck through when off. Drawn in
   currentColor so it follows the button's pressed and theme colours. */
const SPEAKER = (on) => `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="none"
  stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M11 5 6 9H3v6h3l5 4z" fill="currentColor"/>
  ${on ? '<path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>'
    : '<path d="m16 9 6 6"/><path d="m22 9-6 6"/>'}</svg>`;

/* Voice and speed, next to the speaker — the same two settings as in the
   Settings tab, where the voice first lived, brought to where the listening
   happens. A voice that is too fast is found out mid-practice, not while
   looking at Settings. */
function wireSpeechPanel() {
  const btn = $('ty-speech-opts');
  const panel = $('ty-speech-panel');
  const rate = $('ty-rate');
  Object.assign(rate, { min: speech.RATE.min, max: speech.RATE.max, step: speech.RATE.step });

  const open = (on) => {
    panel.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    btn.setAttribute('aria-pressed', String(on));
    if (on) $('ty-voice').focus();
  };
  btn.addEventListener('click', () => open(panel.hidden));
  /* Close on a click anywhere else, or Esc — it is a popover, not a page. */
  document.addEventListener('click', (e) => {
    if (!panel.hidden && !e.target.closest('.speech-ctl')) open(false);
  });
  panel.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); open(false); btn.focus(); }
  });

  $('ty-voice').addEventListener('change', (e) => store.saveSettings({ speechVoice: e.target.value }));
  rate.addEventListener('input', () => { $('ty-rate-val').textContent = speech.rateLabel(rate.value); });
  rate.addEventListener('change', () => store.saveSettings({ speechRate: speech.clampRate(rate.value) }));
  /* The sample is the card on screen, if there is one — but only once its
     word is showing, so the panel cannot be used to peek at a hidden answer. */
  $('ty-speech-test').addEventListener('click', () => {
    const s = store.state.settings;
    const visible = current && (answered || shownSide === 'front');
    const text = visible ? current.front.replace(/\([^)]*\)/g, ' ') : 'Xin chào';
    speech.speak(text, targetCode(), { voice: s.speechVoice, rate: s.speechRate });
  });
}

/* Beside Listen again: which voice read the word, and whether it came from a
   saved clip (free), was fetched just now (and saved), or was the device's.
   When autoplay was refused, Listen again is lit up and the note says why. */
function renderVoiceNote({ voice, source, blocked }) {
  if ($('panel-typing').hidden) return;
  const text = blocked ? `${voice} · blocked by the browser — press Listen again`
    : source === 'saved' ? `${voice} · saved clip`
    : source === 'fetched' ? `${voice} · new, now saved`
    : `${voice} · device voice`;
  for (const el of document.querySelectorAll('#ty-card .voice-note')) el.textContent = text;
  for (const btn of document.querySelectorAll('#ty-card [data-say]')) btn.classList.toggle('btn--primary', !!blocked);
}

function renderSpeak() {
  const btn = $('ty-speak');
  const lang = store.state.settings.targetLanguage || 'this language';
  const voice = speech.canSpeak(targetCode());
  btn.disabled = !voice;
  const on = voice && !!store.state.settings.typingSpeak;
  btn.setAttribute('aria-pressed', String(on));
  btn.innerHTML = SPEAKER(on);
  btn.title = voice
    ? `Read aloud: ${on ? 'on' : 'off'}. When the word is the prompt it is hidden, so you listen first — Show word uncovers it.`
    : `No ${lang} voice is installed. On a Mac: System Settings → Accessibility → Spoken Content → System voice → Manage Voices.`;
  for (const hear of document.querySelectorAll('#ty-card [data-say]')) hear.disabled = !voice;

  /* Keep the panel in step with Settings, which can change the same two. */
  const s = store.state.settings;
  $('ty-speech-opts').disabled = !voice;
  $('ty-voice').innerHTML = speech.voiceOptions(targetCode(), s.speechVoice || '');
  $('ty-voice').value = s.speechVoice || '';
  const rate = $('ty-rate');
  if (document.activeElement !== rate) rate.value = speech.clampRate(s.speechRate);
  $('ty-rate-val').textContent = speech.rateLabel(rate.value);
}

/* ── checking ────────────────────────────────────────────────────────── */

function check() {
  if (answered || !current) return;
  const input = $('ty-input');
  const typed = input.value.trim();
  if (!typed) { input.focus(); return; }

  /* A transcription typed but never checked is not thrown away. */
  const hear = document.getElementById('ty-hear');
  if (hear && hear.value.trim()) checkHeard();

  answered = true;
  const expected = shownSide === 'front' ? current.back : current.front;
  const verdict = shownSide === 'front'
    ? bestVerdict(typed, meanings(current))
    : compareAnswer(typed, expected);
  const ok = verdict === 'exact';

  /* Only a slip in the language being learnt counts: an accent missed while
     typing the English meaning is not what this list is for. */
  const accentSlip = verdict === 'accent' && shownSide === 'back';
  const slipBefore = !!current.accent_slip;
  const move = recordResult(current, ok, { accentSlip, typedFront: shownSide === 'back' });
  tally.total++;
  if (ok) tally.right++; else tally.wrong++;
  renderTally();

  settle(ok);

  $('ty-feedback').innerHTML = feedback(verdict, typed, expected, move);
  last = { typed, expected, before: move.before, slipBefore };
  justAnswered = { shown: current[shownSide], expected, typed, verdict, notes: current.notes, words: wordMarks(verdict, typed, expected) };
  store.cardAnswered(current);
}

/* Not knowing is a miss — it is recorded like any wrong answer, so the card
   keeps coming back. Skip is the way past a card without a verdict. */
function reveal() {
  if (answered || !current) return;
  answered = true;
  const expected = shownSide === 'front' ? current.back : current.front;
  const move = recordResult(current, false, { typedFront: shownSide === 'back' });
  tally.total++;
  tally.wrong++;
  renderTally();
  settle(false);
  $('ty-feedback').innerHTML = feedback('revealed', '', expected, move);
  last = null;
  justAnswered = { shown: current[shownSide], expected, typed: '', verdict: 'revealed', notes: current.notes };
  store.cardAnswered(current);
}

function renderTally() {
  $('ty-total').textContent = tally.total;
  $('ty-right').textContent = tally.right;
  $('ty-wrong').textContent = tally.wrong;
}

function renderCheck() {
  const btn = $('ty-check');
  const typed = !!$('ty-input').value.trim();
  btn.textContent = typed ? 'Check' : 'Show answer';
  btn.title = typed ? 'Marks what you typed' : 'Shows the answer and counts it as a miss';
}

/* Lock the card once it has a verdict, and hand the keyboard to Next. */
function settle(ok) {
  const input = $('ty-input');
  input.disabled = true;
  input.className = 'answer-input ' + (ok ? 'is-ok' : 'is-bad');
  $('ty-check').hidden = true;
  $('ty-skip').hidden = true;
  const nextBtn = $('ty-next');
  nextBtn.hidden = false;
  nextBtn.focus();
  /* Read the word if it was the answer, since it has not been heard yet. */
  if (shownSide === 'back') say();
  showWord();
}

/* The best of the verdicts against every accepted meaning. */
function bestVerdict(typed, options) {
  const verdicts = options.map((m) => compareMeaning(typed, m));
  return verdicts.includes('exact') ? 'exact' : verdicts.includes('accent') ? 'accent' : 'wrong';
}

/* Two ways to overrule a miss. A meaning is saved as an alternative, since
   English has many fair renderings and the same one will come up again. A
   word in the language being learnt is only counted right, this once: the
   card keeps the form it was written with, and nothing is added to it. */
function acceptAnswer() {
  if (!last || !current) return;
  const meaning = shownSide === 'front';
  if (meaning) addAlternative(current, last.typed, (a, b) => compareMeaning(a, b) === 'exact');
  const move = { ...amendLastToRight(current), before: last.before };
  /* Marked right, this answer's accents were not a slip after all — but a
     flag from an earlier miss is left for a real exact answer to clear. */
  if (!meaning && !last.slipBefore) delete current.accent_slip;
  tally.right++;
  tally.wrong--;
  renderTally();
  $('ty-input').className = 'answer-input is-ok';
  $('ty-feedback').innerHTML = feedback(meaning ? 'accepted' : 'marked', last.typed, last.expected, move);
  if (justAnswered) justAnswered.verdict = 'exact';
  last = null;
  $('ty-next').focus();
  store.cardAnswered(current);
}

function feedback(verdict, typed, expected, move) {
  const moved = move.before !== move.after
    ? ` <span class="typed-back">${scoreMark(move.before)} → ${scoreMark(move.after, SCORE_LABEL[move.after].toLowerCase())}</span>`
    : '';

  /* Drawn even with no alternatives, hidden, so that an edit which adds some
     has a place to show them. */
  const alts = shownSide === 'front'
    ? `<div class="typed-back ty-alts" style="margin-top:6px"${altsText() ? '' : ' hidden'}>${escapeHtml(altsText())}</div>` : '';
  const acceptBtn = shownSide === 'front'
    ? `<div class="row" style="margin-top:10px"><button class="btn btn--sm" id="ty-accept">Accept my answer</button>
       <button class="btn btn--sm" id="ty-fix-meaning">Change the meaning</button>
       <span class="note">Accept keeps the card's meaning and adds yours beside it; change it if the card's is wrong.</span></div>`
    : `<div class="row" style="margin-top:10px"><button class="btn btn--sm" id="ty-accept">Mark as right</button>
       <span class="note">Counts it as right this time. Nothing is saved to the card.</span></div>`;

  let head;
  if (verdict === 'revealed') {
    head = `<div class="verdict is-bad">Answer <span class="reveal">${escapeHtml(expected)}</span>${moved}</div>${alts}`;
  } else if (verdict === 'marked') {
    head = `<div class="verdict is-ok">Marked right${moved}</div>
      <div class="typed-back" style="margin-top:6px">you typed <strong>${escapeHtml(typed)}</strong> · the card says <strong>${escapeHtml(expected)}</strong></div>`;
  } else if (verdict === 'accepted') {
    head = `<div class="verdict is-ok">Accepted${moved}</div>
      <div class="typed-back" style="margin-top:6px">“${escapeHtml(typed)}” is now saved as another meaning, beside <strong>${escapeHtml(expected)}</strong></div>`;
  } else if (verdict === 'exact') {
    /* Right by one part of a longer meaning: show the whole of it, since the
       rest is worth reading too. */
    const whole = normalize(typed) !== normalize(expected)
      ? ` <span class="reveal">${escapeHtml(expected)}</span>` : '';
    head = `<div class="verdict is-ok">Correct${whole}${moved}</div>`;
  } else if (verdict === 'accent') {
    /* The word was there. Show precisely which marks went astray. */
    head = `<div class="verdict is-warn">Right word, wrong accents
      <span class="reveal">${escapeHtml(expected)}</span>${moved}</div>
      <div class="typed-back" style="margin-top:6px">you typed ${markAccents(typed, expected)}</div>${alts}${acceptBtn}`;
  } else {
    const marks = wordMarks(verdict, typed, expected);
    head = `<div class="verdict is-bad">Not quite
      <span class="reveal">${escapeHtml(expected)}</span>${moved}</div>
      <div class="typed-back" style="margin-top:6px">you typed ${marks || `<s>${escapeHtml(typed)}</s>`}</div>${marks ? WORD_LEGEND : ''}${alts}${acceptBtn}`;
  }

  /* When the word was the answer it has only just appeared — in the verdict
     above — so that is where its Listen again goes, not by the English prompt. */
  const hear = shownSide === 'back'
    ? `<div class="row" style="margin-top:8px"><button class="btn btn--sm" data-say>Listen again</button>
       <span class="note voice-note"></span></div>` : '';
  return head + hear + `<div id="ty-notes-area" style="margin-top:12px">${notesHtml(false)}</div>`;
}

/* ── notes ───────────────────────────────────────────────────────────── */

/* The card can be edited once it has been answered or revealed — before
   that, any of it would give the answer away. Word, meaning, alternatives
   and notes together: cards are often written by a machine from someone's
   notes, and a meaning that makes no sense is found out mid-practice, which
   is where it should be fixable. So is an alternative accepted by mistake. Saved straight into the deck the card came from,
   exactly as if typed into the Flashcards tab. */
function notesHtml(editing) {
  if (editing) {
    const lang = targetCode();
    const alts = current.alternatives || [];
    return `<div class="card-edit">
      <label class="field"><span>${escapeHtml(store.state.settings.targetLanguage || 'Word')}</span>
        <input type="text" id="ty-edit-front" lang="${lang}" spellcheck="false" autocomplete="off" value="${escapeHtml(current.front)}"></label>
      <label class="field"><span>Meaning</span>
        <input type="text" id="ty-edit-back" lang="en" spellcheck="false" autocomplete="off" value="${escapeHtml(current.back)}"></label>
      <label class="field"><span>Also accepted, one per line</span>
        <textarea id="ty-edit-alts" class="notes-edit" lang="en" rows="${Math.max(2, alts.length + 1)}" spellcheck="false">${escapeHtml(alts.join('\n'))}</textarea></label>
      <label class="field"><span>Notes</span>
        <textarea id="ty-notes-input" class="notes-edit" rows="3" spellcheck="false">${escapeHtml(current.notes || '')}</textarea></label>
      <div class="row" style="margin-top:8px">
        <button class="btn btn--sm btn--primary" id="ty-notes-save">Save card</button>
        <button class="btn btn--sm" id="ty-notes-cancel">Cancel</button>
        <span class="note" id="ty-edit-note">⌘ / Ctrl + Enter to save · Esc to cancel</span>
      </div></div>`;
  }
  const box = current.notes
    ? `<div class="notes-box">${escapeHtml(current.notes)}</div>` : '';
  return `${box}<div class="row" style="margin-top:8px">
    <button class="btn btn--sm" id="ty-notes-edit">Edit card</button></div>`;
}

function renderNotes(editing) {
  const area = $('ty-notes-area');
  if (!area) return;
  area.innerHTML = notesHtml(editing);
  if (editing) {
    const box = $('ty-edit-back');
    box.focus();
    box.selectionStart = box.selectionEnd = box.value.length;
  } else {
    $('ty-next').focus();
  }
}

async function saveNotes() {
  const box = $('ty-notes-input');
  if (!box || !current) return;
  const front = $('ty-edit-front').value.trim();
  const back = $('ty-edit-back').value.trim();
  /* The same rule as the deck file: a card needs both sides. */
  if (!front || !back) {
    const note = $('ty-edit-note');
    note.textContent = 'A card needs both the word and its meaning.';
    note.style.color = 'var(--bad)';
    return;
  }
  const text = box.value.trim();
  current.front = front;
  current.back = back;
  /* One per line, since a meaning may itself hold a comma. Matched the way
     Accept matches, so a line that only restates the meaning is dropped. */
  setAlternatives(current, $('ty-edit-alts').value.split('\n'),
    (a, b) => compareMeaning(a, b) === 'exact');
  if (text) current.notes = text;
  else delete current.notes;

  /* Everything on screen that quoted the old card follows it: the prompt,
     the answer an Accept would be judged against, and Last card's copy. */
  const prompt = document.getElementById('ty-prompt');
  if (prompt) prompt.textContent = current[shownSide];
  const expected = shownSide === 'front' ? current.back : current.front;
  for (const el of document.querySelectorAll('#ty-feedback .verdict .reveal')) el.textContent = expected;
  for (const el of document.querySelectorAll('#ty-feedback .ty-alts')) {
    el.textContent = altsText();
    el.hidden = !el.textContent;
  }
  if (last) last.expected = expected;
  if (justAnswered) Object.assign(justAnswered, { shown: current[shownSide], expected, notes: current.notes });
  renderNotes(false);
  /* Written back to this card's own deck, which in a multi-deck session is
     rarely the one open in the editor. */
  await store.saveCardDecks(current);
}

function altsText() {
  const alts = current.alternatives || [];
  return alts.length ? `also accepted: ${alts.join(' · ')}` : '';
}

function markAccents(typed, expected) {
  return accentMarks(typed, expected)
    .map(({ ch, bad }) => (bad ? `<span class="ch-bad">${escapeHtml(ch)}</span>` : escapeHtml(ch)))
    .join('');
}

/* A wrong answer in the language being learnt, marked word by word the way
   Dictation marks a sentence — so "có tải có đẹp" for "có tài có sắc" shows
   two words right, one with the wrong accent and one that is not the word,
   rather than striking out the lot. Only when something in it matched:
   marking every word of an unrelated answer wrong says nothing a strike-
   through does not. Meanings are not marked this way; they are matched by
   parts and alternatives, not word by word. Returns '' when not used. */
function wordMarks(verdict, typed, expected) {
  if (verdict !== 'wrong' || shownSide !== 'back') return '';
  const d = diff(words(expected), words(typed));
  if (!d.ok && !d.accent) return '';
  return tokensHtml(d);
}

function tokensHtml(d) {
  const cls = { ok: '', accent: 'w-accent', missing: 'w-missing', extra: 'w-extra' };
  return d.tokens.map(({ kind, text }) => `<span class="w ${cls[kind]}">${escapeHtml(text)}</span>`).join(' ');
}

/* ── typing what you hear ────────────────────────────────────────────── */

/* With the word hidden and only heard, there are two things to practise:
   hearing it right, and knowing what it means. So the card has two boxes.
   The first, where the cursor starts, takes what was heard; checking it
   marks the spelling and tones syllable by syllable, uncovers the word and
   moves on to the meaning. Its button offers Show word while it is empty,
   which skips the transcription. Nothing typed there is scored — the card's
   score rests on the meaning — but a tone slip puts the card on the
   Accents list and an exact transcription takes it off, by the same rule
   as anywhere else. The meaning box can be answered at any point, from
   sound alone. */
function wireHear() {
  const hear = $('ty-hear');
  const btn = $('ty-hear-btn');
  const render = () => {
    const typed = !!hear.value.trim();
    btn.textContent = typed ? 'Check' : 'Show word';
    btn.title = typed ? 'Marks what you heard, then shows the word' : 'Shows the word without transcribing it';
  };
  hear.addEventListener('input', render);
  hear.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    /* Enter only ever checks, as in the meaning box. */
    if (hear.value.trim()) checkHeard();
  });
  btn.addEventListener('click', () => (hear.value.trim() ? checkHeard() : skipHeard()));
  render();
  hear.focus();
}

function checkHeard() {
  const hear = document.getElementById('ty-hear');
  if (!hear || !current) return;
  const typed = hear.value.trim();
  const heard = markHeard(typed);
  /* The box stood where the word goes; the word takes its place, and what
     was typed is shown marked underneath. */
  hear.remove();
  $('ty-hear-btn').remove();

  if (heard.exact) delete current.accent_slip;
  else if (heard.accent) current.accent_slip = true;
  if (heard.exact || heard.accent) store.cardAnswered(current);

  /* The word itself is on screen just above, so this is only what was heard,
     marked syllable by syllable to be read against it, and a line in words
     saying how it compares — no legend to decode. */
  const el = $('ty-heard');
  el.hidden = false;
  el.innerHTML = `<div class="verdict ${heard.exact ? 'is-ok' : heard.bad ? 'is-bad' : 'is-warn'}">You heard
      <span class="heard-marks">${heard.html}</span></div>
    <div class="typed-back" style="margin-top:6px">${escapeHtml(heard.summary)}</div>`;
  showWord();
  if (!answered) $('ty-input').focus();
}

/* Show word with nothing transcribed: the word is uncovered, and typing it
   back after that would be copying, so the first box goes. */
function skipHeard() {
  showWord();
  if (!answered) $('ty-input').focus();
}

/* How a transcription compares with the word. Returns the typed syllables
   marked — right, right sound with the wrong tone, misheard — with a "…"
   where one was left out, and a sentence saying the same in words.
   Syllables are compared pairwise when the counts agree, which shows a
   mishearing ("nghiệp thực" for "biệt thự") one syllable at a time;
   otherwise they are aligned by the word diff. */
function markHeard(typed) {
  const said = current.front.replace(/\([^)]*\)/g, ' ');
  const ref = words(said);
  const usr = words(typed);
  let marks;
  if (ref.length === usr.length) {
    marks = ref.map((r, i) => ({ text: usr[i], kind: usr[i] === r ? 'ok' : base(usr[i]) === base(r) ? 'accent' : 'misheard' }));
  } else {
    const kind = { ok: 'ok', accent: 'accent', extra: 'misheard', missing: 'missing' };
    marks = diff(ref, usr).tokens.map((t) => ({ text: t.kind === 'missing' ? '…' : t.text, kind: kind[t.kind] }));
  }
  const count = (k) => marks.filter((m) => m.kind === k).length;
  const c = { misheard: count('misheard'), accent: count('accent'), missing: count('missing') };
  const exact = !c.misheard && !c.accent && !c.missing;
  const cls = { ok: '', accent: 'w-accent', misheard: 'w-missing', missing: 'w-missing' };
  const tip = { ok: 'right', accent: 'right sound, wrong tone', misheard: 'misheard', missing: 'left out' };
  return {
    exact,
    accent: c.accent > 0,
    bad: c.misheard > 0 || c.missing > 0,
    html: marks.map((m) => `<span class="w ${cls[m.kind]}" title="${tip[m.kind]}">${escapeHtml(m.text)}</span>`).join(' '),
    summary: exact ? 'Heard right.' : heardSummary(c, ref.length),
  };
}

function heardSummary({ misheard, accent, missing }, total) {
  const n = (k, word = 'syllable') => `${k} ${word}${k === 1 ? '' : 's'}`;
  const parts = [];
  if (misheard) {
    parts.push(misheard === total && !accent && !missing
      ? (total === 1 ? 'misheard' : total === 2 ? 'both syllables misheard' : `all ${total} syllables misheard`)
      : `${n(misheard)} misheard`);
  }
  if (accent) parts.push(`wrong tone on ${n(accent)}`);
  if (missing) parts.push(`${n(missing)} left out`);
  const text = parts.join(', ');
  return `${text[0].toUpperCase()}${text.slice(1)} — compare with the word above.`;
}

const WORD_LEGEND = `<div class="legend" style="margin-top:6px">
  <span><i class="w w-accent">word</i> wrong accent</span>
  <span><i class="w w-extra">word</i> not in the answer</span>
  <span><i class="w w-missing">word</i> missing</span></div>`;

function renderPrevious() {
  const el = $('ty-prev');
  if (!previous) { el.innerHTML = ''; return; }
  const { verdict } = previous;
  const cls = verdict === 'exact' ? 'is-ok' : verdict === 'accent' ? 'is-warn' : 'is-bad';
  /* The same marking as the feedback it came from: one wrong accent is one
     highlighted letter, not a struck-out answer. */
  const shownTyped = verdict === 'accent' ? markAccents(previous.typed, previous.expected)
    : previous.words || `<s>${escapeHtml(previous.typed)}</s>`;
  const typed = verdict === 'exact' || verdict === 'revealed' ? '' :
    `<div class="typed-back" style="margin-top:4px">you typed ${shownTyped}</div>`;
  el.innerHTML = `
    <div class="prev ${cls}">
      <h3>Last card</h3>
      <div>${escapeHtml(previous.shown)} → <strong>${escapeHtml(previous.expected)}</strong></div>
      ${typed}
      ${previous.notes ? `<div style="margin-top:6px">${escapeHtml(previous.notes)}</div>` : ''}
    </div>`;
}
