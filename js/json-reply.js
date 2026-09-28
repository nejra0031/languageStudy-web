/* Reading a model's JSON reply, and the one shape every graded mode uses to
   say what happened to your cards.

   Every grader here is asked for "strict JSON only", and every one of them
   sometimes prefaces it with a sentence of prose, wraps it in a code fence or
   trails a remark after it. The two readers below find the JSON inside
   whatever came back; neither guesses at a reply that is not there. A reply
   they cannot read is null, and null is always a failure to the caller,
   never half a grade.

   Plain functions over strings and plain objects, so `node --test` covers
   them without a browser or a key. */

/* Walk backwards to the last balanced top-level object, so a model that
   prefaces its JSON with a sentence of prose still parses. The parsed object
   comes back, not its position: nothing here needs to know where it began. */
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

/* The first top-level array anywhere in the text, for a prompt that answers
   with a bare array rather than an object: from the first [, forward, by
   bracket depth. Brackets inside strings are not special-cased, as they are
   not in extractTrailingJson either: a string with an unbalanced bracket in
   it makes the slice fail to parse, and that is null, which is a failure the
   caller already handles, never a wrong answer. */
export function extractJsonArray(raw) {
  if (typeof raw !== 'string') return null;
  const start = raw.indexOf('[');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '[') depth++;
    else if (raw[i] === ']' && --depth === 0) {
      try {
        const parsed = JSON.parse(raw.slice(start, i + 1));
        return Array.isArray(parsed) ? parsed : null;
      } catch (e) { return null; }
    }
  }
  return null;
}

/* What a grader may say about one card. 'absent' is a card the learner never
   used, which is not the same as one they got wrong: it is left unscored, as
   Reading leaves a card the text never used. */
export const VERDICTS = ['right', 'wrong', 'absent'];

const MAX_NOTE = 300;

/* The `cards` list of a grading reply, kept to what can be trusted: each
   entry names a card by its number in the list the prompt was given (from 1),
   and a number that list does not have is dropped rather than guessed at. A
   card named twice keeps its first verdict, since the model answered the
   question once and then repeated itself. A verdict that is not one of the
   three is dropped too: 'partly' is not something a score can record.

   `cards` is the list the prompt was given, in its order. What comes back is
   one row per card the model judged, in that list's order:
   {number, index, verdict, note}, `index` counting from 0. The caller scores
   'right' and 'wrong' and leaves 'absent' alone. */
export function cardVerdicts(parsed, cards) {
  const list = parsed && Array.isArray(parsed.cards) ? parsed.cards : [];
  const count = Array.isArray(cards) ? cards.length : 0;
  const seen = new Map();
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const number = Number(entry.number);
    if (!Number.isInteger(number) || number < 1 || number > count || seen.has(number)) continue;
    const verdict = String(entry.verdict || '').trim().toLowerCase();
    if (!VERDICTS.includes(verdict)) continue;
    const note = typeof entry.note === 'string' ? entry.note.trim().slice(0, MAX_NOTE) : '';
    seen.set(number, { number, index: number - 1, verdict, note });
  }
  return [...seen.values()].sort((a, b) => a.number - b.number);
}
