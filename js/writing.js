/* Writing: the parts that are plain logic. How long a piece should be, what
   the grader is sent, and reading its feedback back. No DOM and no network —
   the tab is tab-writing.js and the calls are in gemini.js.

   There are two kinds of task, and neither needs anything authored:

     'summary'   summarise one of your kept Reading texts. The text is the
                 source, and the cards it used are the ones to try to use.
     'opinion'   answer a question the text model writes around a few of
                 your weakest cards, or a topic you type yourself.

   The grader is lessons-web's, adapted (see the prompt in defaults.js). Its
   reply is a verdict, "not an attempt", or feedback in sections; anything
   else is null, which the tab reports as a failure with the writing kept,
   never as half a grade. */

import { isPattern } from './deck.js';
import { readingTermListing } from './reading.js';
import { extractTrailingJson, cardVerdicts } from './json-reply.js';
import { fillTemplate, withFeedbackBlock, feedbackRequestText } from './gemini.js';

export const KINDS = ['summary', 'opinion'];

/* How many cards an opinion question is written around, unless the
   writingTerms setting says otherwise. Enough to give the question something
   to draw on, few enough that the learner can hold them in mind. */
export const WRITING_TERMS = 5;

/* The most the textarea takes. A cap on what one call carries, set well
   above anything the word bounds ask for. */
export const MAX_TEXT = 5000;

/* The length of a typical kept Reading text, in words: the short story
   preset asks for 300 to 400. A summary of a text this long gets the
   summary bounds unscaled. */
export const TYPICAL_SOURCE_WORDS = 350;

/* A summary is bounded by what it summarises and an opinion only by what
   you have to say, so a summary asks for fewer words. lessons-web's bounds
   for a summary are about two thirds of its bounds for an opinion piece at
   every level, which is the default; the writingSummaryShare setting, a
   percentage, changes it. */
export const SUMMARY_SHARE = 2 / 3;

const MIN_SCALE = 0.7;
const MAX_SCALE = 1.3;

/* Split on whitespace. Crude, and deliberately so: a rule the learner can
   predict by looking at their own text beats a more accurate one they
   cannot, and the counter under the box is this same count. */
export function countWords(text) {
  const trimmed = String(text || '').trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/* Word counts a learner can hold in their head: "between 30 and 60" is a
   rule, "between 32 and 59" reads as arithmetic. */
function roundTo5(n) {
  return Math.max(5, Math.round(n / 5) * 5);
}

/* {min, max} for a piece of this kind. An opinion piece gets the setting as
   it is. A summary gets its share of it (two thirds by default), scaled by how the source compares
   with a typical text, within 30% either way, so a summary of a long article
   may be longer than one of a short story without either running away from
   what the setting asks. A source of unknown length counts as typical. */
export function wordBounds(settings, kind, sourceWords = 0) {
  const { min, max } = settings.writingWords;
  if (kind !== 'summary') return { min, max };
  const scale = sourceWords > 0
    ? Math.min(MAX_SCALE, Math.max(MIN_SCALE, sourceWords / TYPICAL_SOURCE_WORDS))
    : 1;
  const share = Number.isFinite(settings.writingSummaryShare) ? settings.writingSummaryShare / 100 : SUMMARY_SHARE;
  const lo = roundTo5(min * share * scale);
  return { min: lo, max: Math.max(lo + 5, roundTo5(max * share * scale)) };
}

/* Where a count sits against its bounds. Nothing typed yet is not out of
   range: the counter only turns red once there is something to count. */
export function wordStatus(count, { min, max }) {
  if (count === 0) return { ok: false, short: 0, over: 0, empty: true };
  if (count < min) return { ok: false, short: min - count, over: 0, empty: false };
  if (count > max) return { ok: false, short: 0, over: count - max, empty: false };
  return { ok: true, short: 0, over: 0, empty: false };
}

/* ── the question ────────────────────────────────────────────────────── */

export function briefVars(settings, cards) {
  return {
    language: settings.targetLanguage,
    level: settings.learnerLevel,
    languageNote: settings.languageNote || '',
    terms: readingTermListing(cards),
  };
}

/* The question, from the QUESTION: line, or the first line when the label
   was left off. Quotes and decoration a model adds are taken off; nothing
   else is changed. Empty when there is no question at all. */
export function readBrief(reply) {
  const lines = String(reply || '').replace(/```\w*/g, '').split('\n').map((l) => l.trim()).filter(Boolean);
  let line = '';
  for (const l of lines) {
    const m = /^[\s\-*#>]*QUESTION\**\s*:\**\s*(.*)$/i.exec(l);
    if (m) { line = m[1]; break; }
  }
  if (!line) line = lines[0] || '';
  return line.replace(/\*\*/g, '').trim().replace(/^["'“‘«]+|["'”’»]+$/g, '').trim();
}

/* ── the grading request ─────────────────────────────────────────────── */

/* The system instruction: the grading prompt with the language, the note
   and the feedback request filled in, and nothing that changes from one
   hand-in to the next, so it is the same text on every call. */
export function writingGradeSystem(settings) {
  return fillTemplate(withFeedbackBlock(settings.prompts.writingGrade), {
    language: settings.targetLanguage,
    languageNote: settings.languageNote || '',
    feedback: feedbackRequestText(settings.feedbackRequest),
  });
}

/* What the task was, in words the grader can break into points. */
export function taskText(kind, brief, language) {
  if (kind === 'summary') {
    return `Write a summary, in ${language}, of the text given below as <source_text>.`;
  }
  return `Write a short opinion piece, in ${language}, responding to this: "${String(brief || '').trim()}"`;
}

/* Everything that changes per hand-in, in tagged blocks. The learner's text
   is last and fenced, as the system instruction says it will be. */
export function writingGradeUser({ kind, brief, sourceText = '', level, language, cards = [], text }) {
  const blocks = [
    `<task>${taskText(kind, brief, language)}</task>`,
    `<level>${String(level || '').trim() || 'not given'}</level>`,
  ];
  if (kind === 'summary') blocks.push(`<source_text>\n${String(sourceText || '').trim()}\n</source_text>`);
  blocks.push(`<cards>\n${cards.length ? readingTermListing(cards) : '(none)'}\n</cards>`);
  blocks.push(`<student_text>\n${String(text || '')}\n</student_text>`);
  return blocks.join('\n');
}

/* ── reading the reply ───────────────────────────────────────────────── */

const MAX_VOCAB_STYLE = 20;
const MAX_SUGGESTIONS = 5;
const MAX_GRAMMAR_MISTAKES = 20;
const MAX_TASK_POINTS = 8;
const MAX_NOTE = 600;
const LEVELS = new Set(['A1', 'A2', 'B1', 'B2', 'C1', 'C2']);

/* Only for a rejection the model gave no reason for. */
export const FALLBACK_INVALID_REASON = 'This does not read as an answer to the task. Write a short text that does what the task asks.';

/* The strings are shown as text, never as HTML, but the writing is the
   learner's own and this is where it comes back out, so anything tag-shaped
   is taken off here too, as lessons-web does. */
function plain(value, max = MAX_NOTE) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim().slice(0, max) : '';
}

/* The number of a pattern card, when that is what the grader named. A word
   is not something "one of your patterns" can point at, and a number the
   list does not have points at nothing. */
function patternNumber(value, cards) {
  const n = Number(value);
  if (value === null || value === undefined || value === '' || !Number.isInteger(n)) return null;
  if (n < 1 || n > cards.length || !isPattern(cards[n - 1])) return null;
  return n;
}

/* The reply as the tab draws it: every list capped, empty entries dropped,
   a field the model left out or mistyped degraded to its empty case rather
   than to a crash. `cards` are the cards the prompt was given, in order.

   Returns {valid:false, reason} for "not an attempt", which is a real
   verdict and scores nothing, and null for a reply that is not the expected
   shape at all, which is a failure. */
export function normaliseWritingFeedback(parsed, cards = []) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (parsed.valid === false) {
    return { valid: false, reason: plain(parsed.reason) || FALLBACK_INVALID_REASON };
  }
  if (parsed.valid !== true) return null;

  const vocabStyle = (Array.isArray(parsed.vocabStyle) ? parsed.vocabStyle : [])
    .slice(0, MAX_VOCAB_STYLE)
    .map((item) => ({
      category: item && item.category === 'STYLE' ? 'STYLE' : 'VOCAB',
      original: plain(item && item.original),
      suggestions: (Array.isArray(item && item.suggestions) ? item.suggestions : [])
        .map((x) => plain(x)).filter(Boolean).slice(0, MAX_SUGGESTIONS),
      reason: plain(item && item.reason),
    }))
    .filter((item) => item.original && item.suggestions.length);

  const grammarMistakes = (Array.isArray(parsed.grammarMistakes) ? parsed.grammarMistakes : [])
    .slice(0, MAX_GRAMMAR_MISTAKES)
    .map((item) => ({
      description: plain(item && item.description),
      correction: plain(item && item.correction),
      cardNumber: patternNumber(item && item.cardNumber, cards),
    }))
    .filter((item) => item.description);

  /* `met` must be a real boolean: an entry the model left undecided says
     nothing either way, so it is dropped rather than guessed. A met point
     has nothing missing, so its note is cleared. */
  const taskPoints = (Array.isArray(parsed.taskPoints) ? parsed.taskPoints : [])
    .slice(0, MAX_TASK_POINTS)
    .map((item) => ({
      point: plain(item && item.point),
      met: item && typeof item.met === 'boolean' ? item.met : null,
      note: plain(item && item.note),
    }))
    .filter((item) => item.point && item.met !== null)
    .map((item) => (item.met ? { ...item, note: '' } : item));

  const level = typeof parsed.detectedLevel === 'string' ? parsed.detectedLevel.trim().toUpperCase() : '';
  return {
    valid: true,
    detectedLevel: LEVELS.has(level) ? level : null,
    languageNote: plain(parsed.languageNote) || null,
    contentNote: plain(parsed.contentNote) || null,
    taskPoints,
    vocabStyle,
    grammarMistakes,
    cards: cardVerdicts(parsed, cards),
  };
}

export function readWritingGrade(text, cards = []) {
  return normaliseWritingFeedback(extractTrailingJson(text), cards);
}

/* ── kept pieces ─────────────────────────────────────────────────────── */

/* What names a piece in the list: the question or topic answered, or the
   title of the text summarised. */
export function writingTitle(record) {
  if (record.kind === 'summary') return `Summary of ${record.readingTitle || 'a reading text'}`;
  return String(record.brief || '').trim();
}
