/* Conversation: a few turns of your own in a scene (six unless Settings says
   otherwise), then feedback.

   A roleplay is a scene with two roles, and the other person answers each
   of your turns; your last gets their closing line and the feedback from
   one call. A find-out is a scene in which the other person knows three or
   four things you were sent to find out, and gives one only when you ask
   about it specifically; a checklist ticks as they do, and the feedback is
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

   Your cards are judged on your own turns only, and scored once, when the
   conversation ends with feedback. The logic that has no DOM is
   conversation.js. */

import * as store from './store.js';
import * as storage from './storage.js';
import { isPattern, inScope } from './deck.js';
import { pickReadingCards, nextDatedId } from './reading.js';
import {
  MAX_TURN_TEXT, turnsOf, callsNeeded, budgetProblem, learnerTurns,
  awaitingReply, factStatus, normaliseIds, suggestionChanged, conversationTitle, clipPath,
} from './conversation.js';
import { escapeHtml } from './text.js';
import { formatWait } from './gemini.js';
import { describe } from './tab-settings.js';
import { languageCode } from './speech.js';
import { scoreVerdicts, cardsResultHtml } from './tab-writing.js';
import { createRecorder, SUPPORTED as CAN_RECORD } from './recorder.js';
import { extensionFor } from './shadowing.js';

const $ = (id) => document.getElementById(id);

let kind = 'roleplay';
let scope = 'all';
/* The conversation on screen, and what is happening to it: null while it
   waits for you, or 'starting', 'sending' or 'grading' while a call is
   out. */
let session = null;
let working = null;
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
  });
  $('cv-again').addEventListener('click', startAgain);
  $('cv-error').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="retry"]') && retry) retry();
  });
  $('cv-result').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="ask-again"]')) finish({ closing: false });
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
  syncRequest();

  store.subscribe('deck', renderPool);
  store.subscribe('conversation', renderList);
  store.subscribe('folder', () => { gate(); forgetIfGone(); });
  store.subscribe('settings', (st) => {
    scope = st.settings.conversationScope || 'all';
    setSeg('cv-scope', 'scope', scope);
    if (!working && !session) {
      kind = st.settings.conversationKind || 'roleplay';
      setSeg('cv-kind', 'kind', kind);
    }
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
  if (!session || session.id !== record.id) forgetTake();
  session = record;
  moves = null;
  saved = null;
  retry = null;
  showError('');
  if (awaitingReply(record)) {
    retry = () => answer();
    showError('Your last turn has no reply yet.', true);
  }
}

/* Leaving the tab closes the microphone: a stream left running keeps the
   browser's recording indicator lit. A take being recorded is abandoned;
   one already recorded stays, waiting to be sent. */
export function onHide() {
  if (recording) {
    recorder.dispose();
    recording = false;
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
  return `This costs ${total} calls: ${parts.join('; ')}.`
    + ` ${k === 'findout' ? `The other person answers all ${s.conversationTurns} of your turns.` : 'Your last turn is answered by the same call as the feedback.'}`
    + ' Ending early costs less.'
    + ` A spoken turn adds one call on ${s.listenModel} to write it down, and a roleplay with spoken turns is graded by ${s.listenModel}, since it listens to them.`;
}

function renderBriefing() {
  $('cv-cost').textContent = costLine(kind);
  $('cv-request-row').hidden = false;
  renderStart();
}

function renderStart() {
  const btn = $('cv-start');
  if (working === 'starting') return;
  const s = store.state.settings;
  const t = store.limiter.usageOf(s, s.sceneModel);
  const short = budgetProblem(s, kind, (m, rpm, rpd) => store.limiter.usage(m, rpm, rpd));
  btn.disabled = !storage.getApiKey() || t.retryAfter > 0 || !!short;
  const why = t.retryAfter > 0
    ? `${t.model} is out of budget for now: next call in ${formatWait(t.retryAfter)}.`
    : short || '';
  $('cv-why').textContent = why;
  $('cv-why').hidden = !why;
}

async function start() {
  if (working || session) return;
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
    record.title = conversationTitle(record);
    session = record;
    moves = null;
    saved = null;
    await save();
  } catch (e) {
    console.error(e);
    showError(describe(e));
  } finally {
    working = null;
    btn.textContent = 'Start';
    render();
    if (session) $('cv-text').focus();
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

async function save() {
  if (!session) return;
  if (!(await store.saveConversation(session))) {
    showError(`This conversation could not be written to ${storage.label()}. Reconnect the data folder in Settings; it will be lost on reload.`);
  }
}

/* Your turn is saved before anything is sent for it, so a failure keeps
   it. */
async function send() {
  if (working || !session || session.ended || awaitingReply(session)) return;
  const text = $('cv-text').value.replace(/\s+/g, ' ').trim().slice(0, MAX_TURN_TEXT);
  if (!text || learnerTurns(session) >= turnsOf(session)) return;
  $('cv-text').value = '';
  await dropTake();
  session.turns.push({ speaker: 'learner', text });
  await save();
  await answer();
}

/* The other person's answer to your last turn. A roleplay's last turn is
   answered by the closing call; a find-out answers every one and then
   concludes. */
async function answer() {
  const s = session;
  if (!s || s.ended) return;
  const n = learnerTurns(s);
  if (s.kind === 'roleplay' && n >= turnsOf(s)) { await finish({ closing: true }); return; }
  working = 'sending';
  retry = null;
  showError('');
  render();
  try {
    const got = await store.client.partnerReply(s, liveCards(s));
    if (session !== s) return;
    s.turns.push({ speaker: 'partner', text: got.text });
    if (s.kind === 'findout') {
      s.revealed = normaliseIds([...(s.revealed || []), ...got.revealed], s.scenario.facts);
    }
    s.models = { ...(s.models || {}), reply: got.model };
    await save();
  } catch (e) {
    console.error(e);
    if (session === s) {
      retry = () => answer();
      showError(`${describe(e)} Your turn is kept.`, true);
    }
    return;
  } finally {
    working = null;
    render();
  }
  if (session !== s) return;
  if (s.kind === 'findout' && learnerTurns(s) >= turnsOf(s)) await finish({ closing: false });
  else $('cv-text').focus();
}

/* ── spoken turns ────────────────────────────────────────────────────── */

async function toggleRecord() {
  if (working || !session || session.ended || awaitingReply(session)) return;
  stopPlayer();
  if (recording) { await finishTake(); return; }
  const ok = await recorder.start();
  if (!ok) {
    showError(micDenied
      ? 'The microphone is blocked for this page. Allow it in your browser’s address bar, then try again, or type your turn.'
      : 'The microphone could not be started. Check that this site may use it and that something is plugged in, or type your turn.');
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
    showError('Nothing was recorded. Try again, and give it a moment before you speak.');
    renderInput();
    return;
  }
  const mime = blob.type || 'audio/webm';
  const path = clipPath(s.id, s.turns.length, extensionFor(mime));
  if (pending && pending.path !== path) await store.removeConversationClip(pending.path);
  if (pending) URL.revokeObjectURL(pending.url);
  pending = null;
  if (!(await store.writeConversationClip(path, blob))) {
    showError('That recording could not be saved. Record your turn again.');
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
  if (working || !s || s.ended || !pending || awaitingReply(s) || learnerTurns(s) >= turnsOf(s)) return;
  const take = pending;
  working = 'listening';
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
      showError(`${describe(e)} Your recording is kept.`, true);
    }
    return;
  } finally {
    working = null;
    render();
  }
  if (session !== s || pending !== take) return;
  if (!transcript) {
    await dropTake();
    showError('Nothing was heard in that recording, so the turn was not spent. Record it again.');
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
  if (working || !session || session.ended || learnerTurns(session) < 1) return;
  finish({ closing: false });
}

/* The feedback. On success the conversation ends, the closing line (if
   asked for) joins the turns, and the cards are scored, once. A roleplay
   whose call fails stays open with Try again. A find-out ends either way,
   as lessons-web's does: its turns are spent, and a failed feedback
   call leaves "Ask for feedback again". */
async function finish({ closing }) {
  const s = session;
  if (!s || working) return;
  working = 'grading';
  retry = null;
  showError('');
  render();
  try {
    const clips = s.kind === 'roleplay' ? await clipsOf(s) : [];
    const got = await store.client.concludeConversation(s, liveCards(s), { closing, clips });
    if (session !== s) return;
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
      moves = scored.moves;
      saved = scored.saved;
    }
    await save();
  } catch (e) {
    console.error(e);
    if (session !== s) return;
    if (s.kind === 'findout') {
      s.ended = true;
      s.feedback = null;
      await save();
      showError(`The conversation is over, but the feedback could not be fetched. ${describe(e)}`);
    } else {
      retry = () => (closing ? answer() : finish({ closing: false }));
      showError(`${describe(e)} Your turns are kept.`, true);
    }
  } finally {
    working = null;
    render();
  }
  if (session === s && s.ended) $('cv-result').scrollIntoView({ block: 'start', behavior: 'smooth' });
}

/* ── drawing ─────────────────────────────────────────────────────────── */

function render() {
  const briefing = !session;
  $('cv-briefing').hidden = !briefing;
  if (briefing) renderBriefing();
  $('cv-card').hidden = briefing;
  if (!briefing) {
    renderScene();
    renderChat();
    renderInput();
    renderResult();
  }
  renderList();
  renderQuota();
}

function renderScene() {
  const s = session;
  const sc = s.scenario;
  const lang = escapeHtml(languageCode(s.language || store.state.settings.targetLanguage));
  const findOut = s.kind === 'findout';
  const status = findOut ? factStatus(s) : null;
  $('cv-meta').innerHTML = [
    findOut ? 'Find out' : 'Roleplay',
    escapeHtml(s.created),
    s.ended ? 'ended' : `turn ${Math.min(learnerTurns(s) + 1, turnsOf(s))} of ${turnsOf(s)}`,
    s.level ? escapeHtml(s.level) : '',
  ].filter(Boolean).map((x) => `<span>${x}</span>`).join('');

  const rows = [
    ['The situation', findOut ? sc.situation : sc.scenario],
    ['You are', sc.studentRole],
    ['You’re talking to', sc.llmRole],
  ];
  if (findOut) rows.push(['What you were sent to find out', sc.goal]);
  let html = `<dl class="cv-brief">${rows.map(([k, v]) => `<dt>${k}</dt><dd lang="${lang}">${escapeHtml(v)}</dd>`).join('')}</dl>`;
  if (findOut) {
    const revealed = normaliseIds(s.revealed, sc.facts);
    html += `<div class="cv-facts">
      <div class="cv-facts-head">What you need to find out: ${status.found.length} of ${sc.facts.length}</div>
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
  return `<div class="cv-facts cv-try">
      <div class="cv-facts-head">Try to use these in your turns</div>
      <ul>${cards.map((c) => `<li>
        <span class="cv-try-front" lang="${lang}">${escapeHtml(c.front)}</span>
        <span class="cv-try-back">${c.type === 'pattern' ? 'grammar pattern · ' : ''}${escapeHtml(c.back || '')}</span>
      </li>`).join('')}</ul>
    </div>`;
}

function renderChat() {
  const s = session;
  const lang = escapeHtml(languageCode(s.language || store.state.settings.targetLanguage));
  const bubbles = s.turns.map((t, i) => `<div class="cv-bubble cv-bubble--${t.speaker === 'learner' ? 'me' : 'them'}">
      <span class="cv-who">${escapeHtml(t.speaker === 'learner' ? s.scenario.studentRole : s.scenario.llmRole)}${t.take
        ? ` <button type="button" class="cv-play" data-play="${i}" aria-label="Play your recording of this turn" title="Play your recording">▶</button>` : ''}</span>
      <span class="cv-said" lang="${lang}">${escapeHtml(t.text)}</span>
    </div>`);
  if (working === 'listening') {
    bubbles.push(`<div class="cv-bubble cv-bubble--me cv-thinking" aria-live="polite">
      <span class="cv-who">${escapeHtml(s.scenario.studentRole)}</span>
      <span class="cv-said"><span class="spinner"></span>Writing down what you said</span>
    </div>`);
  }
  if (working === 'sending' || working === 'grading') {
    bubbles.push(`<div class="cv-bubble cv-bubble--them cv-thinking" aria-live="polite">
      <span class="cv-who">${escapeHtml(working === 'grading' ? 'Feedback' : s.scenario.llmRole)}</span>
      <span class="cv-said"><span class="spinner"></span>${working === 'grading' ? 'Reading the whole conversation' : 'Thinking'}</span>
    </div>`);
  }
  $('cv-chat').innerHTML = bubbles.join('');
}

function renderInput() {
  const s = session;
  const area = $('cv-input-area');
  if (!s || s.ended) { area.hidden = true; return; }
  area.hidden = false;
  const n = learnerTurns(s);
  const waiting = awaitingReply(s);
  $('cv-turn').textContent = waiting
    ? `Turn ${n} of ${turnsOf(s)} · waiting for the reply`
    : `Turn ${n + 1} of ${turnsOf(s)}`;
  const text = $('cv-text');
  text.disabled = !!working || waiting;
  text.lang = languageCode(s.language || store.state.settings.targetLanguage);
  text.placeholder = waiting ? 'Your turn is kept. Press Try again above.' : `Your turn, in ${s.language || store.state.settings.targetLanguage}…`;
  const st = store.state.settings;
  const replyBlocked = store.limiter.usageOf(st, n + 1 >= turnsOf(s) && s.kind === 'roleplay' ? st.conversationGradeModel : st.chatModel).retryAfter > 0;
  const gradeBlocked = store.limiter.usageOf(st, st.conversationGradeModel).retryAfter > 0;
  $('cv-send').disabled = !!working || waiting || recording || !text.value.trim() || !storage.getApiKey() || replyBlocked;
  $('cv-end').disabled = !!working || recording || n < 1 || !storage.getApiKey() || gradeBlocked;
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
  btn.disabled = !!working || waiting || !storage.getApiKey();
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
    $('cv-send-take').disabled = !!working || waiting || listenBlocked || replyBlocked || !storage.getApiKey();
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
  if (!fb) {
    el.innerHTML = `<div class="banner is-warn wr-fb">The feedback on this conversation could not be fetched.
      <button class="btn btn--sm" data-act="ask-again"${working ? ' disabled' : ''}>Ask for feedback again</button></div>`;
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
            r.created, r.kind === 'findout' ? 'find out' : 'roleplay', r.decks && r.decks.length ? r.decks.join(', ') : '', r.language,
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
  const record = await store.loadConversation(id);
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
  if (working && session && session.id === id) return;
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
  if (!session) renderStart();
  else renderInput();
  /* Why Send or End is greyed out, said beside them rather than only in a
     tooltip. A call is refused while its model is out of budget, never
     queued, so the turn waits in the box until then. */
  const wait = $('cv-wait');
  const blocked = session && !session.ended && !working
    ? [c, g].find((u) => u.retryAfter > 0) : null;
  wait.hidden = !blocked;
  if (blocked) wait.textContent = `${blocked.model} is out of budget for now: next call in ${formatWait(blocked.retryAfter)}.`;
  $('cv-send').title = `One call on ${s.chatModel}`;
  $('cv-end').title = `One call on ${s.conversationGradeModel}`;
}

function showError(text, withRetry = false) {
  const el = $('cv-error');
  el.innerHTML = text
    ? `<div class="banner is-bad">${escapeHtml(text)}${withRetry ? ' <button class="btn btn--sm" data-act="retry">Try again</button>' : ''}</div>`
    : '';
}
