/* Shared state: the settings, every deck, and the API budget.

   Tabs read from here and call save*(); they never touch the store
   themselves. Subscribers are notified after every change so, for example,
   editing a deck in the Flashcards tab immediately changes what the practice
   tabs draw from.

   Two different questions get asked about decks and they have different
   answers:

     state.deckName / state.cards   the one deck open in the Flashcards editor
     practiceDecks() / practiceCards()
                                    the decks ticked for practice, which the
                                    Typing and Dictation tabs draw from

   Every deck in the store is held in state.decks, because practice spans
   several of them at once and a card answered in one must be written back to
   its own file — never to whichever deck happens to be open. */

import * as storage from './storage.js';
import { withDefaults, STARTER_DECK, DEFAULT_SETTINGS } from './defaults.js';
import { parseDeck, serializeDeck, normalizeCard, slugify } from './deck.js';
import { makeBundle, bundleCards } from './bundle.js';
import { RateLimiter, createClient } from './gemini.js';
import {
  rulesFor, withRules, languageKey, seedEntry, applyRevision, undoRevision,
  editRules, shouldRevise, ratingsFor, collectRated, countRatings, totalOf,
  isRating, ratingsByGeneration,
} from './shadow-rules.js';

const SETTINGS_FILE = 'settings.json';
const QUOTA_FILE = 'audio/quota.json';
const MANIFEST_FILE = 'audio/manifest.json';
const SHADOW_FILE = 'shadowing/manifest.json';

export const state = {
  settings: withDefaults(null),
  deckName: 'default',
  deckNames: [],
  /* name -> cards. The one store of card objects; state.cards is a window
     onto the open deck rather than a second copy of it. */
  decks: { default: STARTER_DECK.map(normalizeCard) },
  /* The one sentence bank. Dictation and Shadowing both draw from it and both
     write into it, so a sentence written on either tab is immediately
     available on the other and nothing in an entry says which tab made it. */
  manifest: [],
  /* The shadowing session index — one row per set handed in. The recordings
     and the feedback live in their own files beside it. */
  shadowSessions: [],
  /* True once a store is connected: until then everything is in memory and
     is lost on reload, which the UI has to keep saying out loud. */
  persistent: false,
  /* False until boot has looked for a store and adopted whatever it found.
     Before that, state.decks holds only the starter deck the page boots
     with, which may be nothing like the user's — so nothing should be drawn
     from it, and certainly not read aloud. */
  ready: false,

  get cards() { return this.decks[this.deckName] || []; },
  set cards(cards) { this.decks[this.deckName] = cards; },
};

const subs = {
  settings: new Set(), deck: new Set(), folder: new Set(), quota: new Set(),
  /* The sentence bank changed. Both practice tabs listen, so a sentence
     written on one updates the other's counts without either having to be the
     tab you happen to be looking at. */
  bank: new Set(),
  shadow: new Set(),
  ready: new Set(),
};

export function subscribe(topic, fn) {
  subs[topic].add(fn);
  return () => subs[topic].delete(fn);
}

function emit(topic) {
  for (const fn of subs[topic]) {
    try { fn(state); } catch (e) { console.error(e); }
  }
}

/* ── the API budget ──────────────────────────────────────────────────── */

export const limiter = new RateLimiter({
  save: (s) => {
    if (state.persistent) storage.writeJson(QUOTA_FILE, s);
    else storage.localSet('quota', s);
    emit('quota');
  },
});

export const client = createClient({
  getSettings: () => state.settings,
  getApiKey: storage.getApiKey,
  limiter,
});

export function quotaReport() {
  return limiter.report(state.settings);
}

export function resetQuota() {
  limiter.reset();
  emit('quota');
}

/* ── settings ────────────────────────────────────────────────────────── */

/* Saved Azure clips, in voice/. Reading works whatever the store; writing
   only when something is persisted — otherwise the clip lives for the
   session, in speech.js's memory. */
export function readVoiceClip(name) {
  return storage.readBlob(`voice/${name}`);
}

export async function writeVoiceClip(name, blob) {
  if (!state.persistent) return false;
  return storage.writeBlob(`voice/${name}`, blob);
}

export async function countVoiceClips() {
  return (await storage.listIn('voice')).filter((n) => n.endsWith('.mp3')).length;
}

/* Boot is done: the stored decks, if any, are in place. Called once. */
export function markReady() {
  state.ready = true;
  emit('ready');
}

export async function saveSettings(patch) {
  state.settings = withDefaults({ ...state.settings, ...patch });
  if (state.persistent) await storage.writeJson(SETTINGS_FILE, state.settings);
  else storage.localSet('settings', state.settings);
  emit('settings');
}

/* ── decks ───────────────────────────────────────────────────────────── */

function deckPath(name) {
  return `decks/${name}.json`;
}

/* Which deck a card came from. Kept beside the cards rather than on them: a
   `deck` key on the card would be written straight into the deck file by the
   next save, and the deck file is something people read and diff. */
const cardDeck = new WeakMap();

function adopt(name, cards) {
  for (const card of cards) cardDeck.set(card, name);
  state.decks[name] = cards;
  return cards;
}

export function deckOf(card) {
  return cardDeck.get(card) || state.deckName;
}

async function readDeckFile(name) {
  const text = await storage.readText(deckPath(name));
  if (text === null) return null;
  const parsed = parseDeck(text);
  if (parsed.error) {
    console.error(`decks/${name}.json: ${parsed.error}`);
    return null;
  }
  return parsed.cards;
}

export async function loadDeck(name) {
  if (!state.persistent) return false;
  const cards = await readDeckFile(name);
  if (!cards) return false;
  adopt(name, cards);
  state.deckName = name;
  storage.localSet('lastDeck', name);
  emit('deck');
  return true;
}

export async function saveDeck(name = state.deckName) {
  if (!state.persistent) { emit('deck'); return true; }
  const ok = await storage.writeText(deckPath(name), serializeDeck(state.decks[name] || []));
  emit('deck');
  return ok;
}

/* Called by the practice tabs after recordResult() has already mutated the
   cards in place. Each card is written back to the deck it came from, which
   in a multi-deck session is rarely the one open in the editor. */
export async function cardAnswered(...cards) {
  const names = new Set(cards.filter(Boolean).map(deckOf));
  if (!names.size) names.add(state.deckName);
  let ok = true;
  for (const name of names) ok = (await saveDeck(name)) && ok;
  return ok;
}

/* The same write under the name to use when the edit was not an answer —
   notes typed during practice, say. Which deck a card belongs to is the only
   question either one is really asking. */
export const saveCardDecks = cardAnswered;

export async function refreshDeckList() {
  state.deckNames = state.persistent ? await storage.listDecks() : [state.deckName];
  for (const name of Object.keys(state.decks)) {
    if (name !== state.deckName && !state.deckNames.includes(name)) delete state.decks[name];
  }
  emit('deck');
  return state.deckNames;
}

export async function createDeck(label, cards) {
  const name = uniqueDeckName(slugify(label));
  /* Read before state.deckName moves. With nothing ticked, practiceDecks()
     falls back to the open deck — and that fallback has to mean the deck that
     was open, not the one being created, or making your second deck silently
     takes the first one out of practice. */
  const ticked = practiceDecks();
  adopt(name, (cards || []).map(normalizeCard));
  state.deckName = name;
  await saveDeck(name);
  await refreshDeckList();
  storage.localSet('lastDeck', name);
  /* A deck you just made is one you meant to study, so it starts ticked. */
  await setPracticeDecks([...ticked, name]);
  emit('deck');
  return name;
}

export async function renameDeck(label) {
  const next = uniqueDeckName(slugify(label));
  const previous = state.deckName;
  if (next === previous) return previous;
  adopt(next, state.decks[previous] || []);
  delete state.decks[previous];
  state.deckName = next;
  await saveDeck(next);
  if (state.persistent) await storage.remove(deckPath(previous));
  await refreshDeckList();
  storage.localSet('lastDeck', next);
  /* The tick follows the deck across the rename; it is the same deck. */
  const ticked = state.settings.practiceDecks || [];
  if (ticked.includes(previous)) {
    await setPracticeDecks(ticked.map((n) => (n === previous ? next : n)));
  }
  return next;
}

export async function deleteDeck() {
  const gone = state.deckName;
  if (state.persistent) await storage.remove(deckPath(gone));
  delete state.decks[gone];
  await refreshDeckList();
  const next = state.deckNames.find((n) => n !== gone);
  if (next) await loadDeck(next);
  else await createDeck('default', STARTER_DECK);
  await setPracticeDecks((state.settings.practiceDecks || []).filter((n) => n !== gone));
  return state.deckName;
}

function uniqueDeckName(base) {
  /* The open deck is not a clash with itself: renaming a deck to the name it
     already has has to be allowed to do nothing. */
  return freeDeckName(base, new Set(state.deckNames.filter((n) => n !== state.deckName)));
}

function freeDeckName(base, taken) {
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function setCards(cards) {
  adopt(state.deckName, cards);
  emit('deck');
}

/* ── which decks practice draws from ─────────────────────────────────── */

/* Derived, never stored as truth: the saved list is filtered through the decks
   that actually exist, so a deck deleted or renamed behind the app's back
   cannot leave practice pointing at nothing. The result is never empty — with
   no valid tick left, the open deck stands in, because "no decks selected"
   is a state with no useful behaviour behind it. */
export function practiceDecks() {
  const names = state.deckNames.length ? state.deckNames : [state.deckName];
  const wanted = state.settings.practiceDecks || [];
  const kept = names.filter((n) => wanted.includes(n));
  if (kept.length) return kept;
  return [names.includes(state.deckName) ? state.deckName : names[0]];
}

export function isPracticeDeck(name) {
  return practiceDecks().includes(name);
}

/* Refuses to leave the selection empty — the caller gets back what is actually
   in force, so a UI that tried to untick the last deck can put the tick back. */
export async function setPracticeDecks(names) {
  const list = (state.deckNames.length ? state.deckNames : [state.deckName])
    .filter((n) => names.includes(n));
  if (!list.length) return practiceDecks();
  await saveSettings({ practiceDecks: list });
  emit('deck');
  return practiceDecks();
}

/* Every card practice may draw from, in deck order. */
export function practiceCards() {
  const out = [];
  for (const name of practiceDecks()) out.push(...(state.decks[name] || []));
  return out;
}

/* The same, split by deck — for the one exercise that must not mix decks. */
export function practiceGroups() {
  return practiceDecks()
    .map((name) => ({ name, cards: state.decks[name] || [] }))
    .filter((g) => g.cards.length);
}

/* Find a card by its front text. The deck it was recorded against is tried
   first, so two decks that share a word still score the right card. */
export function findCard(front, preferred) {
  for (const name of [preferred, ...practiceDecks()]) {
    if (!name) continue;
    const hit = (state.decks[name] || []).find((c) => c.front === front);
    if (hit) return { card: hit, deck: name };
  }
  return null;
}

/* ── the sentence bank ───────────────────────────────────────────────── */

/* Shared by Dictation and Shadowing. Writing it emits, so the tab that is not
   in front of you still has the right counts when you switch to it. */
export async function saveManifest() {
  if (state.persistent) await storage.writeJson(MANIFEST_FILE, state.manifest);
  emit('bank');
}

/* Whether a banked sentence belongs to the decks currently ticked.

   One rule, in one place, because both practice tabs ask it and an answer
   that differed between them would mean a sentence you could shadow but not
   hear, or the reverse. Sentences banked before decks were tagged carry no
   deck at all; those are placed by their target words instead, so an older
   folder keeps working rather than emptying out. */
export function bankInScope(entry) {
  if (!entry) return false;
  if (entry.deck) return isPracticeDeck(entry.deck);
  const known = new Set(practiceCards().map((c) => c.front));
  return (entry.terms || []).some((t) => known.has(t));
}

/* Both tabs count on the same entry. `times_practiced` is dictations typed,
   `times_shadowed` is sets it was read aloud in — kept apart because they
   answer different questions, and because each tab prefers what the other has
   not used yet. */
export async function markPractised(entry) {
  entry.times_practiced = (entry.times_practiced || 0) + 1;
  entry.last_practiced = new Date().toISOString().slice(0, 10);
  await saveManifest();
}

export async function markShadowed(entries) {
  const today = new Date().toISOString().slice(0, 10);
  for (const entry of entries) {
    if (!entry) continue;
    entry.times_shadowed = (entry.times_shadowed || 0) + 1;
    entry.last_shadowed = today;
  }
  await saveManifest();
}

/* ── the shadowing sessions ──────────────────────────────────────────── */

export function sessionPath(id) {
  return `shadowing/${id}.json`;
}

export async function saveShadowIndex() {
  if (state.persistent) await storage.writeJson(SHADOW_FILE, state.shadowSessions);
  emit('shadow');
}

/* The session file is the record; the index is a summary of it kept beside it
   so the history list can be drawn without opening every session. Both are
   written together, index last, so a crash between them leaves the index
   behind the truth rather than ahead of it. */
export async function saveSession(session) {
  if (state.persistent) await storage.writeJson(sessionPath(session.id), session);
  const row = summariseSession(session);
  const at = state.shadowSessions.findIndex((s) => s.id === session.id);
  if (at === -1) state.shadowSessions.unshift(row);
  else state.shadowSessions[at] = row;
  await saveShadowIndex();
}

/* The rules version and the rating counts ride in the index row so that
   "is a revision due?" is a sum over the index, not a read of every session
   file. */
function summariseSession(session) {
  const fb = session.feedback;
  return {
    id: session.id,
    created: session.created,
    status: session.status,
    itemCount: (session.items || []).length,
    recorded: (session.items || []).filter((i) => i.file).length,
    language: session.language,
    decks: [...new Set((session.items || []).map((i) => i.deck).filter(Boolean))],
    rulesGeneration: fb && Number.isInteger(fb.rulesGeneration) ? fb.rulesGeneration : null,
    ratings: countRatings(fb && fb.notes),
    ratingsByGeneration: ratingsByGeneration(fb),
  };
}

export async function loadSession(id) {
  if (!state.persistent) return null;
  return storage.readJson(sessionPath(id));
}

/* Takes the recordings with it. An index row whose blobs are still on disk
   would leave voice recordings in a folder the app no longer lists, which is
   the one kind of leftover this feature must not create. */
export async function deleteSession(id) {
  const session = await loadSession(id);
  if (state.persistent) {
    for (const item of (session && session.items) || []) {
      if (item.file) await storage.remove(item.file);
    }
    /* Anything else carrying this id — a take whose session file never landed,
       or one written under a mime this build no longer uses. */
    for (const name of await storage.listIn('shadowing')) {
      if (name.startsWith(`${id}_`) || name === `${id}.json`) await storage.remove(`shadowing/${name}`);
    }
  }
  state.shadowSessions = state.shadowSessions.filter((s) => s.id !== id);
  await saveShadowIndex();
}

/* Every recording, everywhere. The release valve for a data folder that has
   been accumulating sessions for a year. */
export async function deleteAllSessions() {
  const ids = state.shadowSessions.map((s) => s.id);
  for (const id of ids) await deleteSession(id);
  if (state.persistent) {
    /* Sweep whatever is left, including files from a session whose index row
       went missing. manifest.json is the index itself and stays. */
    for (const name of await storage.listIn('shadowing')) {
      if (name !== 'manifest.json') await storage.remove(`shadowing/${name}`);
    }
  }
  state.shadowSessions = [];
  await saveShadowIndex();
  return ids.length;
}

/* ── the listening rules ─────────────────────────────────────────────── */

/* The rules of the language being practised, or null when it has none yet.
   Everything below works on the current language only: rules for another
   language are kept but never touched, so switching back finds them as they
   were left. */
export function currentRules() {
  return rulesFor(state.settings, state.settings.targetLanguage);
}

async function putRules(entry) {
  const s = state.settings;
  await saveSettings({ shadowRules: withRules(s, s.targetLanguage, entry) });
  return entry;
}

/* The first time a language is handed in, its rules are drafted. A language
   that already has rules costs nothing here. */
export async function ensureRules() {
  return currentRules() || putRules(seedEntry(await client.draftShadowRules()));
}

/* Drafted from scratch, as a new version so Undo brings the old ones back.
   Rules you wrote yourself are kept, as they are through any revision. */
export async function redraftRules() {
  const reply = await client.draftShadowRules();
  const entry = currentRules();
  return putRules(entry
    ? applyRevision(entry, { ...reply, changes: [], reason: 'Drafted again from scratch.' })
    : seedEntry(reply));
}

export async function undoRules() {
  const back = undoRevision(currentRules());
  return back ? putRules(back) : null;
}

/* Null when the text says what the rules already say. */
export async function editRulesText(text) {
  const next = editRules(currentRules(), text);
  return next ? putRules(next) : null;
}

/* Forgets this language's rules entirely; the next set handed in drafts new
   ones. Ratings already given stay on their sessions, pinned on a version
   that no longer exists, and so count towards nothing. */
export async function clearRules() {
  const key = languageKey(state.settings.targetLanguage);
  const map = { ...(state.settings.shadowRules || {}) };
  delete map[key];
  await saveSettings({ shadowRules: map });
}

export function rulesRatings(generation) {
  return ratingsFor(state.shadowSessions, state.settings.targetLanguage, generation);
}

/* A rating on one note, or none: picking the rating a note already has takes
   it off again. `why` is kept only alongside a rating that is not useful — it
   is what the learner says was missed, and "useful" needs no reason. */
export async function rateNote(session, itemIndex, rating, why = '') {
  const note = session && session.feedback && (session.feedback.notes || [])
    .find((n) => n.itemIndex === itemIndex);
  if (!note) return;
  if (!isRating(rating) || note.rating === rating) {
    delete note.rating;
    delete note.why;
  } else {
    note.rating = rating;
    const text = String(why || '').trim().slice(0, 200);
    if (rating !== 'useful' && text) note.why = text;
    else delete note.why;
  }
  await saveSession(session);
}

export async function setNoteWhy(session, itemIndex, why) {
  const note = session && session.feedback && (session.feedback.notes || [])
    .find((n) => n.itemIndex === itemIndex);
  if (!note || !note.rating || note.rating === 'useful') return;
  const text = String(why || '').trim().slice(0, 200);
  if (text) note.why = text;
  else delete note.why;
  await saveSession(session);
}

/* Revises this language's rules from your ratings when enough of them say
   something is off, and returns the new version — or null, which is the
   common case and costs nothing. `inHand` is the session on screen, used
   when nothing is being saved and so no session can be read back.

   One revision at a time: ratings arrive a click apart, and two revisions of
   the same version would each make a new one from the same evidence. */
let revising = false;

export function shouldReviseRules() {
  const s = state.settings;
  return !revising && shouldRevise(currentRules(), state.shadowSessions, s.targetLanguage, s.shadowReviseAfter);
}

export async function reviseRulesIfDue(inHand = null) {
  const s = state.settings;
  const entry = currentRules();
  if (!shouldReviseRules()) return null;
  revising = true;
  try {
    const key = languageKey(s.targetLanguage);
    const sessions = [];
    for (const row of state.shadowSessions) {
      if (languageKey(row.language) !== key) continue;
      if (!totalOf(ratingsFor([row], s.targetLanguage, entry.generation))) continue;
      const loaded = inHand && inHand.id === row.id ? inHand : await loadSession(row.id);
      if (loaded) sessions.push(loaded);
    }
    /* The newest ratings, and not an unbounded number of them: a threshold
       set high should not become a prompt nobody can afford. */
    const rated = collectRated(sessions, s.targetLanguage, entry.generation).slice(0, 40);
    if (!rated.length) return null;

    const before = (entry.history || []).at(-1);
    const beforeCounts = before ? rulesRatings(before.generation) : null;
    const reply = await client.reviseShadowRules({
      entry,
      rated,
      current: rulesRatings(entry.generation),
      previous: before ? {
        generation: before.generation,
        rules: before.rules,
        counts: beforeCounts && totalOf(beforeCounts) ? beforeCounts : null,
      } : null,
    });
    /* The rules may have been edited, undone or cleared while the call was
       out. Then this revision is of something that no longer exists, and
       applying it would quietly throw away what was done meanwhile. */
    const now = currentRules();
    if (!now || now.generation !== entry.generation) return null;
    return putRules(applyRevision(entry, reply));
  } finally {
    revising = false;
  }
}

/* ── the bundle: everything out, and back in ─────────────────────────── */

/* Whatever is in hand, which with a store connected is every deck it holds and
   without one is the single deck in memory. */
export function exportBundle(now = new Date()) {
  const names = [...state.deckNames, ...Object.keys(state.decks)];
  const decks = [];
  const seen = new Set();
  for (const name of names) {
    if (seen.has(name) || !state.decks[name]) continue;
    seen.add(name);
    decks.push([name, state.decks[name]]);
  }
  return makeBundle({ settings: state.settings, decks, now });
}

/* Additive, and never destructive: a deck whose name is taken is imported
   under a free one. Importing the same bundle twice therefore gives two copies
   rather than one merged deck — reconciling two histories of the same card is
   the one thing this cannot do without guessing, and guessing would quietly
   throw away practice.

   Needs a store. Without one, refreshDeckList() keeps only the open deck, so a
   four-deck bundle would come in and three quarters of it would vanish at the
   next edit; the UI asks for a folder first instead. */
export async function importBundle(bundle, { settings: withSettings = true } = {}) {
  if (!state.persistent) throw new Error('Nothing is being saved, so there is nowhere to import to.');

  const taken = new Set([...state.deckNames, ...Object.keys(state.decks)]);
  const added = [];
  for (const [from, cards] of bundle.decks) {
    const name = freeDeckName(slugify(from), taken);
    taken.add(name);
    adopt(name, bundleCards(cards));
    await saveDeck(name);
    added.push({ from, name });
  }

  /* Open the first thing that came in, so an import is something you can see. */
  if (added.length) {
    state.deckName = added[0].name;
    storage.localSet('lastDeck', state.deckName);
  }
  await refreshDeckList();

  if (withSettings && bundle.settings) {
    /* practiceDecks is dropped on the way in: it names decks as the bundle
       called them, and anything renamed above would leave a tick pointing at
       nothing. What was imported is ticked below instead. */
    const { practiceDecks: _ticks, ...rest } = bundle.settings;
    await saveSettings(rest);
  }
  if (added.length) await setPracticeDecks([...practiceDecks(), ...added.map((a) => a.name)]);

  emit('deck');
  return added;
}

/* ── connecting ──────────────────────────────────────────────────────── */

/* Read everything the store holds, creating what a fresh one lacks. Whether
   that store is a picked folder or the browser's own is storage.js's business,
   not this file's. A store is adopted exactly as it is found: this never
   overwrites a deck or a settings file that is already there. */
export async function adoptFolder() {
  state.persistent = true;
  await storage.ensureSubdirs();

  const loadedSettings = await storage.readJson(SETTINGS_FILE);
  state.settings = withDefaults(loadedSettings || storage.localGet('settings', null));
  if (!loadedSettings) await storage.writeJson(SETTINGS_FILE, state.settings);

  const quota = await storage.readJson(QUOTA_FILE);
  limiter.setState(quota || storage.localGet('quota', null));

  state.manifest = (await storage.readJson(MANIFEST_FILE)) || [];
  if (!Array.isArray(state.manifest)) state.manifest = [];

  state.shadowSessions = (await storage.readJson(SHADOW_FILE)) || [];
  if (!Array.isArray(state.shadowSessions)) state.shadowSessions = [];

  let names = await storage.listDecks();
  if (!names.length) {
    await storage.writeText(deckPath('default'), serializeDeck(STARTER_DECK.map(normalizeCard)));
    names = ['default'];
  }
  state.deckNames = names;

  /* Every deck, not just the open one: practice spans whichever are ticked,
     and a deck cannot be drawn from until its cards are in hand. */
  state.decks = {};
  for (const name of names) adopt(name, (await readDeckFile(name)) || []);

  const preferred = storage.localGet('lastDeck', null);
  const pick = names.includes(preferred) ? preferred : names[0];
  state.deckName = pick;
  storage.localSet('lastDeck', pick);

  emit('settings');
  emit('deck');
  emit('folder');
  emit('quota');
  emit('bank');
  emit('shadow');
}

export function releaseFolder() {
  const open = state.cards;
  state.persistent = false;
  state.manifest = [];
  state.shadowSessions = [];
  state.deckNames = [state.deckName];
  /* Only the open deck is still in memory, so it is the only thing practice
     can honestly be said to draw from. */
  state.decks = {};
  adopt(state.deckName, open);
  emit('folder');
  emit('deck');
  emit('bank');
  emit('shadow');
}

/* Boot with whatever can be had without a store, so the page is usable the
   moment it loads: the starter deck, defaults, and any settings remembered
   from a previous in-memory session. */
export function bootLocal() {
  state.settings = withDefaults(storage.localGet('settings', null));
  limiter.setState(storage.localGet('quota', null));
  state.deckName = 'default';
  state.decks = {};
  adopt('default', STARTER_DECK.map(normalizeCard));
  state.deckNames = ['default'];
  state.manifest = [];
  state.shadowSessions = [];
  emit('settings');
  emit('deck');
  emit('quota');
}

export { DEFAULT_SETTINGS };
