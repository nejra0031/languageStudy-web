/* Deck format, scoring, and card selection.

   A deck file is a top-level JSON array of cards — exactly what the Flashcards
   textarea shows, so the file is the UI and there is nothing hidden.

     front      the word or phrase in the language being learnt
     back       its meaning
     notes      optional: an example sentence, a usage note, anything
     score      1..5, recomputed from recent[] after every answer
     recent     the last 8 results, oldest first
     last_seen  ISO date of the last answer
     alternatives  optional: other meanings accepted as right, beside back
     accent_slip   optional: true while the word's last miss was the accents
                only. Set by a right-word-wrong-accents answer, cleared by an
                exact one, and what the Accents filter drills.

   encounters and correct are derived from recent[] on demand and never
   stored: a rolling window of 8 is the only history kept, so a second copy of
   the same numbers could only ever drift out of step with it. */

import { words, termPieces } from './text.js';

export const WINDOW = 8;
export const SCORE_LABEL = ['', 'Very weak', 'Weak', 'Developing', 'Good', 'Mastered'];

export function stats(card) {
  const recent = Array.isArray(card && card.recent) ? card.recent : [];
  const encounters = recent.length;
  const correct = recent.filter(Boolean).length;
  return { encounters, correct, accuracy: encounters ? correct / encounters : 0 };
}

/* The one implementation of the scoring rules. Both practice modes call it;
   nothing else may reimplement it.

   accentSlip marks an answer that had the right word with the wrong accents.
   It still counts as wrong — accents are the skill being drilled — but it also
   flags the card for the Accents filter until the word is next typed exactly.
   A plain wrong answer leaves the flag as it was, and so does a right answer
   typed in the other direction (typedFront false): getting the meaning right
   says nothing about whether the accents have been learnt. */
export function recordResult(card, ok, { accentSlip = false, typedFront = true } = {}) {
  const before = card.score;
  if (accentSlip) card.accent_slip = true;
  else if (ok && typedFront) delete card.accent_slip;
  card.recent = Array.isArray(card.recent) ? card.recent : [];
  card.recent.push(!!ok);
  while (card.recent.length > WINDOW) card.recent.shift();

  const { encounters, correct, accuracy } = stats(card);
  if (accuracy <= 0.20) card.score = 1;
  else if (accuracy <= 0.40) card.score = 2;
  else if (accuracy <= 0.60) card.score = 3;
  else if (accuracy <= 0.80) card.score = 4;
  else card.score = 5;

  /* Probation: a card answered a handful of times cannot be called Good or
     Mastered on the strength of a short streak. It has to survive a full
     window first. */
  if (encounters < WINDOW && card.score > 2) card.score = 2;

  card.last_seen = today();
  return { before, after: card.score, encounters, correct };
}

/* Turn the answer just recorded into a right one — the learner has said that a
   meaning they typed is as good as the card's. The wrong answer is taken back
   out of the window and a right one recorded in its place, through the same
   rules as any other answer rather than by poking at the score. */
export function amendLastToRight(card) {
  if (Array.isArray(card.recent) && card.recent.length && card.recent[card.recent.length - 1] === false) {
    card.recent.pop();
  }
  return recordResult(card, true, { typedFront: false });
}

/* Adds a meaning to the card's alternatives, unless it already matches one of
   the meanings the card has. Returns true when the card changed. `same` is the
   caller's idea of equality, because deck.js does not judge text. */
export function addAlternative(card, text, same) {
  const t = String(text || '').trim();
  if (!t || meanings(card).some((m) => same(t, m))) return false;
  card.alternatives = [...(card.alternatives || []), t];
  return true;
}

/* Every answer that counts as this card's meaning: the back, then any
   alternatives the learner has accepted. */
export function meanings(card) {
  return [card.back, ...((card && card.alternatives) || [])];
}

export function today() {
  return new Date().toISOString().slice(0, 10);
}

/* How much likelier this card is to come up than a mastered one. A score-1
   card weighs 25 against a score-5 card's 1, which is what keeps practice on
   the weak material. */
export function cardWeight(card) {
  return (6 - ((card && card.score) || 1)) ** 2;
}

function drawIndex(weights) {
  const total = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

/* Weighted draw, without replacement. */
export function pickWeighted(pool, n = 1) {
  const rest = pool.slice();
  const out = [];
  while (out.length < n && rest.length) {
    out.push(rest.splice(drawIndex(rest.map(cardWeight)), 1)[0]);
  }
  return out;
}

/* Pick one group of cards — in practice one deck — from several.

   Dictation builds each sentence from a single deck, so the deck has to be
   chosen before the cards are. Weighting a deck by the sum of its cards'
   weights makes that choice invisible: every card ends up exactly as likely
   to be drawn as it would have been from one flat pool, so ticking a second
   deck does not quietly halve how often the first one is practised. */
export function pickGroup(groups) {
  if (!groups.length) return null;
  const weights = groups.map((g) => g.cards.reduce((sum, c) => sum + cardWeight(c), 0));
  return groups[drawIndex(weights)];
}

export function inScope(card, scope) {
  if (scope === 'accents') return !!card.accent_slip;
  if (scope === 'weak') return (card.score || 1) <= 2;
  if (scope === 'developing') return (card.score || 1) <= 3;
  return true;
}

/* A card whose front is a grammar pattern rather than a word or phrase:
   "hễ … là …", "A mà B". Said by the card itself, in an optional
   `"type": "pattern"`, rather than guessed from the front — a capital letter
   is a placeholder in "A mà B" and a word in Spanish "A veces", and only the
   card's author knows which. Any other `type` (word, phrase, sentence …) is
   carried through untouched and changes nothing, as before. */
export function isPattern(card) {
  return String((card && card.type) || '').trim().toLowerCase() === 'pattern';
}

/* Can this card be a dictation target?

   The question is "could this be heard and matched word for word?", which is
   not the same as "could this be typed from a prompt". Grammar notes and usage
   entries are perfectly good dictation targets even though they make poor
   typing cards, and that is where the weak scores tend to live. What is
   excluded is anything with no matchable string: comparisons, slashed
   alternatives and placeholder formulas.

   A pattern card is matched on its fixed words in order, gaps and all (see
   text.js), so its ellipses and letters are no obstacle. It still needs two
   fixed words or more: "… được" or "về …" would count as used by any
   sentence with that one common word in it, in whatever sense, and typing it
   back tests nothing about the pattern. The six-word limit a phrase has, so
   it can be heard as a unit, applies to each fixed part of a pattern rather
   than to all of them together. A card that only looks like a pattern but
   is not marked as one is judged as before, so an ellipsis still keeps it
   out. */
export function isDictatable(card) {
  const t = String((card && card.front) || '');
  if (!t) return false;
  if (/\svs\.?\s/i.test(t)) return false;
  if (t.includes('/') || t.includes('+')) return false;
  if (isPattern(card)) {
    const pieces = termPieces(t, true);
    return pieces.flat().length >= 2 && pieces.every((p) => p.length <= 6);
  }
  if (t.includes('…') || t.includes('...')) return false;
  const core = words(t.replace(/\([^)]*\)/g, ' '));
  return core.length >= 1 && core.length <= 6;
}

const KNOWN_KEYS = new Set(['front', 'back', 'alternatives', 'notes', 'score', 'recent', 'last_seen', 'accent_slip']);

/* Fill in what a hand-written card leaves out, so bare front/back pairs pasted
   into the textarea work without ceremony.

   Fields this app does not know about are carried through untouched. The deck
   file is something people edit by hand, and quietly deleting a `type`, a tag
   or a source note because it is not in our schema would be a rotten thing for
   a save to do. */
export function normalizeCard(raw) {
  const card = {
    front: String((raw && raw.front) || '').trim(),
    back: String((raw && raw.back) || '').trim(),
  };
  if (raw && Array.isArray(raw.alternatives)) {
    const alts = raw.alternatives.map((a) => String(a || '').trim()).filter(Boolean);
    if (alts.length) card.alternatives = alts;
  }
  if (raw && raw.notes) card.notes = String(raw.notes);
  const score = Number(raw && raw.score);
  card.score = Number.isFinite(score) && score >= 1 && score <= 5 ? Math.round(score) : 1;
  card.recent = Array.isArray(raw && raw.recent)
    ? raw.recent.slice(-WINDOW).map(Boolean) : [];
  card.last_seen = (raw && raw.last_seen) || null;
  if (raw && raw.accent_slip === true) card.accent_slip = true;

  for (const key of Object.keys(raw || {})) {
    if (KNOWN_KEYS.has(key) || key === '__proto__') continue;
    card[key] = raw[key];
  }
  return card;
}

/* Parse the textarea. Returns {cards} or {error} with a line number, never
   throws — the Flashcards tab shows the error and keeps the text as typed. */
export function parseDeck(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: jsonErrorAt(e, text) };
  }
  if (!Array.isArray(data)) {
    return { error: 'The deck must be a JSON array of cards, starting with [ and ending with ].' };
  }
  const bad = data.findIndex((c) => !c || typeof c !== 'object' || Array.isArray(c));
  if (bad >= 0) return { error: `Card ${bad + 1} is not an object.` };
  const missing = data.findIndex((c) => !String(c.front || '').trim() || !String(c.back || '').trim());
  if (missing >= 0) return { error: `Card ${missing + 1} needs both a front and a back.` };
  return { cards: data.map(normalizeCard) };
}

/* Turn whatever the engine says into "what went wrong, and where".

   V8 has two message shapes and neither is usable as it stands: one carries a
   character offset, the other quotes the offending source instead. Both are
   handled, because a deck of three hundred cards is unfixable without a line
   number. */
function jsonErrorAt(err, text) {
  const msg = String((err && err.message) || 'Invalid JSON');

  const lineCol = /line (\d+) column (\d+)/.exec(msg);
  if (lineCol) return `${tidy(msg)} — line ${lineCol[1]}, column ${lineCol[2]}`;

  const position = /position (\d+)/.exec(msg);
  if (position) return `${tidy(msg)} — ${at(text, Number(position[1]))}`;

  const quoted = /\.\.\.?"([\s\S]*)" is not valid JSON/.exec(msg);
  if (quoted) {
    const found = text.indexOf(quoted[1].slice(0, 24));
    if (found >= 0) return `${tidy(msg)} — ${at(text, found)}`;
  }
  return tidy(msg);
}

function at(text, pos) {
  const upto = text.slice(0, pos);
  return `line ${upto.split('\n').length}, column ${pos - upto.lastIndexOf('\n')}`;
}

/* Strip the engine's own location and source quoting; we are about to add
   better versions of both. */
function tidy(msg) {
  return msg
    .replace(/\s+in JSON at position[\s\S]*$/, '')
    .replace(/,?\s*\.\.\.?"[\s\S]*" is not valid JSON$/, '')
    .replace(/\s+is not valid JSON$/, '')
    .trim();
}

/* Written back exactly as the textarea shows it. Keys go out in a fixed order
   so saving a deck does not reshuffle a file the user is reading. */
export function serializeDeck(cards) {
  const out = cards.map((c) => {
    const o = { front: c.front, back: c.back };
    if (c.alternatives && c.alternatives.length) o.alternatives = c.alternatives;
    if (c.notes) o.notes = c.notes;
    o.score = c.score;
    o.recent = c.recent;
    if (c.last_seen) o.last_seen = c.last_seen;
    if (c.accent_slip) o.accent_slip = true;
    /* Anything the user added themselves goes out last, so the keys this app
       writes stay in a predictable order above it. */
    for (const key of Object.keys(c)) {
      if (!KNOWN_KEYS.has(key)) o[key] = c[key];
    }
    return o;
  });
  /* JSON.stringify puts every array element on its own line, which would give
     each card eight lines of true/false and bury the words. The history is
     booleans only, so it can be safely folded back onto one line — and a deck
     of three hundred cards stays something a person can scroll. */
  return JSON.stringify(out, null, 2)
    .replace(/"recent": \[[^\]]*\]/g, (m) => m.replace(/\s+/g, ' ').replace('[ ', '[').replace(' ]', ']'))
    + '\n';
}

/* Convert a watchlist.json from the CLI study system into a deck. Purely a
   client-side transform on pasted text. */
export function importWatchlist(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (e) {
    return { error: jsonErrorAt(e, text) };
  }
  const items = Array.isArray(data) ? data : (data && data.items);
  if (!Array.isArray(items)) return { error: 'Expected a watchlist with an items array.' };
  const cards = items
    .filter((it) => it && it.term)
    .map((it) => normalizeCard({
      front: it.term,
      back: it.english || '',
      notes: it.notes || '',
      score: it.score,
      recent: it.recent_results,
      last_seen: it.last_seen,
    }))
    .filter((c) => c.front && c.back);
  if (!cards.length) return { error: 'No items with both a term and an English meaning.' };
  return { cards };
}

/* A file someone opened: a deck, or failing that a CLI watchlist. The deck's
   own error is the one reported, since a deck is what most files will be.
   (store.js has its own readDeckFile, which takes a deck's name and goes to
   the store for it; this one is handed the text and decides what it is.) */
export function parseDeckFile(text) {
  const deck = parseDeck(text);
  if (!deck.error) return { cards: deck.cards, format: 'deck' };
  const watchlist = importWatchlist(text);
  if (!watchlist.error) return { cards: watchlist.cards, format: 'watchlist' };
  return { error: deck.error };
}

export function slugify(name) {
  const s = String(name || '').trim().toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'deck';
}
