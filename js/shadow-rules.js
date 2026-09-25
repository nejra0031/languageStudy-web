/* Shadowing's listening rules: what the grading model is told to listen for,
   per language, and how those rules get better.

   The loop is small and deliberately slow:

     Seed     The first time a language is handed in, one text call drafts a
              handful of rules for it from nothing but the language's name and
              the learner's level. Nothing here knows any language — the model
              does, and the rules it writes are ordinary editable text.

     Test     Every graded set is a test of the rules that graded it. You rate
              each note — useful, too vague, too soft, wrong — and the note
              says which rules it applied, so a rating lands on a rule.

     Improve  Once enough notes graded under one version of the rules have
              been rated, and at least one of them was not useful, one text
              call rewrites the rules from those ratings. Nothing else drives
              it: no critic model, no guessing. Every revision can be undone.

   Everything here is a plain function over plain data so `node --test` can
   cover it; the calls are in gemini.js and the buttons in the tabs.

   Two rules this module keeps:

     A malformed reply changes nothing. readRules() returns null and the
     caller keeps the rules it had, exactly as a malformed grading stores
     nothing.

     A rule you wrote yourself is yours. A revision may not drop or reword it;
     anything the model returns in its place is ignored and your text put
     back. */

import { extractTrailingJson } from './shadowing.js';

export const MAX_LISTEN = 10;
export const MAX_STYLE = 4;
export const MAX_RULE_TEXT = 220;
const MAX_WHY = 200;
const MAX_HISTORY = 5;

/* How a note can be rated, in the order the buttons are shown. The meanings
   are spelled out to the revising model in buildRevisionPrompt(), and are the
   whole of what it learns from — so they are worded for it as much as for you. */
export const RATINGS = [
  ['useful', 'Useful'],
  ['vague', 'Too vague'],
  ['soft', 'Too soft'],
  ['wrong', 'Wrong'],
];
const RATING_KEYS = RATINGS.map(([key]) => key);

export function isRating(value) {
  return RATING_KEYS.includes(value);
}

/* Language-neutral, because they are about how a note is written rather than
   what is heard: these are the two things "too soft" was about before rules
   existed. They start every seed that does not bring its own. */
export const DEFAULT_STYLE_RULES = [
  'Lead each comment with the one change that would help that line most; praise gets at most one short clause after it.',
  'Never call a line good without naming the word and the rule it got right.',
];

/* ── where the rules live ────────────────────────────────────────────── */

/* Rules are kept per language, so switching from Vietnamese to French and
   back does not lose either. The key is only folded for case and space —
   "French" and "french " are one language, "Français" is honestly another. */
export function languageKey(name) {
  return String(name || '').trim().toLowerCase();
}

export function rulesFor(settings, language) {
  const map = (settings && settings.shadowRules) || {};
  const entry = map[languageKey(language)];
  return entry && Array.isArray(entry.rules) && entry.rules.length ? entry : null;
}

/* The whole shadowRules map with one language replaced, for saveSettings. */
export function withRules(settings, language, entry) {
  return { ...((settings && settings.shadowRules) || {}), [languageKey(language)]: entry };
}

/* ── the rules themselves ────────────────────────────────────────────── */

function cleanText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_RULE_TEXT);
}

function cleanRule(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const text = cleanText(raw.text);
  if (!text) return null;
  const id = Number(raw.id);
  return {
    id: Number.isInteger(id) && id > 0 ? id : null,
    kind: raw.kind === 'style' ? 'style' : 'listen',
    text,
    origin: ['seed', 'model', 'you'].includes(raw.origin) ? raw.origin : 'model',
  };
}

/* Deduplicated by text, capped per kind, and every rule given a unique id.
   An id the list already uses is taken away from the second rule claiming it
   rather than trusted, because a note citing rule 3 must mean one rule. */
export function cleanRules(list) {
  const out = [];
  const texts = new Set();
  const ids = new Set();
  const counts = { listen: 0, style: 0 };
  const cap = { listen: MAX_LISTEN, style: MAX_STYLE };
  for (const raw of Array.isArray(list) ? list : []) {
    const rule = cleanRule(raw);
    if (!rule) continue;
    const key = rule.text.toLowerCase();
    if (texts.has(key) || counts[rule.kind] >= cap[rule.kind]) continue;
    if (rule.id !== null && ids.has(rule.id)) rule.id = null;
    texts.add(key);
    counts[rule.kind]++;
    if (rule.id !== null) ids.add(rule.id);
    out.push(rule);
  }
  let next = Math.max(0, ...ids) + 1;
  for (const rule of out) if (rule.id === null) rule.id = next++;
  return out;
}

/* A stored entry, made safe: whatever settings.json held, what comes back has
   a whole generation, clean rules and a bounded history. */
export function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rules = cleanRules(raw.rules);
  if (!rules.length) return null;
  const generation = Math.max(1, Math.round(Number(raw.generation)) || 1);
  const history = (Array.isArray(raw.history) ? raw.history : [])
    .filter((h) => h && typeof h === 'object')
    .map((h) => ({
      generation: Math.max(1, Math.round(Number(h.generation)) || 1),
      rules: cleanRules(h.rules),
      reason: String(h.reason || '').slice(0, 300),
      at: String(h.at || ''),
    }))
    .filter((h) => h.rules.length)
    .slice(-MAX_HISTORY);
  return {
    generation,
    rules,
    history,
    reason: String(raw.reason || '').slice(0, 300),
    changes: cleanChanges(raw.changes),
    revisedAt: String(raw.revisedAt || ''),
  };
}

export function cleanRulesMap(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [key, value] of Object.entries(raw)) {
    const entry = cleanEntry(value);
    if (entry && languageKey(key)) out[languageKey(key)] = entry;
  }
  return out;
}

function cleanChanges(list) {
  return (Array.isArray(list) ? list : [])
    .filter((c) => c && ['add', 'edit', 'drop'].includes(c.kind))
    .map((c) => ({
      kind: c.kind,
      id: Number.isInteger(Number(c.id)) && Number(c.id) > 0 ? Number(c.id) : null,
      why: String(c.why || '').replace(/\s+/g, ' ').trim().slice(0, MAX_WHY),
    }))
    .slice(0, 20);
}

/* `after` is the highest version this language's sets were ever graded
   under. A first set of rules for a language that has had rules before
   continues the numbering instead of starting again at 1: ratings are
   counted per version number, and a reused number would hand the new rules
   ratings that were given to old ones. */
export function newEntry(rules, reason = '', now = new Date(), after = 0) {
  return {
    generation: Math.max(0, Math.round(Number(after)) || 0) + 1,
    rules: cleanRules(rules),
    history: [],
    reason,
    changes: [],
    revisedAt: now.toISOString(),
  };
}

/* ── seeding without a call ──────────────────────────────────────────── */

/* The one-time migration from the old free-text "Sounds to listen for"
   setting: "the six tones (ngang, huyền, …), the unreleased final consonants
   -c, -ch, -t, and the vowels ư, ơ and â" becomes three rules.

   Commas inside brackets never split. A fragment whose first word has two
   letters or fewer ("-ch", "ơ") is the tail of a list, not a new item, and
   is joined back onto the one before it. It is a heuristic for a sentence
   typed once; the result is ordinary text you can edit. */
export function seedFromSounds(text) {
  const source = String(text || '').trim();
  if (!source) return [];
  const pieces = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '(' || ch === '[') depth++;
    else if ((ch === ')' || ch === ']') && depth > 0) depth--;
    else if ((ch === ',' || ch === ';' || ch === '\n') && depth === 0) {
      pieces.push(source.slice(start, i));
      start = i + 1;
    }
  }
  pieces.push(source.slice(start));

  const items = [];
  for (const raw of pieces) {
    const piece = raw.trim().replace(/^and\s+/i, '').trim();
    if (!piece) continue;
    const first = piece.split(/\s+/)[0].replace(/[^\p{L}]/gu, '');
    if (items.length && first.length <= 2) items[items.length - 1] += `, ${piece}`;
    else items.push(piece);
  }
  const listen = items.map((item) => ({
    kind: 'listen',
    origin: 'seed',
    text: `Listen for ${item.replace(/[.\s]+$/, '')}: name the word where it slipped and say what it should do instead.`,
  }));
  return cleanRules([
    ...listen,
    ...DEFAULT_STYLE_RULES.map((text) => ({ kind: 'style', origin: 'seed', text })),
  ]);
}

/* ── the rules in the grading prompt ─────────────────────────────────── */

/* Numbered by id, not by position, because the note cites the number back
   and a rating has to land on the same rule after the list is reordered. */
export function formatRulesBlock(rules) {
  const list = cleanRules(rules);
  const listen = list.filter((r) => r.kind === 'listen');
  const style = list.filter((r) => r.kind === 'style');
  if (!list.length) return '(No rules yet: listen for whatever would help most.)';
  const lines = [];
  if (listen.length) lines.push('What to listen for:', ...listen.map((r) => `${r.id}. ${r.text}`));
  if (style.length) lines.push('How to write each comment:', ...style.map((r) => `${r.id}. ${r.text}`));
  return lines.join('\n');
}

/* ── seeding with a call ─────────────────────────────────────────────── */

export const RULES_SEED_PROMPT = `You are an experienced {language} pronunciation coach. A {level} learner records themselves reading {language} lines aloud, and another model listens to each recording and writes feedback on how it sounded. Write the rules that model should listen by.
{languageNote}

Return strict JSON only, and nothing else:
{"rules":[{"kind":"listen","text":"<one sentence>"},{"kind":"style","text":"<one sentence>"}, ...]}

- 6 to 8 "listen" rules. Each names ONE feature of spoken {language} that learners at this level commonly get wrong and that can actually be heard in a recording: a particular sound or contrast, tone or pitch, vowel length, stress, how words link together, rhythm, or sentence melody. Say what the correct version does and what the usual slip sounds like, and give an example word in {language} script.
- 1 or 2 "style" rules on how the feedback should be written so that it is precise and corrective rather than merely encouraging.
- One sentence per rule, at most 200 characters.
- Nothing about grammar, vocabulary, word choice or spelling: the learner is reading given text, so only how it sounds is being practised.`;

export function buildSeedPrompt({ language, level, languageNote = '' }) {
  return fill(RULES_SEED_PROMPT, {
    language: language || 'the target language',
    level: level || 'intermediate',
    languageNote: languageNote ? `The learner's own note on the variety they are learning: ${languageNote}` : '',
  });
}

/* ── ratings ─────────────────────────────────────────────────────────── */

export function emptyCounts() {
  return { useful: 0, vague: 0, soft: 0, wrong: 0 };
}

export function countRatings(notes) {
  const out = emptyCounts();
  for (const note of notes || []) if (note && isRating(note.rating)) out[note.rating]++;
  return out;
}

export function totalOf(counts) {
  return RATING_KEYS.reduce((sum, key) => sum + ((counts && counts[key]) || 0), 0);
}

function addCounts(a, b) {
  const out = emptyCounts();
  for (const key of RATING_KEYS) out[key] = ((a && a[key]) || 0) + ((b && b[key]) || 0);
  return out;
}

/* Ratings for one language and one version of its rules, summed from the
   history index — which carries a count per session, so this never opens a
   session file. */
export function ratingsFor(rows, language, generation) {
  const key = languageKey(language);
  let out = emptyCounts();
  for (const row of rows || []) {
    if (!row || languageKey(row.language) !== key) continue;
    /* A set's notes can come from hand-ins graded under different versions,
       so a row counts per version. A row written before that has one
       version for the whole set. */
    if (row.ratingsByGeneration && typeof row.ratingsByGeneration === 'object') {
      out = addCounts(out, row.ratingsByGeneration[generation]);
    } else if (row.rulesGeneration === generation) {
      out = addCounts(out, row.ratings);
    }
  }
  return out;
}

/* The rules version a note was graded under: its own since sets could be
   handed in piece by piece, the set's for a note from before that. */
export function noteGeneration(feedback, note) {
  if (note && Number.isInteger(note.rulesGeneration)) return note.rulesGeneration;
  return feedback && Number.isInteger(feedback.rulesGeneration) ? feedback.rulesGeneration : null;
}

/* Rating counts per rules version, for the history index. */
export function ratingsByGeneration(feedback) {
  const out = {};
  for (const note of (feedback && feedback.notes) || []) {
    const g = noteGeneration(feedback, note);
    if (g === null || !isRating(note.rating)) continue;
    out[g] = out[g] || emptyCounts();
    out[g][note.rating]++;
  }
  return out;
}

/* The highest rules version any set in this language was graded under, from
   the history index, or 0. What a language's first rules must number after. */
export function highestGeneration(rows, language) {
  const key = languageKey(language);
  let top = 0;
  for (const row of rows || []) {
    if (!row || languageKey(row.language) !== key) continue;
    const seen = [
      row.rulesGeneration,
      ...Object.keys((row.ratingsByGeneration && typeof row.ratingsByGeneration === 'object') ? row.ratingsByGeneration : {}),
    ].map(Number).filter((n) => Number.isInteger(n) && n > 0);
    top = Math.max(top, ...seen);
  }
  return top;
}

/* Revise once enough notes graded under THIS version have been rated, and
   only when at least one of them says something is off. A run of all-useful
   ratings is the rules working; spending a call to rewrite them would only
   risk breaking what works. Because the count is per version, a revision
   starts the count again on its own. */
export function shouldRevise(entry, rows, language, threshold) {
  if (!entry) return false;
  const counts = ratingsFor(rows, language, entry.generation);
  const need = Math.max(1, Math.round(Number(threshold)) || 1);
  return totalOf(counts) >= need && totalOf(counts) > counts.useful;
}

/* The rated notes of the sessions given, flattened for the revision prompt:
   the line, what the note said, what you said about it, and which rules it
   applied. Sessions of another language or another version are skipped. */
export function collectRated(sessions, language, generation) {
  const key = languageKey(language);
  const out = [];
  for (const session of sessions || []) {
    if (!session || languageKey(session.language) !== key) continue;
    const fb = session.feedback;
    if (!fb) continue;
    const text = new Map((session.items || []).map((i) => [i.index, i.text]));
    for (const note of fb.notes || []) {
      if (!isRating(note.rating) || noteGeneration(fb, note) !== generation) continue;
      out.push({
        line: String(text.get(note.itemIndex) || ''),
        comment: String(note.comment || ''),
        rating: note.rating,
        why: String(note.why || '').slice(0, MAX_WHY),
        rules: Array.isArray(note.rules) ? note.rules : [],
      });
    }
  }
  return out;
}

/* Per rule, how the notes that cited it were rated. */
export function ruleStats(rated) {
  const out = new Map();
  for (const note of rated || []) {
    for (const id of note.rules || []) {
      const counts = out.get(id) || emptyCounts();
      counts[note.rating]++;
      out.set(id, counts);
    }
  }
  return out;
}

function describeCounts(counts) {
  const parts = RATINGS
    .filter(([key]) => counts[key])
    .map(([key]) => `${counts[key]} ${key}`);
  return parts.length ? parts.join(', ') : 'not cited yet';
}

/* ── revising ────────────────────────────────────────────────────────── */

export const RULES_REVISE_PROMPT = `You maintain the listening rules for a model that gives {language} pronunciation feedback on a {level} learner's recordings of themselves reading {language} lines aloud. The learner has rated the notes that model wrote. Revise the rules so the next notes are more useful to them.
{languageNote}

What the ratings mean:
- useful: right, specific and worth hearing. Keep doing this.
- vague: did not name the word, the sound, or what to do differently.
- soft: too much praise; a real problem was missed or glossed over.
- wrong: described something that was not in the recording, or gave incorrect advice.

The current rules (version {generation}), each with how the notes that cited it were rated:
{rules}
{previous}
The rated notes, each with the line that was read, what the note said, the rating, and what the learner added:
{rated}

Return strict JSON only, and nothing else:
{"rules":[{"id":<its current number, or null for a new rule>,"kind":"listen"|"style","text":"<one sentence>"}, ...],"changes":[{"kind":"add"|"edit"|"drop","id":<number or null>,"why":"<one short sentence>"}, ...],"reason":"<one sentence on what this revision is for>"}

How to revise:
- Keep a rule whose notes were rated useful. Sharpen one whose notes were vague: make it name what to listen for and what the slip sounds like. Reword or drop one whose notes were wrong.
- If notes were rated soft, add or strengthen a "style" rule that makes a comment lead with the correction.
- Where the learner says what was missed, turn that into a specific "listen" rule for {language}.
- Rules marked (yours) were written by the learner: return them unchanged, with their id.
- At most ${MAX_LISTEN} "listen" and ${MAX_STYLE} "style" rules, one sentence each, at most 200 characters. Everything must be audible in a recording. Nothing about grammar, vocabulary, word choice or spelling.
- Change only what the ratings give a reason to change. If nothing needs changing, return the rules as they are and an empty "changes".`;

/* `previous` is the version before this one and how it was rated, so a
   revision that made things worse can be walked back by the model itself
   rather than only by you pressing Undo. */
export function buildRevisionPrompt({
  language, level, languageNote = '', entry, rated, current, previous = null,
}) {
  const stats = ruleStats(rated);
  const rules = cleanRules(entry && entry.rules).map((r) =>
    `${r.id}. [${r.kind}]${r.origin === 'you' ? ' (yours)' : ''} ${r.text} -- ${describeCounts(stats.get(r.id) || emptyCounts())}`);

  let before = '';
  if (previous && previous.rules && previous.rules.length) {
    const was = previous.counts || emptyCounts();
    const now = current || emptyCounts();
    before = `\nThe version before this one (version ${previous.generation}) had ${previous.counts ? `${was.useful} of ${totalOf(was)} notes` : 'no notes'} rated useful; this version has ${now.useful} of ${totalOf(now)}. If this version is doing worse, you may bring back rules from it:\n`
      + cleanRules(previous.rules).map((r) => `- [${r.kind}] ${r.text}`).join('\n') + '\n';
  }

  const notes = (rated || []).map((n, i) => [
    `${i + 1}. Line: "${n.line}"`,
    `   Note: "${n.comment}"`,
    `   Rated: ${n.rating}${n.rules.length ? ` (the note cited rule${n.rules.length === 1 ? '' : 's'} ${n.rules.join(', ')})` : ''}`,
    ...(n.why ? [`   The learner added: "${n.why}"`] : []),
  ].join('\n'));

  return fill(RULES_REVISE_PROMPT, {
    language: language || 'the target language',
    level: level || 'intermediate',
    languageNote: languageNote ? `The learner's own note on the variety they are learning: ${languageNote}` : '',
    generation: entry ? entry.generation : 1,
    rules: rules.join('\n') || '(none)',
    previous: before,
    rated: notes.join('\n') || '(none)',
  });
}

/* ── reading a reply back ────────────────────────────────────────────── */

/* The rules from a seed or revision reply, or null when there is nothing
   usable — and null must leave the rules as they were. A reply with no
   "listen" rule at all is unusable too: it would grade by style alone. */
export function readRules(text) {
  const parsed = extractTrailingJson(text);
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.rules)) return null;
  const rules = cleanRules(parsed.rules.map((r) => ({ ...r, origin: 'model' })));
  if (!rules.some((r) => r.kind === 'listen')) return null;
  return {
    rules,
    changes: cleanChanges(parsed.changes),
    reason: String(parsed.reason || '').replace(/\s+/g, ' ').trim().slice(0, 300),
  };
}

/* A freshly drafted set, topped up with the default style rules when the
   model brought none, since those are what keep the notes from going soft. */
export function seedEntry(reply, now = new Date(), after = 0) {
  const rules = reply.rules.map((r) => ({ ...r, origin: 'seed' }));
  if (!rules.some((r) => r.kind === 'style')) {
    rules.push(...DEFAULT_STYLE_RULES.map((text) => ({ kind: 'style', origin: 'seed', text })));
  }
  return newEntry(rules, 'Drafted for this language.', now, after);
}

function snapshot(entry) {
  return {
    generation: entry.generation,
    rules: entry.rules,
    reason: entry.reason || '',
    at: entry.revisedAt || '',
  };
}

function nextVersion(entry, rules, extra, now) {
  return {
    generation: entry.generation + 1,
    rules: cleanRules(rules),
    history: [...(entry.history || []), snapshot(entry)].slice(-MAX_HISTORY),
    reason: '',
    changes: [],
    revisedAt: now.toISOString(),
    ...extra,
  };
}

/* The revision applied. What the model returned for a rule you wrote is
   ignored and your rule put back as it was; a rule it kept word for word
   keeps its origin, and anything it touched becomes the model's. */
export function applyRevision(entry, reply, now = new Date()) {
  const current = new Map(entry.rules.map((r) => [r.id, r]));
  const mine = entry.rules.filter((r) => r.origin === 'you');
  const mineIds = new Set(mine.map((r) => r.id));
  const theirs = reply.rules
    .filter((r) => !mineIds.has(r.id))
    .map((r) => {
      const was = current.get(r.id);
      if (was && was.text === r.text && was.kind === r.kind) return { ...was };
      /* An id the current rules never had is a new rule, not a claim on one. */
      return { ...r, id: was ? r.id : null, origin: 'model' };
    });
  return nextVersion(entry, [...mine, ...theirs], {
    reason: reply.reason || 'Revised from your ratings.',
    changes: reply.changes || [],
  }, now);
}

/* Undo walks back one version at a time, and is itself a new version: the
   version numbers only ever go up, so ratings given to the undone version
   stay attached to it and cannot count towards the one restored. */
export function undoRevision(entry, now = new Date()) {
  const history = (entry && entry.history) || [];
  if (!history.length) return null;
  const back = history[history.length - 1];
  return {
    generation: entry.generation + 1,
    rules: cleanRules(back.rules),
    history: history.slice(0, -1),
    reason: `Back to the rules of version ${back.generation}.`,
    changes: [],
    revisedAt: now.toISOString(),
  };
}

/* ── editing by hand ─────────────────────────────────────────────────── */

const STYLE_PREFIX = /^style:\s*/i;

export function rulesToText(rules) {
  return cleanRules(rules).map((r) => (r.kind === 'style' ? `style: ${r.text}` : r.text)).join('\n');
}

/* One rule per line; "style:" in front makes it a style rule. A line kept
   exactly as it was keeps its number and origin, so its ratings still count;
   a changed or new line is yours. Returns null when nothing changed, so
   saving an untouched box does not make a new version. */
export function editRules(entry, text, now = new Date(), after = 0) {
  const current = entry ? entry.rules : [];
  const byText = new Map(current.map((r) => [`${r.kind}:${r.text}`, r]));
  const rules = String(text || '').split('\n').map((line) => {
    const style = STYLE_PREFIX.test(line.trim());
    const body = cleanText(line.trim().replace(STYLE_PREFIX, ''));
    if (!body) return null;
    const kind = style ? 'style' : 'listen';
    const kept = byText.get(`${kind}:${body}`);
    return kept ? { ...kept } : { id: null, kind, text: body, origin: 'you' };
  }).filter(Boolean);

  const cleaned = cleanRules(rules);
  const same = cleaned.length === current.length
    && cleaned.every((r, i) => r.text === current[i].text && r.kind === current[i].kind);
  if (same) return null;
  if (!entry) return cleaned.length ? newEntry(cleaned, 'Written by you.', now, after) : null;
  return nextVersion(entry, cleaned, { reason: 'Edited by you.' }, now);
}

/* ── the settings migration ──────────────────────────────────────────── */

/* A settings file from before rules existed. Its "Sounds to listen for" text
   becomes the first version of the current language's rules, with no call —
   unless it is the untouched default sounds list and the language is no
   longer the default one, because those sounds belong to the default
   language and would be wrong for any other. */
export function migrateSounds(language, sounds, defaults) {
  const text = String(sounds || '').trim();
  if (!text) return {};
  if (text === defaults.sounds && languageKey(language) !== languageKey(defaults.language)) return {};
  const rules = seedFromSounds(text);
  if (!rules.length) return {};
  return { [languageKey(language)]: newEntry(rules, 'Carried over from your Sounds to listen for setting.') };
}

/* ── helpers ─────────────────────────────────────────────────────────── */

/* The same {name} substitution gemini.js does, kept here so this module has
   no network code in its imports. */
function fill(template, vars) {
  return String(template).replace(/\{(\w+)\}/g, (match, name) =>
    (Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match));
}
