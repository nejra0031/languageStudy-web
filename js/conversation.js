/* Conversation: the parts that are plain logic. Reading a scenario, laying
   out every call a conversation makes, and reading each reply back. No DOM
   and no network — the tab is tab-conversation.js and the calls are in
   gemini.js.

   A conversation is two choices. What it is about, its `kind`, both ported
   from lessons-web:

     'roleplay'  a scene with two roles. The other person answers each of
                 your turns; your sixth turn gets their closing line and the
                 feedback from one call.
     'findout'   the other person knows three or four facts and gives one
                 only when you ask about it specifically. They answer all
                 six of your turns, say which facts they gave away, and the
                 feedback comes after.

   And how it is held, its `delivery`:

     'turns'     a few turns of your own, typed or spoken one at a time,
                 which is what the two descriptions above are of.
     'live'      spoken in real time over the Live API, for a set time
                 rather than a number of turns. See live.js.

   Either kind can be held either way. Live was once a third kind, a
   find-out held live, and records from then say kind: 'live' with no
   delivery. They are read through contentOf() and isLive() and never
   rewritten, so nothing else compares `kind` or `delivery` directly.

   With no lessons to hold the scenes, one call on the text model writes the
   scene around a few of your cards, and the opening line with it.

   A session is one JSON record, saved after every turn:

     {id, kind, delivery, created, title, language, level, request,
      cards: [{front, deck}], scenario,
      turns: [{speaker: 'partner'|'learner', text, cards?}],
      revealed: [fact ids], feedback, deliveryNote, ended, scored}

   turns[0] is always the other person's opening line. Only the learner's
   turns are graded, and only they count for the cards.

   The other person uses the cards too, so the learner hears each one and
   is not only asked to produce it. It marks each use in its line as
   [[number|words]], the way a Reading text is marked; the marks are taken
   out before the line is shown or kept, and the turn keeps which cards it
   used, as `cards`, indices into the session's cards. Each request then
   lists the ones it has not used yet. See cardUseBlock(). */

import { readingTermListing, readMarks } from './reading.js';
import { extractTrailingJson, cardVerdicts } from './json-reply.js';
import { fillTemplate, withFeedbackBlock, feedbackRequestText } from './gemini.js';
import { normalize } from './text.js';
import { modelLimits } from './defaults.js';
import { attachableClips, toBase64 } from './shadowing.js';
import { rulesFor, formatRulesBlock } from './shadow-rules.js';

export const KINDS = ['roleplay', 'findout'];
export const DELIVERIES = ['turns', 'live'];
const KIND_NAMES = { roleplay: 'roleplay', findout: 'find-out' };

/* What a conversation is about: 'roleplay' or 'findout'. Takes a session,
   an index row or a bare kind. The old third kind was a find-out. */
export function contentOf(session) {
  const kind = typeof session === 'string' ? session : session && session.kind;
  return kind === 'findout' || kind === 'live' ? 'findout' : 'roleplay';
}

/* Whether it is held live, by its delivery or by the old kind. */
export function isLive(session) {
  return !!session && (session.delivery === 'live' || session.kind === 'live');
}
/* Your turns in a conversation, unless the conversationTurns setting says
   otherwise. A conversation keeps the number it started with, as maxTurns,
   so a change in Settings never moves the end of one already under way. */
export const MAX_LEARNER_TURNS = 6;

export function turnsOf(session) {
  const n = Number(session && session.maxTurns);
  return Number.isInteger(n) && n >= 2 ? n : MAX_LEARNER_TURNS;
}

/* The most one typed turn takes. A turn is a line or two of speech. */
export const MAX_TURN_TEXT = 1000;

/* How many cards a scene is written around, unless the conversationTerms
   setting says otherwise. */
export const CONVERSATION_TERMS = 5;

const MAX_SCENE = 600;
const MAX_ROLE = 80;
const MAX_LINE = 1200;

/* ── the cost, said up front ─────────────────────────────────────────── */

/* How many replies the other person gives in `turns` turns of yours. A
   roleplay's last turn is answered by the closing call, so the replies
   model answers one fewer; a find-out answers every one, since a question
   left unanswered could not find anything out. */
export function repliesNeeded(kind, turns = MAX_LEARNER_TURNS) {
  return kind === 'findout' ? turns : turns - 1;
}

/* Every call a typed conversation of this kind makes, by model: one on the
   text model for the scene, the replies on the conversation model and one
   on the feedback model at the end. Two jobs on one model are one line,
   since they draw on one allowance. Spoken turns add a listening call each,
   and are not counted here: whether a turn is spoken is decided turn by
   turn. A live conversation is the scene, one live session, counted as one
   call on the live model however long it runs, and the feedback, whichever
   kind it is. `delivery` is 'turns' or 'live'. */
export function callsNeeded(settings, kind, delivery = 'turns') {
  const out = [];
  const add = (job, label, count) => {
    const model = settings[job];
    const hit = out.find((r) => r.model === model);
    if (hit) { hit.count += count; hit.jobs.push(label); } else out.push({ model, count, jobs: [label] });
  };
  add('sceneModel', 'the scene', 1);
  if (isLive({ kind, delivery })) {
    add('liveModel', 'the live conversation', 1);
    add('liveGradeModel', 'the feedback', 1);
    return out;
  }
  add('chatModel', 'the replies', repliesNeeded(contentOf(kind), settings.conversationTurns || MAX_LEARNER_TURNS));
  add('conversationGradeModel', 'the feedback', 1);
  return out;
}

/* Why a conversation of this kind cannot be finished on what is left of
   today's budget, or null. `usage(model, rpm, rpd)` is the limiter's. Only
   the daily allowance is asked about: a per-minute limit comes back within
   the conversation, and the scene call itself is refused by its own
   preflight if its model is blocked right now. A model short on its day is
   refused here, before a call is spent on a scene that could not be
   finished. */
export function budgetProblem(settings, kind, usage, delivery = 'turns') {
  const what = isLive({ kind, delivery }) ? 'live conversation' : KIND_NAMES[contentOf(kind)];
  for (const need of callsNeeded(settings, kind, delivery)) {
    const { rpm, rpd } = modelLimits(settings, need.model);
    const u = usage(need.model, rpm, rpd);
    if (u.leftDay !== null && u.leftDay < need.count) {
      return `${need.model} has ${u.leftDay} call${u.leftDay === 1 ? '' : 's'} left today, and a ${what} needs ${need.count} on it (${need.jobs.join(', ')}).`;
    }
  }
  return null;
}

/* ── the scene ───────────────────────────────────────────────────────── */

export function scenarioVars(settings, kind, cards, request) {
  return {
    factCount: settings.conversationFacts || 4,
    kind: KIND_NAMES[contentOf(kind)],
    language: settings.targetLanguage,
    level: settings.learnerLevel,
    languageNote: settings.languageNote || '',
    terms: cards.length ? readingTermListing(cards) : '(none)',
    request: String(request || '').trim(),
  };
}

function text(value, max) {
  return typeof value === 'string' ? value.replace(/<[^>]*>/g, '').trim().slice(0, max) : '';
}

/* A line a model wrapped in quotes, as it does despite being told not to. */
export function unquote(line) {
  return String(line || '').trim().replace(/^["'“‘«]+|["'”’»]+$/g, '').trim();
}

/* The scene as the reply gave it, or null for anything malformed: a field
   missing, a fact with no label or no answer, or more than one fact fewer
   than the `factCount` asked for (and never fewer than two). Ids are made
   strings and must be unique; facts beyond the count are dropped.
   `detail` is kept on the session, for the other person and for the end,
   and the tab does not show it until then. The opening line comes back
   without its marks, and `openingCards` says which of `cards` it used; that
   belongs to the first turn, not to the scene, and the caller moves it
   there. */
export function readScenario(reply, kind, factCount = 4, cards = []) {
  const p = extractTrailingJson(reply);
  if (!p || typeof p !== 'object') return null;
  const studentRole = text(p.studentRole, MAX_ROLE);
  const llmRole = text(p.llmRole, MAX_ROLE);
  const opening = readMarks(unquote(text(p.openingLine, MAX_LINE)), cards);
  const openingLine = opening.text;
  const openingCards = opening.used;
  if (!studentRole || !llmRole || !openingLine) return null;
  if (contentOf(kind) !== 'findout') {
    const scenario = text(p.scenario, MAX_SCENE);
    return scenario ? { scenario, studentRole, llmRole, openingLine, openingCards } : null;
  }
  const situation = text(p.situation, MAX_SCENE);
  const goal = text(p.goal, MAX_SCENE);
  if (!situation || !goal || !Array.isArray(p.facts)) return null;
  const facts = [];
  const ids = new Set();
  for (const f of p.facts) {
    if (!f || typeof f !== 'object') continue;
    const id = String(f.id ?? '').trim() || String(facts.length + 1);
    const label = text(f.label, 200);
    const detail = text(f.detail, 300);
    if (!label || !detail || ids.has(id)) continue;
    ids.add(id);
    facts.push({ id, label, detail });
    if (facts.length === factCount) break;
  }
  if (facts.length < Math.max(2, factCount - 1)) return null;
  return { situation, studentRole, llmRole, goal, facts, openingLine, openingCards };
}

/* ── the turns ───────────────────────────────────────────────────────── */

export function learnerTurns(session) {
  return ((session && session.turns) || []).filter((t) => t.speaker === 'learner').length;
}

/* The learner's last turn has not been answered: a reply that failed, to
   be sent again. A live conversation has no replies to wait for: its turns
   are written down as they are spoken, and whoever spoke last, spoke last. */
export function awaitingReply(session) {
  const turns = (session && session.turns) || [];
  return !session.ended && !isLive(session) && turns.length > 0 && turns[turns.length - 1].speaker === 'learner';
}

/* Ends with a full stop unless it already ends a sentence, so a scene
   dropped into "…in this scenario: {scenario} The learner…" still reads. */
function sentence(s) {
  const t = String(s || '').trim();
  return /[.!?。！？…]$/.test(t) ? t : `${t}.`;
}

function roleOf(session, turn) {
  const sc = session.scenario;
  return turn.speaker === 'learner' ? sc.studentRole : sc.llmRole;
}

/* ── the other person's own use of the cards ─────────────────────────── */

/* Which of the session's cards the other person has used in its own lines
   so far, as indices, in order. */
export function partnerUsed(session) {
  const used = new Set();
  for (const t of (session && session.turns) || []) {
    if (t.speaker === 'learner') continue;
    for (const i of Array.isArray(t.cards) ? t.cards : []) used.add(i);
  }
  return [...used].sort((a, b) => a - b);
}

/* How many lines the other person still has, the one being asked for
   included: an answer to each of the learner's turns left, and in a
   roleplay the closing line in place of the last answer. */
export function partnerLinesLeft(session) {
  return Math.max(1, turnsOf(session) - learnerTurns(session) + 1);
}

/* What the other person is told about using the cards itself. It writes
   one short line a request, so "every card at least once" is spread over
   the conversation: each request lists the cards it has not used yet and
   says how many of them this line should carry, enough to get through them
   all in the lines it has left and never more than two, which is as many as
   a line or two of speech holds without being bent round them. The marks
   are how the next request knows what was used. */
export const CARD_USE_BLOCK = `YOUR OWN USE OF THE LEARNER'S FLASHCARDS. Across this conversation you must use every one of the learner's numbered words and grammar patterns at least once in what YOU say, naturally and in the sense given, so that the learner hears each one used as well as being asked to use it. You have not used these yet:
{unused}
You have {linesLeft} line(s) left, this one included, so use at least {atLeast} of them in this line. A word may be inflected or conjugated as your sentence needs; a grammar pattern keeps its fixed words, in order, with its gaps filled by your own words. Your line must still be something your character would say at this point.
Mark every use by wrapping the words as they appear in your line in [[number|words]], with the item's number from the list, e.g. [[4|went]]. For a grammar pattern, mark each fixed part on its own with the same number and leave the words in its gaps unmarked, e.g. [[7|not only]] cheap [[7|but also]] fast. The marks are taken out before the learner reads the line, so put nothing else in double brackets.`;

export const CARD_USE_DONE = 'YOUR OWN USE OF THE LEARNER\'S FLASHCARDS. You have already used every one of them in your own lines, so there is nothing to work in now: just say your line.';

/* In a find-out the facts come first: a card is never worth a fact. */
export const CARD_USE_FACTS = 'Using a flashcard is NEVER a reason to give away a fact. Work it into something you would say anyway; if one only fits by revealing something the learner has not asked about, leave it for a later line.';

/* The block for one request: '' with no cards, since there is then nothing
   to say. `cards` are the session's cards as the decks have them. */
export function cardUseBlock(session, cards, { guardFacts = false } = {}) {
  if (!cards || !cards.length) return '';
  const used = new Set(partnerUsed(session));
  const unused = cards.map((_, i) => i).filter((i) => !used.has(i));
  if (!unused.length) return CARD_USE_DONE;
  const linesLeft = partnerLinesLeft(session);
  const block = fillTemplate(CARD_USE_BLOCK, {
    unused: readingTermListing(cards, new Set(unused)),
    linesLeft,
    atLeast: Math.min(unused.length, 2, Math.ceil(unused.length / linesLeft)),
  });
  return guardFacts ? `${block}\n${CARD_USE_FACTS}` : block;
}

/* A reply prompt without {cardUse}, one customised before it existed or
   rewritten since, gets the block at its end, so a rewritten prompt cannot
   drop it. */
export function withCardUse(template) {
  const t = String(template || '');
  return t.includes('{cardUse}') ? t : `${t}\n\n{cardUse}`;
}

/* ── roleplay ────────────────────────────────────────────────────────── */

/* The other person's next line: the scene, the roles and the turn in the
   system instruction, the conversation so far in the message. `cards` are
   the session's cards as the decks have them, {front, back, type}. */
export function roleplayReplyRequest(settings, session, cards) {
  const sc = session.scenario;
  const system = fillTemplate(withCardUse(settings.prompts.roleplayReply), {
    cardUse: cardUseBlock(session, cards),
    llmRole: sc.llmRole,
    studentRole: sc.studentRole,
    scenario: sentence(sc.scenario),
    language: settings.targetLanguage,
    level: settings.learnerLevel,
    languageNote: settings.languageNote || '',
    turn: learnerTurns(session),
    maxTurns: turnsOf(session),
    terms: cards.length ? readingTermListing(cards) : '(none)',
  });
  const transcript = session.turns.map((t) => `${roleOf(session, t)}: ${t.text}`).join('\n');
  return { system, user: `Conversation so far:\n${transcript}\n\nWrite ${sc.llmRole}'s next line.` };
}

/* Plain text, so the whole reply is the line: wrapping quotes and a role
   label the model put in front of it are taken off, and so are its marks.
   {text, cards}, the line and which of `cards` it used, or null when
   nothing is left. */
export function readRoleplayReply(reply, session, cards = []) {
  let line = unquote(String(reply || '').replace(/^```\w*|```$/g, ''));
  const role = session && session.scenario && session.scenario.llmRole;
  if (role) {
    const label = new RegExp(`^\\**${role.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\**\\s*:\\s*`, 'i');
    line = unquote(line.replace(label, ''));
  }
  const read = readMarks(line, cards);
  return read.text ? { text: read.text.slice(0, MAX_LINE), cards: read.used } : null;
}

/* The closing call. With `closing`, the prompt also asks for the other
   person's last line; without, the learner ended early and there is none. */
export const CLOSING_LINE = 'This is the final turn of the conversation, so do this first: stay strictly in character as the "{llmRole}" and write your character\'s final line of spoken dialogue, in natural, idiomatic {language} -- no quotes, no stage directions, no meta-commentary. Keep it short (one or two sentences) and bring the conversation to a polite, natural close. Put it in "reply".';
export const NO_CLOSING_LINE = 'The learner ended the conversation early. Do not write a closing line, and leave "reply" out.';

/* The closing line is a goodbye, so a card the other person has not used
   yet is offered to it, not required of it. */
function closingCardUse(session, cards) {
  if (!cards || !cards.length) return '';
  const used = new Set(partnerUsed(session));
  const left = cards.map((c, i) => ({ c, n: i + 1 })).filter(({ n }) => !used.has(n - 1));
  if (!left.length) return '';
  return ` If one fits a natural goodbye, use one of the learner's flashcards you have not yet used in your own lines (${left.map(({ c, n }) => `${n}. "${c.front}"`).join(', ')}) and mark it in the line as [[number|words]]; never force one in.`;
}

export function roleplayGradeRequest(settings, session, cards, { closing }) {
  const sc = session.scenario;
  const vars = {
    llmRole: sc.llmRole,
    studentRole: sc.studentRole,
    scenario: sentence(sc.scenario),
    language: settings.targetLanguage,
    level: settings.learnerLevel,
    languageNote: settings.languageNote || '',
    feedback: feedbackRequestText(settings.feedbackRequest),
  };
  vars.closing = fillTemplate(closing ? CLOSING_LINE : NO_CLOSING_LINE, vars) + (closing ? closingCardUse(session, cards) : '');
  const system = fillTemplate(withFeedbackBlock(settings.prompts.conversationGrade), vars);
  const transcript = session.turns.map((t, i) => `${i}. ${roleOf(session, t)}: ${t.text}`).join('\n');
  const mine = session.turns
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.speaker === 'learner')
    .map(({ t, i }) => `Position ${i}: "${t.text}"`)
    .join('\n');
  const user = `${closing ? 'Conversation so far (including the learner\'s just-sent final turn)' : 'Full transcript'}:\n${transcript}\n\n`
    + `Learner's turns to review:\n${mine}\n\n`
    + `<cards>\n${cards.length ? readingTermListing(cards) : '(none)'}\n</cards>`;
  return { system, user };
}

/* Only feedback that points at one of the learner's own turns, by its
   position in the transcript, is kept, the first for each; "natural" and
   "comment" default to empty. */
export function normaliseTurnFeedback(raw, turns) {
  const out = [];
  const seen = new Set();
  for (const f of Array.isArray(raw) ? raw : []) {
    if (!f || typeof f.turnIndex !== 'number') continue;
    const i = f.turnIndex;
    if (!Number.isInteger(i) || !turns[i] || turns[i].speaker !== 'learner' || seen.has(i)) continue;
    seen.add(i);
    out.push({
      turnIndex: i,
      natural: typeof f.natural === 'string' ? f.natural.trim().slice(0, MAX_LINE) : '',
      comment: typeof f.comment === 'string' ? f.comment.trim().slice(0, 600) : '',
    });
  }
  return out.sort((a, b) => a.turnIndex - b.turnIndex);
}

/* {reply?, feedback, cards} or null. A closing call must bring a closing
   line; both must bring a feedback list, even an empty one. */
export function readRoleplayGrade(reply, session, cards, { closing }) {
  const p = extractTrailingJson(reply);
  if (!p || typeof p !== 'object' || !Array.isArray(p.feedback)) return null;
  const out = {
    feedback: normaliseTurnFeedback(p.feedback, session.turns),
    cards: cardVerdicts(p, cards),
    deliveryNote: typeof p.deliveryNote === 'string' && p.deliveryNote.trim() ? p.deliveryNote.trim().slice(0, 1500) : null,
  };
  if (closing) {
    const line = readMarks(unquote(text(p.reply, MAX_LINE)), cards);
    if (!line.text) return null;
    out.reply = line.text;
    out.replyCards = line.used;
  }
  return out;
}

/* Whether "More natural" says something the learner did not: case and
   punctuation are folded, since spoken turns have neither, and diacritics
   are kept, since a changed accent is a real correction. */
export function suggestionChanged(natural, original) {
  if (!natural) return false;
  return normalize(natural) !== normalize(original || '');
}

/* ── find out ────────────────────────────────────────────────────────── */

/* The facts as the other person holds them: the answers are in here, and
   this goes nowhere but the system instruction. */
export function factSheet(facts) {
  return (facts || []).map((f) => `- id "${f.id}" -- ${f.label}: ${f.detail}`).join('\n');
}

/* Ids the reply named, kept only when the scene has such a fact, each once. */
export function normaliseIds(value, facts) {
  const known = new Set((facts || []).map((f) => String(f.id)));
  const out = [];
  for (const id of Array.isArray(value) ? value : []) {
    const key = String(id);
    if (known.has(key) && !out.includes(key)) out.push(key);
  }
  return out;
}

export function findOutReplyRequest(settings, session, cards = []) {
  const sc = session.scenario;
  const known = normaliseIds(session.revealed, sc.facts);
  const remaining = sc.facts.filter((f) => !known.includes(String(f.id)));
  const system = fillTemplate(withCardUse(settings.prompts.findOutReply), {
    cardUse: cardUseBlock(session, cards, { guardFacts: true }),
    situation: sc.situation,
    llmRole: sc.llmRole,
    studentRole: sc.studentRole,
    language: settings.targetLanguage,
    level: settings.learnerLevel,
    languageNote: settings.languageNote || '',
    facts: factSheet(sc.facts),
    left: turnsOf(session) - learnerTurns(session),
    remaining: remaining.length
      ? `They have not yet asked about: ${remaining.map((f) => f.label).join('; ')}. Do not steer them there and do not mention that anything is missing.`
      : 'They have already found out everything you know, so simply carry the conversation on pleasantly.',
  });
  const transcript = session.turns.map((t) => `${t.speaker === 'learner' ? 'LEARNER' : 'YOU'}: ${t.text}`).join('\n');
  return { system, user: `The conversation so far:\n${transcript}\n\nSay what you say next.` };
}

/* {text, revealed, cards} or null. What the other person says they gave
   away is taken at their word: "found" is self-reported, and the checklist
   follows it. Which of `cards` the line used is read from its marks, which
   are taken out of it. */
export function readFindOutReply(reply, facts, cards = []) {
  const p = extractTrailingJson(reply);
  const line = readMarks(p && typeof p === 'object' ? unquote(text(p.reply, MAX_LINE)) : '', cards);
  if (!line.text) return null;
  return { text: line.text, revealed: normaliseIds(p.revealed, facts), cards: line.used };
}

/* Which fact labels were found and which never asked about, from what the
   other person gave away. */
export function factStatus(session) {
  const facts = (session && session.scenario && session.scenario.facts) || [];
  const revealed = normaliseIds(session && session.revealed, facts);
  return {
    found: facts.filter((f) => revealed.includes(String(f.id))).map((f) => f.label),
    missed: facts.filter((f) => !revealed.includes(String(f.id))).map((f) => f.label),
  };
}

export function findOutGradeRequest(settings, session, cards) {
  const sc = session.scenario;
  const { found, missed } = factStatus(session);
  const system = fillTemplate(withFeedbackBlock(settings.prompts.findOutGrade), {
    language: settings.targetLanguage,
    languageNote: settings.languageNote || '',
    feedback: feedbackRequestText(settings.feedbackRequest),
  });
  const transcript = session.turns.map((t) => `${t.speaker === 'learner' ? 'LEARNER' : 'OTHER PERSON'}: ${t.text}`).join('\n');
  const user = `The situation: ${sc.situation}
The learner was playing: ${sc.studentRole}
They were talking to: ${sc.llmRole}
What they were sent to find out: ${sc.goal}
The learner's level: ${settings.learnerLevel}

They found out: ${found.length ? found.join('; ') : 'nothing'}
They never asked about: ${missed.length ? missed.join('; ') : 'nothing -- they got everything'}

The conversation:
${transcript}

<cards>
${cards.length ? readingTermListing(cards) : '(none)'}
</cards>`;
  return { system, user };
}

/* {conversation, asking, nextTime, found, missed, cards} or null. The
   three notes are trimmed to what a reader takes in at once; found and
   missed are worked out here, never taken from the reply. */
export function readFindOutGrade(reply, session, cards) {
  const p = extractTrailingJson(reply);
  if (!p || typeof p !== 'object') return null;
  const conversation = text(p.conversation, 1500);
  if (!conversation) return null;
  return {
    conversation,
    asking: text(p.asking, 800) || null,
    nextTime: text(p.nextTime, 400) || null,
    ...factStatus(session),
    cards: cardVerdicts(p, cards),
  };
}

/* ── kept conversations ──────────────────────────────────────────────── */

export function conversationTitle(session) {
  const sc = session.scenario || {};
  return String((contentOf(session) === 'findout' ? sc.goal || sc.situation : sc.scenario) || '').trim();
}

/* ── spoken turns ────────────────────────────────────────────────────── */

/* What the transcriber is given besides the recording: the scene and the
   line being answered, to hear a hesitant speaker accurately, and a warning
   not to let that context put words in their mouth. `clip` is
   {mime, bytes}. */
export function transcribeRequest(settings, session, clip) {
  const sc = session.scenario || {};
  const context = [
    sc.scenario || sc.situation ? `Situation: ${sc.scenario || sc.situation}` : '',
    sc.studentRole ? `The speaker is playing: ${sc.studentRole}` : '',
    sc.llmRole ? `They are talking to: ${sc.llmRole}` : '',
    settings.learnerLevel ? `Their level: ${settings.learnerLevel}` : '',
  ].filter(Boolean).join('\n');
  const last = [...(session.turns || [])].reverse().find((t) => t.speaker !== 'learner');
  const text = [
    context,
    last ? `The line they are replying to: "${last.text}"` : '',
    'Use the above only to hear the recording accurately. Do not let it lead you into transcribing a reply the speaker did not actually give.',
    'The recording:',
  ].filter(Boolean).join('\n\n');
  return {
    system: fillTemplate(settings.prompts.transcribe, { language: settings.targetLanguage }),
    parts: [
      { text },
      { inlineData: { mimeType: clip.mime || 'audio/webm', data: clip.base64 || toBase64(clip.bytes) } },
    ],
  };
}

/* The transcript, trimmed and capped, which may be '' for a recording with
   nothing in it; null for a reply without one at all, which is a failure. */
export function readTranscript(reply) {
  const p = extractTrailingJson(reply);
  if (!p || typeof p !== 'object' || typeof p.transcript !== 'string') return null;
  return p.transcript.replace(/\s+/g, ' ').trim().slice(0, MAX_TURN_TEXT);
}

/* How the model is to listen, lessons-web's PRONUNCIATION_JUDGING with
   {language} for Dutch. The rules it applies are this language's own
   listening rules, the ones Shadowing grades by and your ratings revise. */
export const DELIVERY_JUDGING = `How to use the <rules>:
- Check every recording against every rule that applies to the words in it. Your job is to find where the {language} went wrong; a note that finds nothing wrong in recordings that had problems teaches nothing.
- Every problem you report names the sound, quotes the {language} word it happened in, and says what the sound should do instead. Report the clearest problems, most important first. The rule numbers are for your reference only: the learner never sees the list, so never write a number in your feedback.
- Say nothing about anything outside the rules.
- Praise is allowed ONLY for a rule that was clearly met on a word where it is easy to get wrong, and it must name the sound and the word. Never praise in general terms ("good pace", "clear", "nice job", "well done").
- Do not soften a problem into something smaller than it was ("slightly", "a tiny bit", "almost perfect") unless it really was minor.
- NEVER pass judgement on their accent as a whole, never call an accent strong, heavy or foreign, and never hold up sounding like a native speaker as the goal. A concrete finding about one sound in one word is useful; a verdict on how foreign they sound is not.
- Judge ONLY what you can actually hear. If you are not sure how a sound came out, leave it out rather than guessing either way.`;

/* lessons-web's DELIVERY_ADDENDUM, appended to the roleplay grader's system
   instruction when the conversation has recordings. The rules are this
   language's listening rules, formatted as shadowSystem() formats them, in
   place of lessons-web's Dutch list. */
export function deliveryAddendum(settings) {
  const entry = rulesFor(settings, settings.targetLanguage);
  const rules = formatRulesBlock(entry ? entry.rules : []);
  return `
ONE ADDITION TO THE JSON DESCRIBED ABOVE. Attached after the text below are the learner's own recordings of the turns you are reviewing -- each one introduced by a line naming the transcript position it belongs to. The recordings are the authoritative record of what was actually said; the written turns are a transcription of them.

Listen to them, and include ONE extra top-level field in the JSON alongside the fields already specified: "deliveryNote" -- two to four short sentences on how the {language} SOUNDED, rather than on what it said, judged against these rules and nothing else:

<rules>
${rules}
</rules>

${DELIVERY_JUDGING}

In "deliveryNote", lead with the problems that came up most across the turns, each with the {language} word you heard it in. Address the learner as "you".

Base "deliveryNote" ONLY on the recordings; if there is nothing audible to say, return an empty string for it rather than inventing something. Nothing you hear may change any other field: the closing line, "natural", "comment" and "cards" are still judged on the words alone.`.replace(/\{language\}/g, settings.targetLanguage);
}

/* The grading request with the recordings attached, oldest turn first and
   as many as fit the 12 MB budget, each introduced by its position. With no
   clip that fits, the request is returned as it was, with no addendum: a
   conversation typed throughout is graded exactly as before. `clips` are
   {turnIndex, mime, bytes}. */
export function withDelivery(settings, { system, user }, clips) {
  const attach = attachableClips((clips || []).slice().sort((a, b) => a.turnIndex - b.turnIndex));
  const parts = [{ text: user }];
  if (!attach.length) return { system, parts, attached: 0 };
  for (const clip of attach) {
    parts.push({ text: `Recording of the learner's turn at position ${clip.turnIndex}:` });
    parts.push({ inlineData: { mimeType: clip.mime || 'audio/webm', data: clip.base64 || toBase64(clip.bytes) } });
  }
  return { system: `${system}\n${deliveryAddendum(settings)}`, parts, attached: attach.length };
}

/* Where a spoken turn's recording is kept: beside the conversation, named
   for the position the turn takes in it. */
export function clipPath(sessionId, turnIndex, ext) {
  return `conversation/${sessionId}_${turnIndex}.${ext}`;
}
