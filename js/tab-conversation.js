/* Conversation: a few turns of your own in a scene (six unless Settings says
   otherwise), then feedback.

   A roleplay is a scene with two roles, and the model answers each
   of your turns in its role; your last gets its closing line and the feedback from
   one call. A find-out is a scene in which the model's role knows three or
   four things you were sent to find out, and gives one only when you ask
   about it specifically; a checklist ticks as it does, and the feedback is
   about whether you listened to the answers or fired off a list.

   The states are briefing → chatting ⇄ sending → grading → done. The
   briefing picks the kind, takes an optional request, says what the
   conversation will cost and refuses before spending when today's budget
   could not finish it. Start writes the scene and the opening line in one
   call. From then on the session is saved after every turn, your turn
   before the call that answers it, so a reply that fails keeps your turn
   and Try again sends the same conversation again. A conversation left
   open resumes when the tab is shown. Every one is kept and listed; an
   ended one opens read-only.

   A live conversation is a find-out spoken in real time, the God-project's Praat
   without its server: the scene is written the same way, then Start
   talking opens a socket to the Live API and you and the model just
   talk until the time is up. Its recording is kept the moment it ends,
   and the feedback call listens to it; a failed call keeps it for Try
   again. The talking itself is live-session.js; this draws it.

   Your cards are judged on your own turns only, and scored once, when the
   conversation ends with feedback. The logic that has no DOM is
   conversation.js and live.js. */

import * as store from './store.js';
import * as storage from './storage.js';
import { isPattern, inScope } from './deck.js';
import { pickReadingCards, nextDatedId } from './reading.js';
import {
  MAX_TURN_TEXT, turnsOf, callsNeeded, budgetProblem, learnerTurns,
  awaitingReply, factStatus, normaliseIds, suggestionChanged, conversationTitle, clipPath,
} from './conversation.js';
import { escapeHtml } from './text.js';
import { formatWait, pickVoice } from './gemini.js';
import { describe } from './tab-settings.js';
import { languageCode } from './speech.js';
import { scoreVerdicts, cardsResultHtml } from './tab-writing.js';
import { createRecorder, SUPPORTED as CAN_RECORD } from './recorder.js';
import { extensionFor } from './shadowing.js';
import {
  partnerInstruction, livePath, minutesLabel, clock, BANDS, BAND_LABELS,
} from './live.js';
import { createLiveTalk } from './live-session.js';
import { liveUnsupported } from './live-audio.js';
import { errorSpot } from './error-spot.js';

const $ = (id) => document.getElementById(id);

let kind = 'roleplay';
let scope = 'all';
/* The conversation on screen. `working` is what the tab as a whole is
   doing: 'starting' while a scene is written, 'talking' and 'saving' during
   a live conversation, null otherwise. A call made for one conversation
   ('sending', 'listening' or 'grading') is kept in `out` under its id
   instead, with the record it will land on, so a new conversation can be
   started, or another opened, while it is out: the reply or the feedback is
   saved to its own conversation whichever one is on screen by then. */
let session = null;
let working = null;
const out = new Map();
/* What Try again does: the call that failed, sent again as it was. */
let retry = null;
/* What scoring did to each card, right after it happened; a conversation
   reopened from the list shows its verdicts, not moves. */
let moves = null;
let saved = null;
/* The row whose Delete has been pressed once. */
let armed = null;
let disarm = 0;
/* The microphone, and a take recorded but not yet sent: {blob, url, path,
   mime}. The take is written to the store the moment it is recorded, so
   it survives a failed send; it becomes a turn only once it has been
   written down. */
let micDenied = false;
const recorder = createRecorder({ onChange: (st) => { micDenied = st.micDenied; } });
let recording = false;
let pending = null;
/* The one recording playing. */
let player = null;
/* A live conversation being had: the talk, what it last reported, whether
   the running transcript is on screen, and the meters' animation frame.
   `lastTake` is the recording just made, held so a conversation whose file
   could not be written can still be sent for feedback. */
let talk = null;
let talkView = null;
let showLive = false;
let meterFrame = 0;
let lastTake = null;
/* Said with every message until the feedback is in: the recording could
   not be written, so it lasts only as long as the page. */
let unkept = '';

export function init() {
  $('cv-kind').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-kind]');
    if (!btn || working) return;
    kind = btn.dataset.kind;
    setSeg('cv-kind', 'kind', kind);
    store.saveSettings({ conversationKind: kind });
    renderBriefing();
  });
  $('cv-scope').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-scope]');
    if (!btn) return;
    scope = btn.dataset.scope;
    setSeg('cv-scope', 'scope', scope);
    store.saveSettings({ conversationScope: scope });
    renderPool();
  });
  $('cv-length').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-seconds]');
    if (!btn) return;
    setSeg('cv-length', 'seconds', btn.dataset.seconds);
    store.saveSettings({ liveSeconds: Number(btn.dataset.seconds) }).then(() => { if (!session) renderBriefing(); });
  });
  $('lv-start').addEventListener('click', startTalking);
  $('lv-end').addEventListener('click', () => { if (talk) talk.finish(); });
  $('lv-show').addEventListener('click', () => {
    showLive = !showLive;
    renderLive();
    renderChat();
  });
  $('cv-request').addEventListener('change', (e) => store.saveSettings({ conversationRequest: e.target.value.trim() }));
  $('cv-start').addEventListener('click', start);
  $('cv-send').addEventListener('click', send);
  $('cv-text').addEventListener('keydown', (e) => {
    /* Enter sends, as in any chat; Shift+Enter is a new line. */
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
  });
  $('cv-text').addEventListener('input', renderInput);
  $('cv-end').addEventListener('click', endEarly);
  $('cv-record').addEventListener('click', toggleRecord);
  $('cv-send-take').addEventListener('click', sendTake);
  $('cv-chat').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-play]');
    if (btn) playTurn(Number(btn.dataset.play));
    if (e.target.closest('[data-act="play-live"]')) playLive();
  });
  $('cv-again').addEventListener('click', startAgain);
  $('cv-error').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="retry"]') && retry) retry();
  });
  placeError = errorSpot($('cv-error'));
  $('cv-result').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="ask-again"]')) finish({ closing: false });
    if (e.target.closest('[data-act="play-live"]')) playLive();
  });
  $('cv-list').addEventListener('click', (e) => {
    const row = e.target.closest('[data-conversation]');
    if (!row) return;
    const id = row.dataset.conversation;
    if (e.target.closest('[data-act="delete"]')) remove(id);
    else if (e.target.closest('[data-act="open"]')) open(id);
  });

  scope = store.state.settings.conversationScope || 'all';
  kind = store.state.settings.conversationKind || 'roleplay';
  setSeg('cv-scope', 'scope', scope);
  setSeg('cv-kind', 'kind', kind);
  setSeg('cv-length', 'seconds', String(store.state.settings.liveSeconds));
  syncRequest();

  store.subscribe('deck', renderPool);
  store.subscribe('conversation', renderList);
  store.subscribe('folder', () => { gate(); forgetIfGone(); });
  store.subscribe('settings', (st) => {
    scope = st.settings.conversationScope || 'all';
    setSeg('cv-scope', 'scope', scope);
    if (!working) {
      kind = st.settings.conversationKind || 'roleplay';
      setSeg('cv-kind', 'kind', kind);
    }
    setSeg('cv-length', 'seconds', String(st.settings.liveSeconds));
    syncRequest();
    renderBriefing();
  });
  store.subscribe('ready', () => { if (isActive()) onShow(); });
  store.subscribe('quota', renderQuota);
  setInterval(renderQuota, 1000);
  gate();
  render();
}

export async function onShow() {
  gate();
  renderPool();
  renderList();
  /* A conversation left open, by a reload or a closed tab, picks up where
     it was: the newest one that has not ended. */
  if (!session && !working && store.state.ready) {
    const row = (store.state.conversations || []).find((r) => r.ended === false);
    const record = row && await store.loadConversation(row.id);
    if (record && !session) take(record);
  }
  render();
}

/* A kept conversation put on screen, from the list or on resuming. One
   whose last turn was never answered offers Try again at once: that reply
   is what it is waiting for. */
function take(record) {
  if (!session || session.id !== record.id) { forgetTake(); unkept = ''; }
  session = record;
  moves = null;
  saved = null;
  retry = null;
  showError('');
  if (doing(record)) return;
  if (awaitingReply(record)) {
    retry = () => answer();
    showError('Your last turn has no reply yet.', true, CHAT());
  } else if (!record.ended && (record.kind === 'live' ? record.talked : record.kind === 'findout' && learnerTurns(record) >= turnsOf(record))) {
    /* Its turns are spent, or its talk is over, but the feedback never
       came: a call that failed, or one that came back while another
       conversation was on screen and could not go on to the next. */
    retry = () => (record.kind === 'live' ? gradeLive() : finish({ closing: false }));
    showError('This conversation has not had its feedback yet.', true, CHAT());
  }
}

/* The call out for a conversation ('sending', 'listening', 'grading'), or
   null. */
function doing(s = session) {
  const job = s && out.get(s.id);
  return job ? job.what : null;
}

/* Whether the conversation on screen can be acted on: not while the tab is
   busy, nor while a call is out for it. */
function busy() {
  return working || doing();
}

/* A call for `s` starts and ends. The record is kept with it so that
   opening that conversation again meanwhile shows this same object, the
   one the answer will land on. */
function begin(s, what) {
  out.set(s.id, { what, s });
}
function end(s) {
  out.delete(s.id);
}

/* Leaving the tab closes the microphone: a stream left running keeps the
   browser's recording indicator lit. A take being recorded is abandoned;
   one already recorded stays, waiting to be sent. */
export function onHide() {
  if (recording) {
    recorder.dispose();
    recording = false;
  }
  /* A live conversation ends here too, as if End now were pressed: what was
     said so far is still sent for feedback. One still connecting is
     dropped, having said nothing. */
  if (talk) {
    if (talk.phase === 'live') talk.finish();
    else if (talk.phase === 'connecting') talk.abort();
  }
  stopPlayer();
}

function isActive() {
  return !$('panel-conversation').hidden;
}

function setSeg(id, key, value) {
  for (const b of $(id).querySelectorAll('button')) {
    b.setAttribute('aria-pressed', String(b.dataset[key] === value));
  }
}

function syncRequest() {
  const el = $('cv-request');
  if (document.activeElement !== el) el.value = store.state.settings.conversationRequest || '';
}

/* ── gating ──────────────────────────────────────────────────────────── */

function gate() {
  const el = $('cv-gate');
  if (!storage.getApiKey()) {
    el.innerHTML = `<div class="gate">
      <h3>Add a Gemini API key first</h3>
      <p>The other side of a conversation, and the feedback on it, come from the Gemini API, using your own key. Paste a key into the Settings tab. Conversations you have already had stay readable without one.</p>
      </div>`;
    $('cv-stage').hidden = true;
    return;
  }
  el.innerHTML = !store.state.persistent
    ? '<div class="banner is-warn">Nothing is being saved — you can have a conversation and get feedback, but the conversation and what it did to your cards are gone on reload. See Settings for what this browser can keep.</div>'
    : '';
  $('cv-stage').hidden = false;
  renderQuota();
}

/* ── the pool and the cards ──────────────────────────────────────────── */

function pool() {
  return store.practiceCards().filter((c) => inScope(c, scope));
}

function renderPool() {
  const cards = pool();
  const decks = store.practiceDecks();
  $('cv-pool').textContent = [
    `${cards.length} cards in scope`,
    decks.length === 1 ? `deck ${decks[0]}` : `${decks.length} decks ticked`,
  ].join(' · ');
}

/* The session's cards as the decks have them now, for a prompt; a card the
   deck has lost is still listed by its front. */
function liveCards(s) {
  return (s.cards || []).map((c) => {
    const found = store.findCard(c.front, c.deck);
    if (!found) return { front: c.front, back: '' };
    const out = { front: found.card.front, back: found.card.back || '' };
    if (isPattern(found.card)) out.type = 'pattern';
    return out;
  });
}

/* ── the briefing ────────────────────────────────────────────────────── */

function costLine(k) {
  const s = store.state.settings;
  const needs = callsNeeded(s, k);
  const total = needs.reduce((n, r) => n + r.count, 0);
  const parts = needs.map((r) => `${r.count} on ${r.model} (${r.jobs.join(', ')})`);
  if (k === 'live') {
    return `This costs ${total} calls: ${parts.join('; ')}. You talk for up to ${minutesLabel(s.liveSeconds)}, and the audio streams both ways as you do, so it needs a microphone; headphones stop the model hearing its own voice.`;
  }
  return `This costs ${total} calls: ${parts.join('; ')}.`
    + ` ${k === 'findout' ? `The model answers all ${s.conversationTurns} of your turns.` : 'Your last turn is answered by the same call as the feedback.'}`
    + ' Ending early costs less.'
    + ` A spoken turn adds one call on ${s.listenModel} to write it down, and a roleplay with spoken turns is graded by ${s.listenModel}, since it listens to them.`;
}

function renderBriefing() {
  $('cv-cost').textContent = costLine(kind);
  $('cv-request-row').hidden = false;
  $('cv-length').hidden = kind !== 'live';
  renderStart();
}

function renderStart() {
  const btn = $('cv-start');
  if (working === 'starting') return;
  const s = store.state.settings;
  const t = store.limiter.usageOf(s, s.sceneModel);
  const short = budgetProblem(s, kind, (m, rpm, rpd) => store.limiter.usage(m, rpm, rpd));
  /* A browser that cannot hold a live conversation says so before a scene
     is written for one. */
  const cannot = kind === 'live' ? liveUnsupported() : null;
  /* Only a live conversation under way holds Start back: it has its own
     End now, and ending it is what saves the recording. */
  const talking = working === 'talking' || working === 'saving';
  btn.disabled = talking || !storage.getApiKey() || t.retryAfter > 0 || !!short || !!cannot;
  const why = (talking ? 'A live conversation is under way. End it first; it is kept, and its feedback follows.' : '') || cannot || (t.retryAfter > 0
    ? `${t.model} is out of budget for now: next call in ${formatWait(t.retryAfter)}.`
    : short || '');
  $('cv-why').textContent = why;
  $('cv-why').hidden = !why;
}

/* A new conversation, whether or not the one on screen has ended: that one
   stays in the list below, open, to carry on with later. */
async function start() {
  if (working) return;
  const cards = pickReadingCards(pool(), store.state.settings.conversationTerms).map((c) => ({
    front: c.front, back: c.back || '', deck: store.deckOf(c), ...(isPattern(c) ? { type: 'pattern' } : {}),
  }));
  const request = $('cv-request').value.trim();
  if (request !== store.state.settings.conversationRequest) store.saveSettings({ conversationRequest: request });
  const s = store.state.settings;
  const at = kind;
  working = 'starting';
  showError('');
  const btn = $('cv-start');
  btn.innerHTML = '<span class="spinner"></span>Setting the scene';
  btn.disabled = true;
  let made = null;
  try {
    const { scenario, model } = await store.client.writeScenario({ kind: at, cards, request });
    const record = {
      id: nextDatedId('c', store.state.conversations),
      kind: at,
      created: new Date().toISOString().slice(0, 10),
      language: s.targetLanguage,
      level: s.learnerLevel,
      request,
      cards: cards.map((c) => ({ front: c.front, deck: c.deck })),
      scenario,
      turns: [{ speaker: 'partner', text: scenario.openingLine }],
      revealed: [],
      feedback: null,
      deliveryNote: null,
      ended: false,
      scored: false,
      maxTurns: s.conversationTurns,
      models: { scene: model },
    };
    /* A live partner opens the conversation itself, in its own words, so
       the written opening line is not a turn; and it runs for a time
       rather than a number of turns. */
    if (at === 'live') {
      record.turns = [];
      delete record.maxTurns;
      delete record.deliveryNote;
      record.seconds = s.liveSeconds;
      record.talked = 0;
    }
    record.title = conversationTitle(record);
    stopPlayer();
    take(record);
    made = record;
    await save();
  } catch (e) {
    console.error(e);
    showError(describe(e), false, $('cv-request-row'));
  } finally {
    working = null;
    btn.textContent = 'Start';
    render();
    if (made && session === made) {
      $('cv-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
      (session.kind === 'live' ? $('lv-start') : $('cv-text')).focus({ preventScroll: true });
    }
  }
}

function startAgain() {
  if (working) return;
  forgetTake();
  session = null;
  moves = null;
  saved = null;
  retry = null;
  showError('');
  render();
  $('cv-panel-top').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/* ── the turns ───────────────────────────────────────────────────────── */

/* `s` is the conversation on screen unless a call that came back for
   another says otherwise; only the one on screen can say it was not kept. */
async function save(s = session) {
  if (!s) return;
  if (!(await store.saveConversation(s)) && session === s) {
    showError(`This conversation could not be written to ${storage.label()}. Reconnect the data folder in Settings; it will be lost on reload.`, false, CHAT());
  }
}

/* Your turn is saved before anything is sent for it, so a failure keeps
   it. */
async function send() {
  if (busy() || !session || session.ended || awaitingReply(session)) return;
  const text = $('cv-text').value.replace(/\s+/g, ' ').trim().slice(0, MAX_TURN_TEXT);
  if (!text || learnerTurns(session) >= turnsOf(session)) return;
  $('cv-text').value = '';
  await dropTake();
  session.turns.push({ speaker: 'learner', text });
  await save();
  await answer();
}

/* The model's answer to your last turn. A roleplay's last turn is
   answered by the closing call; a find-out answers every one and then
   concludes. */
async function answer() {
  const s = session;
  if (!s || s.ended) return;
  const n = learnerTurns(s);
  if (s.kind === 'roleplay' && n >= turnsOf(s)) { await finish({ closing: true }); return; }
  begin(s, 'sending');
  retry = null;
  showError('');
  render();
  try {
    const got = await store.client.partnerReply(s, liveCards(s));
    /* Kept on its own conversation even if another is on screen now. */
    s.turns.push({ speaker: 'partner', text: got.text });
    if (s.kind === 'findout') {
      s.revealed = normaliseIds([...(s.revealed || []), ...got.revealed], s.scenario.facts);
    }
    s.models = { ...(s.models || {}), reply: got.model };
    await save(s);
  } catch (e) {
    console.error(e);
    if (session === s) {
      retry = () => answer();
      showError(`${describe(e)} Your turn is kept.`, true, CHAT());
    }
    return;
  } finally {
    end(s);
    render();
  }
  if (session !== s) return;
  if (s.kind === 'findout' && learnerTurns(s) >= turnsOf(s)) await finish({ closing: false });
  else $('cv-text').focus();
}

/* ── spoken turns ────────────────────────────────────────────────────── */

async function toggleRecord() {
  if (busy() || !session || session.ended || awaitingReply(session)) return;
  stopPlayer();
  if (recording) { await finishTake(); return; }
  const ok = await recorder.start();
  if (!ok) {
    showError(micDenied
      ? 'The microphone is blocked for this page. Allow it in your browser’s address bar, then try again, or type your turn.'
      : 'The microphone could not be started. Check that this site may use it and that something is plugged in, or type your turn.', false, SPEAK());
    renderInput();
    return;
  }
  showError('');
  recording = true;
  renderInput();
}

/* Stopping is keeping: the take is written to the store at once, under the
   position the turn will take, replacing an earlier take of the same turn. */
async function finishTake() {
  recording = false;
  const s = session;
  const blob = await recorder.stop();
  if (!blob || !blob.size) {
    showError('Nothing was recorded. Try again, and give it a moment before you speak.', false, SPEAK());
    renderInput();
    return;
  }
  const mime = blob.type || 'audio/webm';
  const path = clipPath(s.id, s.turns.length, extensionFor(mime));
  if (pending && pending.path !== path) await store.removeConversationClip(pending.path);
  if (pending) URL.revokeObjectURL(pending.url);
  pending = null;
  if (!(await store.writeConversationClip(path, blob))) {
    showError('That recording could not be saved. Record your turn again.', false, SPEAK());
    renderInput();
    return;
  }
  pending = { blob, url: URL.createObjectURL(blob), path, mime };
  showError('');
  renderInput();
}

async function dropTake() {
  if (!pending) return;
  URL.revokeObjectURL(pending.url);
  await store.removeConversationClip(pending.path);
  pending = null;
}

/* The take, written down by the shadowing model, then sent like a typed
   turn. Nothing heard means the turn is not spent: the take is dropped and
   the learner records again. A failure keeps the take for Try again. */
async function sendTake() {
  const s = session;
  if (busy() || !s || s.ended || !pending || awaitingReply(s) || learnerTurns(s) >= turnsOf(s)) return;
  const take = pending;
  begin(s, 'listening');
  retry = null;
  showError('');
  render();
  let transcript = null;
  try {
    const bytes = new Uint8Array(await take.blob.arrayBuffer());
    ({ transcript } = await store.client.transcribeTurn(s, { mime: take.mime, bytes }));
  } catch (e) {
    console.error(e);
    if (session === s) {
      retry = () => sendTake();
      showError(`${describe(e)} Your recording is kept.`, true, CHAT());
    }
    return;
  } finally {
    end(s);
    render();
  }
  /* Another conversation was started or opened meanwhile. The turn is
     still this one's: written down, it joins the conversation and waits
     for its reply, which Try again asks for when it is opened again. */
  if (session !== s) {
    if (!transcript) { await store.removeConversationClip(take.path); return; }
    URL.revokeObjectURL(take.url);
    s.turns.push({ speaker: 'learner', text: transcript, take: take.path, mime: take.mime });
    await save(s);
    return;
  }
  if (pending !== take) return;
  if (!transcript) {
    await dropTake();
    showError('Nothing was heard in that recording, so the turn was not spent. Record it again.', false, CHAT());
    renderInput();
    return;
  }
  URL.revokeObjectURL(take.url);
  pending = null;
  s.turns.push({ speaker: 'learner', text: transcript, take: take.path, mime: take.mime });
  await save();
  await answer();
}

/* A take belongs to the conversation it was recorded in. Moving to
   another leaves the file where it is: it goes with its conversation. */
function forgetTake() {
  if (recording) { recorder.dispose(); recording = false; }
  if (pending) URL.revokeObjectURL(pending.url);
  pending = null;
}

/* Every spoken turn's recording, oldest first, as bytes, for the closing
   call to listen to. A file that cannot be read is left out. */
async function clipsOf(s) {
  const out = [];
  for (let i = 0; i < s.turns.length; i++) {
    const t = s.turns[i];
    if (t.speaker !== 'learner' || !t.take) continue;
    const blob = await store.readConversationClip(t.take);
    if (blob) out.push({ turnIndex: i, mime: t.mime || blob.type || 'audio/webm', bytes: new Uint8Array(await blob.arrayBuffer()) });
  }
  return out;
}

async function playTurn(i) {
  const t = session && session.turns[i];
  if (!t || !t.take) return;
  stopPlayer();
  const blob = await store.readConversationClip(t.take);
  if (!blob) { showError('That recording could not be read.'); return; }
  const url = URL.createObjectURL(blob);
  player = new Audio(url);
  player.onended = () => URL.revokeObjectURL(url);
  player.play().catch(() => URL.revokeObjectURL(url));
}

function stopPlayer() {
  if (player) { player.pause(); player = null; }
}

function endEarly() {
  if (busy() || !session || session.ended || learnerTurns(session) < 1) return;
  finish({ closing: false });
}

/* The feedback. On success the conversation ends, the closing line (if
   asked for) joins the turns, and the cards are scored, once. A roleplay
   whose call fails stays open with Try again. A find-out ends either way,
   as lessons-web's does: its turns are spent, and a failed feedback
   call leaves "Ask for feedback again". */
async function finish({ closing }) {
  const s = session;
  if (!s || busy()) return;
  begin(s, 'grading');
  retry = null;
  showError('');
  render();
  try {
    const clips = s.kind === 'roleplay' ? await clipsOf(s) : [];
    const got = await store.client.concludeConversation(s, liveCards(s), { closing, clips });
    /* Applied to its own conversation even if another is on screen now:
       the feedback is kept and the cards scored all the same. */
    if (closing && got.reply) s.turns.push({ speaker: 'partner', text: got.reply });
    s.feedback = s.kind === 'findout'
      ? { conversation: got.conversation, asking: got.asking, nextTime: got.nextTime, found: got.found, missed: got.missed, cards: got.cards }
      : { turns: got.feedback, cards: got.cards };
    if (got.deliveryNote) s.deliveryNote = got.deliveryNote;
    s.models = { ...(s.models || {}), feedback: got.model };
    s.ended = true;
    if (!s.scored) {
      const scored = await scoreVerdicts(got.cards, s.cards);
      s.scored = true;
      if (session === s) {
        moves = scored.moves;
        saved = scored.saved;
      }
    }
    await save(s);
  } catch (e) {
    console.error(e);
    if (s.kind === 'findout') {
      s.ended = true;
      s.feedback = null;
      await save(s);
      if (session === s) showError(`The conversation is over, but the feedback could not be fetched. ${describe(e)}`, false, CHAT());
    } else if (session === s) {
      retry = () => (closing ? answer() : finish({ closing: false }));
      showError(`${describe(e)} Your turns are kept.`, true, CHAT());
    }
  } finally {
    end(s);
    render();
  }
  if (session === s && s.ended) $('cv-result').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/* ── live conversations ──────────────────────────────────────────────── */

/* What each way a live conversation can fail to happen says. Only the
   microphone is asked for before the socket is opened, so those two cost
   nothing; every other has spent the call on the live model. */
const LIVE_ERRORS = {
  mic_denied: 'The browser did not allow the microphone. Allow it in the address bar, then press Start talking again. Nothing was spent.',
  no_mic: 'No microphone was found. Plug one in, or use headphones with a microphone, and press Start talking again. Nothing was spent.',
  connection_failed: 'Could not connect to the live model.',
  connection_lost: 'The connection dropped right at the start, so there is nothing to give feedback on yet.',
  audio_failed: 'The audio could not be started in this browser.',
  nothing_recorded: 'Nothing was recorded from the microphone, so there is nothing to give feedback on.',
};

function liveErrorText(e) {
  const code = e && e.code;
  const said = LIVE_ERRORS[code] || describe(e);
  let detail = code === 'connection_failed' && e.message && e.message !== code ? ` ${e.message.trim()}` : '';
  if (detail && !/[.!?]$/.test(detail)) detail += '.';
  const again = code === 'mic_denied' || code === 'no_mic' ? ''
    : ' The scene is kept: press Start talking to try again, which spends another call on the live model.';
  return `${said}${detail}${again}`;
}

/* Start talking. Everything up to the socket happens inside this click, so
   the model's voice is allowed to play. The recording is written the
   moment the conversation ends, then the transcript, and then it goes for
   feedback; a feedback call that fails keeps both, with Try again. */
async function startTalking() {
  const s = session;
  if (!s || s.kind !== 'live' || s.ended || s.talked || busy()) return;
  const cannot = liveUnsupported();
  if (cannot) { showError(cannot, false, $('lv-status')); return; }
  const st = store.state.settings;
  const voice = pickVoice(st);
  const system = partnerInstruction(st, s, liveCards(s));
  stopPlayer();
  working = 'talking';
  showLive = false;
  retry = null;
  showError('');
  const t = createLiveTalk({
    seconds: s.seconds || st.liveSeconds,
    connect: (handlers) => store.client.openLive({ system, voice, ...handlers }),
    onUpdate: (view) => {
      if (talk !== t) return;
      talkView = view;
      renderLive();
      if (showLive) renderChat();
    },
  });
  talk = t;
  talkView = { phase: 'connecting', secondsLeft: s.seconds || st.liveSeconds, turns: [], error: null };
  render();
  startMeters();
  let got = null;
  try {
    got = await t.start();
  } catch (e) {
    if (e && e.code !== 'aborted' && session === s) showError(liveErrorText(e), false, $('lv-status'));
  } finally {
    if (talk === t) { talk = null; talkView = null; }
    working = null;
    stopMeters();
  }
  if (!got || session !== s) { render(); return; }

  /* Saving, so the stage does not offer Start talking again meanwhile. */
  working = 'saving';
  const path = livePath(s.id, extensionFor(got.mime));
  lastTake = { id: s.id, blob: got.blob };
  const kept = await store.writeConversationClip(path, got.blob);
  unkept = kept ? '' : `The recording could not be written to ${storage.label()}, so it is gone on reload.`;
  s.turns = got.turns;
  s.take = path;
  s.mime = got.mime;
  s.talked = Math.max(1, got.talked);
  s.voice = voice;
  s.models = { ...(s.models || {}), live: st.liveModel };
  await save();
  working = null;
  await gradeLive();
}

/* The recording of a live conversation: the one just made, or its file. */
async function liveBlob(s) {
  if (lastTake && lastTake.id === s.id) return lastTake.blob;
  return s.take ? store.readConversationClip(s.take) : null;
}

/* The feedback, from one call that listens to the recording. On success
   the conversation ends: its lines are written afresh from the recording,
   the facts found out are ticked, and the cards are scored, once. */
async function gradeLive() {
  const s = session;
  if (!s || s.kind !== 'live' || !s.talked || s.ended || busy()) return;
  begin(s, 'grading');
  retry = null;
  showError(unkept, false, CHAT());
  render();
  try {
    const blob = await liveBlob(s);
    if (!blob) throw new Error(`The recording of this conversation could not be read from ${storage.label()}, so it cannot be given feedback.`);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const got = await store.client.gradeLive(s, liveCards(s), { mime: s.mime || blob.type, bytes });
    /* Applied to its own conversation even if another is on screen now. */
    s.feedback = {
      lines: got.lines, pronunciation: got.pronunciation, bands: got.bands, reasons: got.reasons,
      score: got.score, overall: got.overall, cards: got.cards,
    };
    s.revealed = got.found;
    s.models = { ...(s.models || {}), feedback: got.model };
    s.ended = true;
    if (!s.scored) {
      const scored = await scoreVerdicts(got.cards, s.cards);
      s.scored = true;
      if (session === s) {
        moves = scored.moves;
        saved = scored.saved;
      }
    }
    await save(s);
    if (session === s) {
      showError(unkept, false, CHAT());
      unkept = '';
    }
  } catch (e) {
    console.error(e);
    if (session === s) {
      retry = () => gradeLive();
      showError(`${describe(e)} ${unkept || 'Your recording is kept.'}`, true, CHAT());
    }
  } finally {
    end(s);
    render();
  }
  if (session === s && s.ended) $('cv-result').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function playLive() {
  const s = session;
  if (!s || !s.take) return;
  stopPlayer();
  const blob = await liveBlob(s);
  if (!blob) { showError('That recording could not be read.'); return; }
  const url = URL.createObjectURL(blob);
  player = new Audio(url);
  player.onended = () => URL.revokeObjectURL(url);
  player.play().catch(() => URL.revokeObjectURL(url));
}

/* Two dots that swell with each side's voice, so it is plain who is
   talking without reading anything. */
function startMeters() {
  stopMeters();
  const them = $('lv-them').firstElementChild;
  const me = $('lv-me').firstElementChild;
  const frame = () => {
    const lv = talk ? talk.levels() : { learner: 0, partner: 0 };
    them.style.transform = `scale(${1 + Math.min(1, lv.partner * 6)})`;
    me.style.transform = `scale(${1 + Math.min(1, lv.learner * 6)})`;
    meterFrame = requestAnimationFrame(frame);
  };
  meterFrame = requestAnimationFrame(frame);
}

function stopMeters() {
  cancelAnimationFrame(meterFrame);
  meterFrame = 0;
  for (const id of ['lv-them', 'lv-me']) $(id).firstElementChild.style.transform = '';
}

/* The stage: what to do before, the clock during, nothing after. */
function renderLive() {
  const s = session;
  const box = $('cv-live');
  const talking = working === 'talking' && talkView;
  if (!s || s.kind !== 'live' || s.ended || (s.talked && !talking)) { box.hidden = true; return; }
  box.hidden = false;
  const phase = talking ? talkView.phase : 'idle';
  const total = s.seconds || store.state.settings.liveSeconds;
  const st = store.state.settings;
  const blocked = [st.liveModel, st.liveGradeModel]
    .map((m) => store.limiter.usageOf(st, m)).find((u) => u.retryAfter > 0);
  const cannot = liveUnsupported();
  const status = {
    idle: cannot || (blocked
      ? `${blocked.model} is out of budget for now: next call in ${formatWait(blocked.retryAfter)}.`
      : `You are talking to an AI model, which plays the other role out loud. It speaks first. Then just talk, for up to ${minutesLabel(total)}: there is no button to press between turns, and it rounds the conversation off when the time is nearly up. Use headphones if you can.`),
    connecting: 'Connecting…',
    live: '',
    wrapping: 'Rounding off…',
    done: 'Saving the recording…',
    error: '',
  }[phase] || '';
  $('lv-status').textContent = status;
  /* A failed start is reported just under this line (see showError), so
     the line gives way to it rather than explaining Start talking above
     the reason it did not work. */
  const failed = $('lv-status').nextElementSibling === $('cv-error') && !!$('cv-error').textContent;
  $('lv-status').hidden = !status || failed;
  const start = $('lv-start');
  start.hidden = phase !== 'idle';
  start.disabled = !!busy() || !storage.getApiKey() || !!blocked || !!cannot;
  start.title = `One call on ${st.liveModel}, then one on ${st.liveGradeModel} for the feedback`;
  const going = phase === 'live' || phase === 'wrapping';
  $('lv-end').hidden = phase !== 'live';
  $('lv-show').hidden = !going;
  $('lv-show').setAttribute('aria-pressed', String(showLive));
  $('lv-show').textContent = showLive ? 'Hide what’s being said' : 'Show what’s being said';
  $('lv-clock').hidden = !going;
  $('lv-timebar').hidden = !going;
  if (going) {
    const left = talkView.secondsLeft;
    $('lv-clock').textContent = phase === 'live' ? clock(left) : clock(0);
    const used = phase === 'live' ? 1 - left / total : 1;
    $('lv-timebar').firstElementChild.style.transform = `scaleX(${Math.max(0, Math.min(1, used))})`;
    $('lv-timebar').setAttribute('aria-valuemax', String(total));
    $('lv-timebar').setAttribute('aria-valuenow', String(total - left));
  }
  box.classList.toggle('is-live', going);
}

/* The recording of a live conversation, to play back. It is on disk the
   moment the talking stops, so it is offered from then on: while the
   feedback is being written, and when that call failed and the recording
   is all there is. */
function playLiveHtml(s) {
  return `<div class="row"><button class="btn btn--sm" data-act="play-live">▶ Play your recording</button><span class="note">${escapeHtml(minutesLabel(s.talked))}</span></div>`;
}

/* The written-out conversation with its corrections, the four marks, the
   notes on how it sounded, and the cards. */
function liveResultHtml(s, fb, lang) {
  const parts = [];
  if (fb.score !== null && fb.score !== undefined && fb.bands) {
    parts.push(`<div class="lv-score"><span class="lv-pct">${fb.score}%</span><span class="lv-pct-label">How ${escapeHtml(s.language || store.state.settings.targetLanguage)} you sounded</span></div>`);
    parts.push(`<ul class="lv-bands">${BANDS.map((b) => {
      const v = fb.bands[b];
      return `<li><span class="lv-band-name">${BAND_LABELS[b]}</span>
        <span class="lv-dots" aria-label="${v} of 4">${'●'.repeat(v)}${'○'.repeat(4 - v)}</span>
        ${fb.reasons && fb.reasons[b] ? `<span class="wr-sub">${escapeHtml(fb.reasons[b])}</span>` : ''}</li>`;
    }).join('')}</ul>`);
  } else {
    parts.push('<p class="wr-sub">Too little was said to score.</p>');
  }
  if (fb.overall) parts.push(`<p>${escapeHtml(fb.overall)}</p>`);
  if (s.take) parts.push(playLiveHtml(s));
  const sc = s.scenario;
  parts.push('<h4>The conversation</h4>');
  parts.push(`<ol class="lv-lines">${(fb.lines || []).map((l) => {
    const mine = l.speaker === 'learner';
    const fixes = (l.corrections || []).map((c) => `<div class="lv-fix"><del lang="${lang}">${escapeHtml(c.original)}</del> → <ins lang="${lang}">${escapeHtml(c.correction)}</ins>${c.why ? `<span class="wr-sub">${escapeHtml(c.why)}</span>` : ''}</div>`).join('');
    const alts = (l.alternatives || []).map((a) => `<div class="cv-natural">More natural: <b lang="${lang}">${a.suggestions.map((x) => `“${escapeHtml(x)}”`).join(' or ')}</b> for <span lang="${lang}">“${escapeHtml(a.original)}”</span>${a.why ? `<span class="wr-sub">${escapeHtml(a.why)}</span>` : ''}</div>`).join('');
    return `<li class="lv-line lv-line--${mine ? 'me' : 'them'}">
      <span class="cv-who">${escapeHtml(mine ? sc.studentRole : sc.llmRole)}</span>
      <span class="cv-said" lang="${lang}">${escapeHtml(l.text)}</span>${fixes}${alts}
    </li>`;
  }).join('')}</ol>`);
  if (fb.pronunciation && fb.pronunciation.length) {
    parts.push('<h4>How you sounded</h4>');
    parts.push(`<ul class="lv-notes">${fb.pronunciation.map((n) => `<li><b lang="${lang}">${escapeHtml(n.word)}</b> ${escapeHtml(n.comment)}</li>`).join('')}</ul>`);
  }
  const { missed } = factStatus(s);
  if (missed.length) {
    parts.push(`<p class="wr-sub">You never found out: <span lang="${lang}">${missed.map(escapeHtml).join('; ')}</span></p>`);
  }
  if (s.cards && s.cards.length) {
    parts.push('<h4>Your cards</h4>');
    parts.push(cardsResultHtml(s.cards, fb.cards, moves, saved, lang));
  }
  return `<div class="wr-fb">${parts.join('')}</div>`;
}

/* ── drawing ─────────────────────────────────────────────────────────── */

/* The briefing is always there, above whatever conversation is on screen:
   a new one can be started at any point, and an unfinished one stays in
   the list to carry on with. */
function render() {
  renderBriefing();
  $('cv-card').hidden = !session;
  if (session) {
    renderScene();
    renderChat();
    renderInput();
    renderLive();
    renderResult();
  }
  renderList();
  renderQuota();
}

function renderScene() {
  const s = session;
  const sc = s.scenario;
  const lang = escapeHtml(languageCode(s.language || store.state.settings.targetLanguage));
  const live = s.kind === 'live';
  const findOut = s.kind === 'findout' || live;
  const status = findOut ? factStatus(s) : null;
  const progress = live
    ? (s.talked ? `${minutesLabel(s.talked)} talked` : minutesLabel(s.seconds))
    : `turn ${Math.min(learnerTurns(s) + 1, turnsOf(s))} of ${turnsOf(s)}`;
  $('cv-meta').innerHTML = [
    live ? 'Live' : findOut ? 'Find out' : 'Roleplay',
    escapeHtml(s.created),
    s.ended ? 'ended' : progress,
    s.level ? escapeHtml(s.level) : '',
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join('');

  const rows = [
    ['The situation', findOut ? sc.situation : sc.scenario],
    ['You are', sc.studentRole],
    ['You’re talking to', sc.llmRole],
  ];
  if (findOut) rows.push(['What you were sent to find out', sc.goal]);
  /* The role is a character in the scene; who is actually answering is an
     AI model, and that is said where the role is named. */
  let html = `<dl class="cv-brief">${rows.map(([k, v]) => `<dt>${k}</dt><dd><span lang="${lang}">${escapeHtml(v)}</span>${k === rows[2][0]
    ? `<span class="wr-sub">played by an AI model${live ? ', out loud' : ''}</span>` : ''}</dd>`).join('')}</dl>`;
  if (findOut) {
    const revealed = normaliseIds(s.revealed, sc.facts);
    /* A live partner does not say what it gave away, so the count comes
       only with the feedback. */
    const count = live && !s.ended ? '' : `: ${status.found.length} of ${sc.facts.length}`;
    html += `<div class="cv-facts">
      <div class="cv-facts-head">What you need to find out${count}</div>
      <ul>${sc.facts.map((f) => {
        const got = revealed.includes(String(f.id));
        /* The answer stays hidden until the end: it is the thing being
           found out. */
        return `<li class="${got ? 'is-ok' : ''}"><span class="wr-mark" aria-label="${got ? 'Found' : 'Not yet'}">${got ? '✓' : '○'}</span>
          <span lang="${lang}">${escapeHtml(f.label)}${s.ended ? `<span class="wr-sub">${escapeHtml(f.detail)}</span>` : ''}</span></li>`;
      }).join('')}</ul>
    </div>`;
  }
  html += tryToUseHtml(s, lang);
  $('cv-scene').innerHTML = html;
}

/* The cards the scene was written around, shown with it from the first
   turn, meanings and all: they are what the feedback judges at the end, so
   they have to be in view while there is still time to use them. The
   meaning is on screen rather than in a tooltip, which a phone never
   shows. A card the deck has since lost is still listed by its front. */
function tryToUseHtml(s, lang) {
  const cards = liveCards(s);
  if (!cards.length) return '';
  return `<div class="cv-facts try-list">
      <div class="cv-facts-head">Try to use these in your turns</div>
      <ul>${cards.map((c) => `<li>
        <span class="try-front" lang="${lang}">${escapeHtml(c.front)}</span>
        <span class="try-back">${c.type === 'pattern' ? 'grammar pattern · ' : ''}${escapeHtml(c.back || '')}</span>
      </li>`).join('')}</ul>
    </div>`;
}

function renderChat() {
  const s = session;
  if (!s) return;
  const lang = escapeHtml(languageCode(s.language || store.state.settings.targetLanguage));
  if (s.kind === 'live') { $('cv-chat').innerHTML = liveChatHtml(s, lang); return; }
  const bubbles = s.turns.map((t, i) => `<div class="cv-bubble cv-bubble--${t.speaker === 'learner' ? 'me' : 'them'}">
      <span class="cv-who">${escapeHtml(t.speaker === 'learner' ? s.scenario.studentRole : s.scenario.llmRole)}${t.take
        ? ` <button type="button" class="cv-play" data-play="${i}" aria-label="Play your recording of this turn" title="Play your recording">▶</button>` : ''}</span>
      <span class="cv-said" lang="${lang}">${escapeHtml(t.text)}</span>
    </div>`);
  if (doing() === 'listening') {
    bubbles.push(`<div class="cv-bubble cv-bubble--me cv-thinking" aria-live="polite">
      <span class="cv-who">${escapeHtml(s.scenario.studentRole)}</span>
      <span class="cv-said"><span class="spinner"></span>Writing down what you said</span>
    </div>`);
  }
  if (doing() === 'sending' || doing() === 'grading') {
    bubbles.push(`<div class="cv-bubble cv-bubble--them cv-thinking" aria-live="polite">
      <span class="cv-who">${escapeHtml(doing() === 'grading' ? 'Feedback' : s.scenario.llmRole)}</span>
      <span class="cv-said"><span class="spinner"></span>${doing() === 'grading' ? 'Reading the whole conversation' : 'Thinking'}</span>
    </div>`);
  }
  $('cv-chat').innerHTML = bubbles.join('');
}

/* While talking, the last few turns of the running transcript, and only if
   asked for: reading along is not listening. After, and before the
   feedback, the whole of it and the recording to play; after the feedback,
   nothing here, since the feedback writes it out again and has the
   recording with it. */
function liveChatHtml(s, lang) {
  if (s.ended) return '';
  const bubble = (t) => `<div class="cv-bubble cv-bubble--${t.speaker === 'learner' ? 'me' : 'them'}">
      <span class="cv-who">${escapeHtml(t.speaker === 'learner' ? s.scenario.studentRole : s.scenario.llmRole)}</span>
      <span class="cv-said" lang="${lang}">${escapeHtml(t.text)}</span>
    </div>`;
  if (working === 'talking') return showLive && talkView ? talkView.turns.slice(-4).map(bubble).join('') : '';
  const out = (s.turns || []).map(bubble);
  if (s.take) out.push(playLiveHtml(s));
  if (doing() === 'grading') {
    out.push(`<div class="cv-bubble cv-bubble--them cv-thinking" aria-live="polite">
      <span class="cv-who">Feedback</span>
      <span class="cv-said"><span class="spinner"></span>Listening to the whole conversation</span>
    </div>`);
  }
  return out.join('');
}

function renderInput() {
  const s = session;
  const area = $('cv-input-area');
  if (!s || s.ended || s.kind === 'live') { area.hidden = true; return; }
  area.hidden = false;
  const n = learnerTurns(s);
  const waiting = awaitingReply(s);
  $('cv-turn').textContent = waiting
    ? `Turn ${n} of ${turnsOf(s)} · waiting for the reply`
    : `Turn ${n + 1} of ${turnsOf(s)}`;
  const text = $('cv-text');
  text.disabled = !!busy() || waiting;
  text.lang = languageCode(s.language || store.state.settings.targetLanguage);
  text.placeholder = waiting ? 'Your turn is kept. Press Try again above.' : `Your turn, in ${s.language || store.state.settings.targetLanguage}…`;
  const st = store.state.settings;
  const replyBlocked = store.limiter.usageOf(st, n + 1 >= turnsOf(s) && s.kind === 'roleplay' ? st.conversationGradeModel : st.chatModel).retryAfter > 0;
  const gradeBlocked = store.limiter.usageOf(st, st.conversationGradeModel).retryAfter > 0;
  $('cv-send').disabled = !!busy() || waiting || recording || !text.value.trim() || !storage.getApiKey() || replyBlocked;
  $('cv-end').disabled = !!busy() || recording || n < 1 || !storage.getApiKey() || gradeBlocked;
  renderSpeak(waiting, replyBlocked);
}

/* The spoken half of the input: Speak, Stop recording, then the take to
   play back with Record again and Send recording. Where the browser cannot
   record, or the microphone is blocked, the typed box is all there is, and
   the note says why. */
function renderSpeak(waiting, replyBlocked) {
  const btn = $('cv-record');
  const note = $('cv-mic-note');
  if (!CAN_RECORD) {
    btn.hidden = true;
    $('cv-take').hidden = true;
    note.hidden = false;
    note.textContent = 'This browser cannot record audio, so type your turns.';
    return;
  }
  btn.hidden = false;
  btn.disabled = !!busy() || waiting || !storage.getApiKey();
  btn.classList.toggle('is-rec', recording);
  btn.textContent = recording ? '■ Stop recording' : pending ? '● Record again' : '● Speak';
  note.hidden = !micDenied;
  note.textContent = micDenied ? 'The microphone is blocked for this page. Allow it in the address bar, or type your turn.' : '';
  const take = $('cv-take');
  take.hidden = !pending || recording;
  if (pending) {
    const audio = $('cv-take-audio');
    if (audio.dataset.url !== pending.url) { audio.src = pending.url; audio.dataset.url = pending.url; }
    const st = store.state.settings;
    const listenBlocked = store.limiter.usageOf(st, st.listenModel).retryAfter > 0;
    $('cv-send-take').disabled = !!busy() || waiting || listenBlocked || replyBlocked || !storage.getApiKey();
    $('cv-send-take').title = `One call on ${st.listenModel} to write it down, then the reply`;
  }
}

function renderResult() {
  const s = session;
  const el = $('cv-result');
  $('cv-done-row').hidden = !s.ended;
  if (!s.ended) { el.innerHTML = ''; return; }
  const lang = escapeHtml(languageCode(s.language || store.state.settings.targetLanguage));
  const fb = s.feedback;
  if (s.kind === 'live' && fb) { el.innerHTML = liveResultHtml(s, fb, lang); return; }
  if (!fb) {
    el.innerHTML = `<div class="banner is-warn wr-fb">The feedback on this conversation could not be fetched.
      <button class="btn btn--sm" data-act="ask-again"${busy() ? ' disabled' : ''}>Ask for feedback again</button></div>`;
    return;
  }
  const parts = [];
  if (s.kind === 'findout') {
    parts.push(`<p>${escapeHtml(fb.conversation)}</p>`);
    if (fb.asking) parts.push(`<p>${escapeHtml(fb.asking)}</p>`);
    if (fb.nextTime) parts.push(`<p><b>Next time:</b> ${escapeHtml(fb.nextTime)}</p>`);
    if (fb.missed && fb.missed.length) {
      parts.push(`<p class="wr-sub">You never asked about: <span lang="${lang}">${fb.missed.map(escapeHtml).join('; ')}</span></p>`);
    }
  } else {
    if (s.deliveryNote) {
      parts.push('<h4>How you sounded</h4>');
      parts.push(`<p>${escapeHtml(s.deliveryNote)}</p>`);
    }
    parts.push('<h4>Your turns</h4>');
    const byTurn = new Map((fb.turns || []).map((f) => [f.turnIndex, f]));
    parts.push(`<ol class="cv-turns">${s.turns.map((t, i) => ({ t, i })).filter(({ t }) => t.speaker === 'learner').map(({ t, i }) => {
      const f = byTurn.get(i);
      return `<li>
        <div>You said: <span lang="${lang}">“${escapeHtml(t.text)}”</span></div>
        ${f && suggestionChanged(f.natural, t.text) ? `<div class="cv-natural">More natural: <b lang="${lang}">“${escapeHtml(f.natural)}”</b></div>` : ''}
        ${f && f.comment ? `<div class="wr-sub">${escapeHtml(f.comment)}</div>` : ''}
      </li>`;
    }).join('')}</ol>`);
  }
  if (s.cards && s.cards.length) {
    parts.push('<h4>Your cards</h4>');
    parts.push(cardsResultHtml(s.cards, fb.cards, moves, saved, lang));
  }
  el.innerHTML = `<div class="wr-fb">${parts.join('')}</div>`;
}

/* ── the list ────────────────────────────────────────────────────────── */

function renderList() {
  const rows = store.state.conversations || [];
  $('cv-list-hint').textContent = rows.length ? `${rows.length} conversation${rows.length === 1 ? '' : 's'}` : 'nothing yet';
  $('cv-list').innerHTML = rows.length
    ? rows.map((r) => `<div class="sh-hist rd-row${session && session.id === r.id ? ' is-open' : ''}" data-conversation="${escapeHtml(r.id)}">
        <button class="sh-hist-open" data-act="open">
          <span class="rd-row-head">
            <span class="sh-hist-id rd-row-title">${escapeHtml(r.title || r.id)}</span>
            ${r.ended === false ? '<span class="rd-badge rd-badge--audio">Open</span>' : ''}
          </span>
          <span class="sh-hist-sub">${[
            r.created, r.kind === 'findout' ? 'find out' : r.kind === 'live' ? 'live' : 'roleplay', r.decks && r.decks.length ? r.decks.join(', ') : '', r.language,
          ].filter(Boolean).map(escapeHtml).join(' · ')}</span>
        </button>
        <button class="btn btn--sm btn--danger" data-act="delete" title="Delete this conversation">${armed === r.id ? 'Really delete?' : 'Delete'}</button>
      </div>`).join('')
    : '<p class="note">Every conversation is kept here with its feedback. Click one to read it again, or to carry on with one that is still open.</p>';
}

async function open(id) {
  if (working) return;
  if (session && session.id === id) {
    $('cv-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
    return;
  }
  /* One with a call out is taken as it is in memory, which is where the
     answer will land, not as the copy on disk. */
  const job = out.get(id);
  const record = job ? job.s : await store.loadConversation(id);
  if (!record) {
    showError(`That conversation could not be read from ${storage.label()}. Its file may have been moved or deleted outside the app.`);
    return;
  }
  take(record);
  render();
  $('cv-card').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/* Asks twice, in place, as Reading's Delete does: a conversation cost
   several calls. */
async function remove(id) {
  if (out.has(id) || (working && session && session.id === id)) return;
  clearTimeout(disarm);
  if (armed !== id) {
    armed = id;
    renderList();
    disarm = setTimeout(() => { armed = null; renderList(); }, 4000);
    return;
  }
  armed = null;
  if (session && session.id === id) { forgetTake(); session = null; retry = null; showError(''); }
  await store.deleteConversation(id);
  render();
}

function forgetIfGone() {
  if (session && !(store.state.conversations || []).some((r) => r.id === session.id)) {
    session = null;
    retry = null;
  }
  render();
}

/* ── the budget readout ──────────────────────────────────────────────── */

function renderQuota() {
  if (!isActive()) return;
  const s = store.state.settings;
  const c = store.limiter.usageOf(s, s.chatModel);
  const g = store.limiter.usageOf(s, s.conversationGradeModel);
  const el = $('cv-quota');
  const part = (label, u) => `${label} ${u.usedDay}/${u.rpd || '∞'}${u.retryAfter > 0 ? ` (waits ${formatWait(u.retryAfter)})` : ''}`;
  el.textContent = `${part('conversation', c)} · ${part('feedback', g)} in 24h`;
  el.className = 'quota ' + (c.retryAfter > 0 || g.retryAfter > 0 ? 'is-bad' : 'is-ok');
  renderStart();
  if (session && session.kind === 'live') { if (working !== 'talking') renderLive(); } else if (session) renderInput();
  /* Why Send or End is greyed out, said beside them rather than only in a
     tooltip. A call is refused while its model is out of budget, never
     queued, so the turn waits in the box until then. */
  const wait = $('cv-wait');
  const blocked = session && !session.ended && !busy()
    ? [c, g].find((u) => u.retryAfter > 0) : null;
  wait.hidden = !blocked;
  if (blocked) wait.textContent = `${blocked.model} is out of budget for now: next call in ${formatWait(blocked.retryAfter)}.`;
  $('cv-send').title = `One call on ${s.chatModel}`;
  $('cv-end').title = `One call on ${s.conversationGradeModel}`;
}

/* `at` is where the wait was shown: the Start row for the scene, the end of
   the chat for anything a thinking bubble stood for (a reply, a transcript,
   the feedback), the live stage's status line, the Speak row for the
   microphone. The error takes that spot (errorSpot), so a failure at the
   foot of a long conversation is seen where the bubble was, not above the
   scene. The Try again button goes with it. */
let placeError = () => {};
const CHAT = () => $('cv-chat');
const SPEAK = () => $('cv-record').closest('.row');

function showError(text, withRetry = false, at = null) {
  const el = $('cv-error');
  placeError(text ? at : null);
  el.innerHTML = text
    ? `<div class="banner is-bad">${escapeHtml(text)}${withRetry ? ' <button class="btn btn--sm" data-act="retry">Try again</button>' : ''}</div>`
    : '';
}
