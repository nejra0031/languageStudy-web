/* Translate: the parts that are plain logic. Which banked sentences make a
   set, what the grader is sent, how its reply is read, and what it does to
   your cards. No DOM and no network — the tab is tab-translate.js and the
   call is in gemini.js.

   The items cost nothing to make. Each is a sentence from the bank Dictation
   fills: its English is the prompt, the sentence itself is one right answer,
   and its target words are the cards it practises. The bank is only read
   here, never written, as in Shadowing; when it runs short, the tab says so
   rather than quietly spending calls on new sentences.

   A model grades the answers because a free translation has no single right
   answer: two natural ways of saying the same thing are both correct, and a
   string comparison against the one sentence the bank holds would mark the
   other wrong. The reply is an array keyed by id, not by position, so one
   that drops or reorders an item cannot shift every grade onto the wrong
   sentence. */

import { readingTermListing } from './reading.js';
import { extractJsonArray } from './json-reply.js';
import { orderBank } from './shadowing.js';
import { fillTemplate, withFeedbackBlock, feedbackRequestText } from './gemini.js';

/* How many sentences a set asks for, unless the translateItems setting says
   otherwise. */
export const TRANSLATION_ITEMS = 6;

/* The most an answer box takes. A sentence is rarely a fifth of it. */
export const MAX_ANSWER = 500;

/* ── building a set ──────────────────────────────────────────────────── */

/* The order Shadowing uses, and for Shadowing's reason: once a set is
   checked, each item shows its sentence in full as one correct answer, and
   a sentence seen in full is a dictation given away. Nothing here writes to
   the bank, so Dictation cannot know which sentences a translation showed
   and steer round them; the only protection is to draw first on sentences
   that have already been typed as a dictation, then on the least shadowed,
   then at random so a set is not the same six every day. A sentence never
   dictated is still used when nothing else is left. That is 'dictated', the
   default.

   The translateOrder setting can turn it round: 'fresh' puts sentences not
   yet dictated first (a harder set, at the cost of those dictations), and
   'random' ignores both. */
export function orderForTranslation(bank, order = 'dictated', random = Math.random) {
  if (order === 'random') {
    return (bank || []).map((e) => [random(), e]).sort((a, b) => a[0] - b[0]).map(([, e]) => e);
  }
  if (order === 'fresh') {
    return (bank || []).slice().sort((a, b) => {
      const typed = (e) => (e.times_practiced > 0 ? 1 : 0);
      if (typed(a) !== typed(b)) return typed(a) - typed(b);
      return ((a.times_shadowed || 0) - (b.times_shadowed || 0)) || random() - 0.5;
    });
  }
  return orderBank(bank);
}

/* Up to `n` items from the bank, already filtered to the ticked decks.
   A sentence with no English has no prompt and is passed over. `findCard`
   is store.findCard, passed in so this stays a plain function: each target
   word is looked up in the entry's own deck first, and a word no deck has
   any more is dropped from the item's cards, not from the item. */
export function pickTranslationItems(bank, n = TRANSLATION_ITEMS, findCard = () => null, order = 'dictated') {
  const usable = (bank || []).filter((e) => e && String(e.english || '').trim() && String(e.sentence || '').trim());
  return orderForTranslation(usable, order).slice(0, Math.max(0, n)).map((entry, index) => ({
    index,
    id: String(index),
    bankId: entry.id || '',
    english: String(entry.english).trim(),
    sentence: String(entry.sentence).trim(),
    deck: entry.deck || '',
    audio: entry.file || '',
    cards: (entry.terms || [])
      .map((term) => findCard(term, entry.deck))
      .filter(Boolean)
      .map(({ card, deck }) => {
        const out = { front: card.front, back: card.back || '', deck };
        if (card.type) out.type = card.type;
        return out;
      }),
  }));
}

/* ── the grading request ─────────────────────────────────────────────── */

export function translationGradeSystem(settings) {
  return fillTemplate(withFeedbackBlock(settings.prompts.translationGrade), {
    language: settings.targetLanguage,
    feedback: feedbackRequestText(settings.feedbackRequest),
  });
}

/* Every item goes, blank answers included: a blank is graded wrong like
   any other, and leaving it out would leave a hole in the ids. Each item
   carries its own numbered list of target words, which is what "cards" in
   the reply points into. */
export function translationGradeUser(items, answers, language) {
  const blocks = items.map((it, i) => [
    `[${i + 1}] id: "${it.id}"`,
    `English: "${it.english}"`,
    `Reference ${language}: "${it.sentence}"`,
    `Learner: "${cleanAnswer(answers[i])}"`,
    `Target words:\n${it.cards.length ? readingTermListing(it.cards) : '(none)'}`,
  ].join('\n'));
  return `Grade each translation:\n\n${blocks.join('\n\n')}`;
}

export function cleanAnswer(text) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, MAX_ANSWER);
}

/* ── reading the reply ───────────────────────────────────────────────── */

const MAX_EXPLANATION = 400;

/* One result per item, in the set's order: {index, graded, correct,
   explanation, cards}. An item the reply has no entry for, or no true or
   false for, is ungraded and scores nothing. `cards` are the numbers of the
   item's target words the grader says were got wrong, kept only when the
   item has such a number. Null when the reply is not an array at all, which
   is a failure: nothing is scored and the answers stay editable. */
export function readTranslationGrade(text, items) {
  const list = extractJsonArray(text);
  if (!list) return null;
  const byId = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const id = String(entry.id ?? '').trim();
    if (id && !byId.has(id)) byId.set(id, entry);
  }
  return items.map((it) => {
    const entry = byId.get(it.id);
    const graded = !!entry && typeof entry.correct === 'boolean';
    const numbers = graded && Array.isArray(entry.cards) ? entry.cards : [];
    return {
      index: it.index,
      graded,
      correct: graded ? entry.correct : false,
      explanation: graded && typeof entry.explanation === 'string'
        ? entry.explanation.replace(/<[^>]*>/g, '').trim().slice(0, MAX_EXPLANATION) : '',
      cards: graded && !entry.correct
        ? [...new Set(numbers.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= it.cards.length))]
        : [],
    };
  });
}

/* ── what it does to your cards ──────────────────────────────────────── */

/* Which card of which item is scored, and which way: [{item, card, ok}],
   `card` counting from 0 in the item's cards.

     a blank answer   every card wrong, as Show answer is in Typing,
                      whatever the grader said: there is nothing there
                      that could have been right. With blankWrong off
                      (the translateBlankWrong setting), nothing: a
                      sentence skipped is left alone
     ungraded         nothing
     correct          every card right
     incorrect        the cards the grader named wrong; the rest are left
                      alone, since a sentence can be wrong for a reason
                      that has nothing to do with them */
export function translationScores(results, items, answers, { blankWrong = true } = {}) {
  const out = [];
  for (const r of results || []) {
    const it = items[r.index];
    if (!it) continue;
    const blank = !cleanAnswer(answers[r.index]);
    if (blank) {
      if (blankWrong) it.cards.forEach((_, card) => out.push({ item: r.index, card, ok: false }));
    } else if (!r.graded) {
      continue;
    } else if (r.correct) {
      it.cards.forEach((_, card) => out.push({ item: r.index, card, ok: true }));
    } else {
      for (const n of r.cards) out.push({ item: r.index, card: n - 1, ok: false });
    }
  }
  return out;
}
