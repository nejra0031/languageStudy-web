/* Shadowing: the parts of it that are not the DOM and not the network.

   Building a set, laying out the grading request, and reading the reply back.
   Everything here is a plain function over plain data so `node --test` can
   cover it without a browser, a key or a microphone — which matters more than
   usual for this feature, because the expensive half of it is one API call
   carrying ten audio clips and you do not want to be debugging the message
   layout by spending calls.

   The two rules worth knowing before changing anything:

     A clip is never paired with the wrong reference. The request interleaves
     the text of line k with the recording of line k, ascending, and the label
     names the index — models otherwise renumber, or skip a clip and shift
     every note after it onto the wrong line.

     A malformed reply is a failure, not a grade. Half a grading looks exactly
     like a finished one to whoever reads it, so normalise() returns null and
     the caller stores nothing. */

import { pickWeighted } from './deck.js';

/* ── ids and filenames ───────────────────────────────────────────────── */

export function nextSessionId(sessions, now = new Date()) {
  const today = now.toISOString().slice(0, 10).replace(/-/g, '');
  const prefix = `s_${today}_`;
  const taken = new Set((sessions || []).map((s) => s && s.id));
  let n = (sessions || []).filter((s) => String((s && s.id) || '').startsWith(prefix)).length + 1;
  while (taken.has(prefix + String(n).padStart(4, '0'))) n++;
  return prefix + String(n).padStart(4, '0');
}

/* MediaRecorder hands back whatever its browser prefers — webm on Chrome, ogg
   on Firefox, mp4 on Safari — so the extension follows the recorder's own
   mimeType rather than being assumed. A backup written on one browser has to
   open on another, and a .webm that is really mp4 will not play. */
export function extensionFor(mime) {
  const type = String(mime || '').split(';')[0].trim().toLowerCase();
  switch (type) {
    case 'audio/ogg': case 'video/ogg': return 'ogg';
    case 'audio/mp4': case 'video/mp4': return 'mp4';
    case 'audio/x-m4a': case 'audio/m4a': return 'm4a';
    case 'audio/wav': case 'audio/wave': case 'audio/x-wav': return 'wav';
    default: return 'webm';
  }
}

export function takePath(sessionId, index, mime) {
  return `shadowing/${sessionId}_${index}.${extensionFor(mime)}`;
}

/* ── building a set ──────────────────────────────────────────────────── */

/* Bank entries you have already typed as a dictation come first: shadowing
   prints the sentence in full, so shadowing one you have never been asked to
   type hands you the answer to a dictation you have not taken. Never-dictated
   entries are still used when nothing else is left — they cost real API calls
   and dropping them would be worse. */
export function orderBank(bank) {
  return (bank || []).slice().sort((a, b) => {
    const seen = (e) => (e.times_practiced > 0 ? 0 : 1);
    if (seen(a) !== seen(b)) return seen(a) - seen(b);
    /* Then the least shadowed, so a set is not the same lines every day. */
    return ((a.times_shadowed || 0) - (b.times_shadowed || 0)) || Math.random() - 0.5;
  });
}

function bankItem(entry) {
  return {
    text: String(entry.sentence || ''),
    gloss: String(entry.english || ''),
    source: 'bank',
    deck: entry.deck || '',
    bankId: entry.id || '',
    audio: entry.file || '',
  };
}

function cardItem(card, deck) {
  return {
    text: String(card.front || ''),
    gloss: String(card.back || ''),
    source: 'card',
    deck: deck || '',
    cardFront: String(card.front || ''),
    audio: '',
  };
}

/* The two sources are interleaved rather than concatenated, so a set is never
   all sentences or all single words — alternating them is what makes a sitting
   feel like practice rather than a list.

   `cards` are expected already filtered (isDictatable, in scope) and `bank`
   already filtered to the ticked decks; this function does not know what a
   ticked deck is. Both sources off returns an empty set rather than falling
   back to something nobody asked for. */
export function buildSet({
  cards = [], bank = [], count = 10,
  sources = { cards: true, bank: true },
  deckOf = () => '',
} = {}) {
  const want = Math.max(0, Math.floor(count) || 0);
  if (!want) return [];

  const queueBank = sources && sources.bank ? orderBank(bank).map(bankItem) : [];
  const queueCards = sources && sources.cards
    ? pickWeighted(cards, want).map((c) => cardItem(c, deckOf(c)))
    : [];

  const items = [];
  const seen = new Set();
  let b = 0;
  let c = 0;
  let turn = 0;
  const push = (item) => {
    /* Never the same line twice in one set — a card whose front happens to be
       a banked sentence would otherwise come round twice. */
    const key = item.text.trim().toLowerCase();
    if (!key || seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  while (items.length < want && (b < queueBank.length || c < queueCards.length)) {
    const bankTurn = turn % 2 === 0;
    if (bankTurn && b < queueBank.length) push(queueBank[b++]);
    else if (!bankTurn && c < queueCards.length) push(queueCards[c++]);
    else if (b < queueBank.length) push(queueBank[b++]);
    else push(queueCards[c++]);
    turn++;
  }

  return items.map((item, index) => ({ ...item, index, file: '', mime: '' }));
}

/* ── the grading request ─────────────────────────────────────────────── */

export const AUDIO_BUDGET_BYTES = 12 * 1024 * 1024;

/* Ten clips of Opus speech is a few hundred kilobytes; this ceiling is for the
   pathological case — a recorder left running — not the normal one. The
   prompt says "every recording you are given", so answering for fewer clips
   than the set held is a shape the model already handles. base64 inflates by
   about a third on the wire, which this budget is deliberately under. */
export function attachableClips(clips, budget = AUDIO_BUDGET_BYTES) {
  const out = [];
  let bytes = 0;
  for (const clip of clips || []) {
    const len = clip && clip.bytes ? clip.bytes.length : 0;
    if (!len) continue;
    if (bytes + len > budget) break;      // ascending order, so drop the tail
    bytes += len;
    out.push(clip);
  }
  return out;
}

/* Chunked, because String.fromCharCode(...bytes) on a megabyte of audio
   overflows the call stack. */
export function toBase64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

/* Text of line k, then the recording of line k, ascending, for every clip.
   Never all the texts and then all the clips: that is the layout in which a
   model pairs a clip with the wrong reference, and the whole exercise is
   about the distance between those two things.

   The focus block, when there is one, is its own part in the per-call content
   and never in the system instruction — the system instruction is identical
   across every call and is what prefix caching can reuse. */
export function buildGradingParts({
  items = [], clips = [], focus = '', language = 'the target language', itemCount = 0,
} = {}) {
  const total = itemCount || items.length;
  const ordered = attachableClips(
    (clips || []).slice().sort((a, b) => a.itemIndex - b.itemIndex));

  const heading = ordered.length === total
    ? `Here are the ${total} lines and the learner's recording of each.`
    : `The learner was shown ${total} lines and is handing in ${ordered.length} of them; you are given those ${ordered.length}.`;

  const parts = [{
    text: `${heading} The text of each line is what the recording they listened to says; `
      + `the audio is the learner saying it back.`,
  }];

  if (focus && focus.trim()) parts.push({ text: `<focus>\n${focus.trim()}\n</focus>` });

  const byIndex = new Map(items.map((i) => [i.index, i]));
  for (const clip of ordered) {
    const line = byIndex.get(clip.itemIndex);
    parts.push({
      text: `Line ${clip.itemIndex} -- the ${language} that was played: "${(line && line.text) || ''}"\n`
        + `The learner's recording of line ${clip.itemIndex}:`,
    });
    parts.push({
      inlineData: {
        mimeType: clip.mime || 'audio/webm',
        data: clip.base64 || toBase64(clip.bytes),
      },
    });
  }
  return parts;
}

/* ── reading the reply back ──────────────────────────────────────────── */

const MAX_COMMENT = 600;
const MAX_OVERALL = 1200;
const MAX_FOCUS = 900;

/* Walk backwards to the last balanced top-level object, so a model that
   prefaces its JSON with a sentence of prose still parses. */
export function extractTrailingJson(raw) {
  if (typeof raw !== 'string') return null;
  const end = raw.lastIndexOf('}');
  if (end === -1) return null;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (raw[i] === '}') depth++;
    else if (raw[i] === '{' && --depth === 0) {
      try { return JSON.parse(raw.slice(i, end + 1)); } catch (e) { return null; }
    }
  }
  return null;
}

const trimmed = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : '');

/* Returns null for anything unusable, and null must lead to the set being
   left ungraded rather than partly graded. A reader cannot tell a half
   grading from a finished one, so there is no safe way to show one. */
export function normalise(parsed, itemCount) {
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.notes)) return null;
  const notes = [];
  const seen = new Set();
  for (const note of parsed.notes) {
    const i = Number(note && note.itemIndex);
    if (!Number.isInteger(i) || i < 0 || i >= itemCount || seen.has(i)) continue;
    const comment = trimmed(note.comment, MAX_COMMENT);
    if (!comment) continue;
    seen.add(i);
    /* Which listening rules the note applied, by number. Optional and
       forgiving: a reply from before rules existed, or a model that ignores
       the field, still grades — the only cost is that a rating on this note
       cannot be pinned on a rule. */
    const rules = Array.isArray(note.rules)
      ? [...new Set(note.rules.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 6)
      : [];
    notes.push(rules.length ? { itemIndex: i, comment, rules } : { itemIndex: i, comment });
  }
  if (notes.length === 0) return null;
  notes.sort((a, b) => a.itemIndex - b.itemIndex);
  return {
    notes,
    overall: trimmed(parsed.overall, MAX_OVERALL) || null,
    focusNote: trimmed(parsed.focusNote, MAX_FOCUS) || null,
  };
}

export function readGrading(text, itemCount) {
  return normalise(extractTrailingJson(text), itemCount);
}

/* ── handing in part of a set ────────────────────────────────────────── */

/* A set is no longer graded all at once. You choose which lines go up, and
   can hand in some now and the rest later, or ask again about one retake.
   So a note belongs to a line, not to the set, and a grading is merged into
   what the set already had rather than replacing it.

   What makes that safe is the take counter. Every recording of a line bumps
   item.take, and a note records the take it was about. A note whose take is
   not the line's current one describes a recording that no longer exists:
   it is kept, because it is still your feedback, but it is shown as being
   about an earlier take, and the line counts as waiting to be handed in.

   Sets saved before this existed have no counters on either side, and both
   read as 0, so every note in them is current, which is what they were. */

export function takeOf(item) {
  const n = item && Number(item.take);
  return Number.isInteger(n) && n > 0 ? n : 0;
}

export function noteIsCurrent(item, note) {
  return !!(item && note) && takeOf(note) === takeOf(item);
}

export function notesByIndex(session) {
  const notes = (session && session.feedback && session.feedback.notes) || [];
  return new Map(notes.map((n) => [n.itemIndex, n]));
}

/* Recorded lines with no note about their current take: never handed in,
   or recorded again since. What a hand-in offers by default. */
export function pendingIndices(session) {
  const notes = notesByIndex(session);
  return ((session && session.items) || [])
    .filter((item) => item.file && !noteIsCurrent(item, notes.get(item.index)))
    .map((item) => item.index);
}

/* The set's status follows from its lines: nothing graded yet is
   "recording", every line holding a note about its current take is "done",
   and anything between is "partial". "grading" and a failed hand-in are
   decided by the caller, which knows whether a call is out. */
export function sessionStatus(session) {
  const items = (session && session.items) || [];
  const notes = notesByIndex(session);
  if (!notes.size) return 'recording';
  return items.every((item) => noteIsCurrent(item, notes.get(item.index))) ? 'done' : 'partial';
}

/* One grading merged into the set's feedback. Every note that came back
   replaces the line's old one, together with any rating given to it, since
   that rating was about the old note. A line that was sent but got no note
   back keeps whatever it had.

   Each new note is stamped with the take it heard, the rules version and
   the model that wrote it, because a set can now hold notes from several
   hand-ins made days apart. "overall" and "focusNote" describe one hand-in,
   so they are replaced whole, with the lines they covered. */
export function mergeGrading(previous, graded, items, now = new Date()) {
  const byIndex = new Map((items || []).map((i) => [i.index, i]));
  const returned = new Set(graded.notes.map((n) => n.itemIndex));
  const kept = ((previous && previous.notes) || []).filter((n) => !returned.has(n.itemIndex));
  const at = now.toISOString();
  const fresh = graded.notes.map((n) => ({
    ...n,
    take: takeOf(byIndex.get(n.itemIndex)),
    rulesGeneration: Number.isInteger(graded.rulesGeneration) ? graded.rulesGeneration : 0,
    model: graded.model || '',
    gradedAt: at,
  }));
  return {
    notes: [...kept, ...fresh].sort((a, b) => a.itemIndex - b.itemIndex),
    overall: graded.overall || null,
    focusNote: graded.focusNote || null,
    covers: [...returned].sort((a, b) => a - b),
    model: graded.model || '',
    attached: graded.attached || returned.size,
    rulesGeneration: Number.isInteger(graded.rulesGeneration) ? graded.rulesGeneration : 0,
    gradedAt: at,
  };
}

/* ── the focus block ─────────────────────────────────────────────────── */

/* The app has no per-lesson focus, but the Accents scope is exactly one: the
   set was built from the words whose accents you keep missing, so that is what
   this sitting is about. Every other scope passes nothing, and the prompt's
   own rule then makes the model omit focusNote entirely. */
export function focusFor(scope, language, items) {
  if (scope !== 'accents') return '';
  const words = [...new Set((items || []).map((i) => i.cardFront || i.text).filter(Boolean))].slice(0, 12);
  if (!words.length) return '';
  return `These lines were chosen because the learner keeps getting the accents and diacritics `
    + `of these ${language} words right in the word but wrong in the marks: ${words.join(', ')}. `
    + `Listen to the recordings again with only those marks in mind — whether each one came out as `
    + `the mark written or as a different one — and say what to do differently.`;
}
