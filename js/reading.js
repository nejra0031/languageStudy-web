/* Reading: a text written around your cards, the parts that are plain logic.
   The preset requests, which cards go into a text, what the prompt is filled
   with, and reading the marked-up reply back into runs of plain text and
   marked words. No DOM and no network — the tab is tab-reading.js and the one
   call is in gemini.js.

   The model marks every use of a card itself, as [[number|the words as they
   stand in the text]]. Finding the words afterwards would only work where a
   word never changes its form: a Spanish verb is conjugated, a German noun
   declined, and a grammar pattern is split up by the words in its gaps. The
   number says which card; the words say where. */

import { isPattern, pickWeighted } from './deck.js';

/* Filled into the request box by the three buttons above it. Detailed on
   purpose: the request is the learner's to rewrite, and a full one shows
   what can be asked for — length, register, structure, the kind of language
   the genre uses. Nothing in them is about one language. `terms` is how many
   cards suit a text of that length, and goes into the box beside it. */
export const READING_PRESETS = [
  {
    id: 'story',
    label: 'Short story',
    terms: 10,
    request: 'A short story of about 300 to 400 words, told in the past tense. Two or three characters in an everyday setting, such as a family, a neighbourhood or a small shop, and a small problem that is resolved by the end. Include some dialogue between the characters. Plain, natural prose of the kind a native speaker writes for a general reader, in short paragraphs.',
  },
  {
    id: 'news',
    label: 'Long news article',
    terms: 20,
    request: 'A long news article of about 700 to 900 words, in the style of a quality daily newspaper. A headline as the title, then a one-sentence summary of the story, then the story itself: what happened, who is involved, the background, and what happens next. Quote two or three people by name and role. They and every organisation must be invented, but plausible. A neutral, factual register, with the vocabulary and sentence structures real journalism uses. Paragraphs of two to four sentences.',
  },
  {
    id: 'presentation',
    label: 'Presentation',
    terms: 14,
    request: 'The script of a spoken presentation of about 500 words, as someone would give it to colleagues at work. A greeting and what the talk is about, then three main points, each introduced with a clear signpost and backed by an example, then a short summary and a closing that invites questions. First person, addressing the audience directly: spoken, but prepared and well organised. Put a short heading on a line of its own before each section.',
  },
];

/* Of the cards in a text, about this share are grammar patterns when the
   decks have any. A pattern takes a sentence of its own to show, so a text
   that was mostly patterns would be a grammar drill in paragraphs. */
export const PATTERN_SHARE = 0.25;

export const MIN_TERMS = 1;
export const MAX_TERMS = 40;

export function clampTerms(n) {
  const v = Math.round(Number(n));
  return Number.isFinite(v) ? Math.max(MIN_TERMS, Math.min(MAX_TERMS, v)) : READING_PRESETS[0].terms;
}

/* The cards a text is written around: weighted towards the weak ones, as
   every practice tab is, with patterns given their share when there are any
   and words the rest. Whichever kind runs short, the other fills in. A word
   in two ticked decks is asked for once. `draw` is pickWeighted, passed in by
   the tests. */
export function pickReadingCards(cards, n, draw = pickWeighted) {
  const seen = new Set();
  const pool = [];
  for (const c of cards || []) {
    if (!c || !c.front || seen.has(c.front)) continue;
    seen.add(c.front);
    pool.push(c);
  }
  const patterns = pool.filter(isPattern);
  const words = pool.filter((c) => !isPattern(c));
  const want = Math.min(clampTerms(n), pool.length);
  const share = patterns.length ? Math.max(1, Math.round(want * PATTERN_SHARE)) : 0;
  const nWords = Math.min(words.length, want - Math.min(share, patterns.length));
  const nPatterns = Math.min(patterns.length, want - nWords);
  return [...draw(patterns, nPatterns), ...draw(words, nWords)];
}

/* One numbered line per card. The number is what the model marks a use
   with, so it is the card's place in this list, from 1. A pattern says in
   words what it is, for the reason buildTermListing() in gemini.js gives. */
export function readingTermListing(cards) {
  return (cards || []).map((c, i) => {
    const n = i + 1;
    if (isPattern(c)) {
      return `${n}. the grammar pattern "${c.front}"` + (c.back ? `, meaning "${c.back}"` : '')
        + ': use this construction, in this meaning. Each … (or capital letter) is a gap for your own words.';
    }
    return `${n}. "${c.front}"` + (c.back ? ` (${c.back})` : '');
  }).join('\n');
}

/* An empty request still asks for something: the first preset. */
export function readingVars(settings, cards, request) {
  return {
    language: settings.targetLanguage,
    level: settings.learnerLevel,
    languageNote: settings.languageNote || '',
    terms: readingTermListing(cards),
    request: String(request || '').trim() || READING_PRESETS[0].request,
  };
}

/* ── the reply ───────────────────────────────────────────────────────── */

/* [[3|words]], forgiving the spacing and a colon for the bar. */
const MARK = /\[\[\s*(\d+)\s*[|:]\s*([^[\]|]*?)\s*\]\]/g;

function unmark(s) {
  return String(s).replace(MARK, '$2');
}

/* Decoration a model adds on its own: bold, and a # before a heading. It is
   text, not structure, once it is on the page. */
function undecorate(s) {
  return String(s)
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/__(.+?)__/g, '$1')
    .replace(/^[ \t]*#{1,6}[ \t]+/gm, '');
}

/* One paragraph as runs: {text} for plain text, {text, item} for a marked
   use of the card at that index (from 0). A number no card has is read as
   plain text, since the words are still part of the story. */
function runsOf(paragraph, count) {
  const runs = [];
  let at = 0;
  for (const m of paragraph.matchAll(MARK)) {
    if (m.index > at) runs.push({ text: paragraph.slice(at, m.index) });
    const item = Number(m[1]) - 1;
    if (m[2] && item >= 0 && item < count) runs.push({ text: m[2], item });
    else if (m[2]) runs.push({ text: m[2] });
    at = m.index + m[0].length;
  }
  if (at < paragraph.length) runs.push({ text: paragraph.slice(at) });
  return runs;
}

/* A card the model used and forgot to mark is marked here, at its first use
   in plain text — found as it is written on the card, whole words only, case
   aside. A word that changed its form, and any pattern, cannot be found this
   way, and stays unmarked rather than being guessed at. */
function markUnmarked(paragraphs, cards, used) {
  cards.forEach((card, item) => {
    if (used.has(item) || isPattern(card)) return;
    const front = String(card.front || '').normalize('NFC').trim();
    if (!front) return;
    const escaped = front.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const find = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu');
    for (const runs of paragraphs) {
      for (let r = 0; r < runs.length; r++) {
        if (runs[r].item !== undefined) continue;
        const m = find.exec(runs[r].text);
        if (!m) continue;
        const text = runs[r].text;
        const parts = [
          { text: text.slice(0, m.index) },
          { text: m[0], item },
          { text: text.slice(m.index + m[0].length) },
        ].filter((p) => p.text);
        runs.splice(r, 1, ...parts);
        used.add(item);
        return;
      }
    }
  });
}

/* The reply as {title, paragraphs, used}: paragraphs are lists of runs, and
   `used` the indices of the cards that appear in the text, in order. Null
   when there is no text at all. The TITLE: and TEXT: labels are looked for
   but not required, so a model that skips them still gives a text. */
export function readReading(reply, cards = []) {
  let body = String(reply || '').normalize('NFC').replace(/^\s*```\w*\s*|\s*```\s*$/g, '').replace(/\r\n/g, '\n');
  let title = '';
  const t = /^[ \t>*#-]*TITLE\**[ \t]*:[ \t]*(.*)$/im.exec(body);
  if (t) {
    title = undecorate(unmark(t[1])).replace(/^["'“‘«]+|["'”’»]+$/g, '').trim();
    body = body.slice(0, t.index) + body.slice(t.index + t[0].length);
  }
  body = body.replace(/^\s*[>*#-]*[ \t]*TEXT\**[ \t]*:[ \t]*/i, '');

  const paragraphs = undecorate(body)
    .split(/\n[ \t]*\n/)
    .map((p) => p.split('\n').map((l) => l.trim()).filter(Boolean).join('\n'))
    .filter(Boolean)
    .map((p) => runsOf(p, cards.length));
  if (!paragraphs.length) return null;

  const used = new Set();
  for (const runs of paragraphs) for (const r of runs) if (r.item !== undefined) used.add(r.item);
  markUnmarked(paragraphs, cards, used);
  return { title, paragraphs, used: [...used].sort((a, b) => a - b) };
}

/* ── keeping texts ───────────────────────────────────────────────────── */

/* r_20260926_0001: the date it was written and a count within the day, the
   way the sentence bank and shadowing sets are named. */
export function nextReadingId(rows, now = new Date()) {
  const prefix = `r_${now.toISOString().slice(0, 10).replace(/-/g, '')}_`;
  const taken = new Set((rows || []).map((r) => r.id));
  let n = (rows || []).filter((r) => String(r.id || '').startsWith(prefix)).length + 1;
  while (taken.has(prefix + String(n).padStart(4, '0'))) n++;
  return prefix + String(n).padStart(4, '0');
}

/* Where a text's audio lives, by the extension speechFile() chose. */
export function readingAudioPath(id, ext) {
  return `reading/${id}.${ext === 'wav' ? 'wav' : 'ogg'}`;
}

/* The index row for a text: enough to list it, and to say whether it has
   audio, without opening its file. */
export function readingRow(record) {
  return {
    id: record.id,
    title: record.title || '',
    created: record.created || '',
    language: record.language || '',
    level: record.level || '',
    decks: [...new Set((record.items || []).map((it) => it.deck).filter(Boolean))],
    used: (record.used || []).length,
    items: (record.items || []).length,
    audio: record.audio ? record.audio.file : '',
  };
}

/* What the speech model is given: the title, then each paragraph, as the
   reader sees them with the marks taken out. A blank line between them is
   where a reader would pause. */
export function speakableText(record) {
  const paragraphs = (record.paragraphs || []).map((runs) => runs.map((r) => r.text).join(''));
  return [record.title, ...paragraphs].map((s) => String(s || '').trim()).filter(Boolean).join('\n\n');
}
