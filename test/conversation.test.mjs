/* Conversation's decisions: reading a scene, every request a conversation
   makes, and each reply read back. A malformed reply has to be null, never
   a half-read scene or a grade on the wrong turn. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  readScenario, normaliseIds, normaliseTurnFeedback, suggestionChanged, callsNeeded, budgetProblem,
  repliesNeeded, roleplayReplyRequest, readRoleplayReply, roleplayGradeRequest, readRoleplayGrade,
  findOutReplyRequest, readFindOutReply, findOutGradeRequest, readFindOutGrade, factStatus, factSheet,
  learnerTurns, awaitingReply, scenarioVars, conversationTitle, MAX_LEARNER_TURNS,
} from '../js/conversation.js';
import { withDefaults } from '../js/defaults.js';
import { RateLimiter } from '../js/gemini.js';

const settings = withDefaults({ targetLanguage: 'Spanish', learnerLevel: 'B1', feedbackRequest: 'English' });
const cards = [{ front: 'madrugar', back: 'to get up early' }, { front: 'no solo … sino también …', back: 'not only … but also …', type: 'pattern' }];

const roleplayScene = {
  scenario: 'Quieres devolver unos zapatos a la tienda', studentRole: 'Cliente', llmRole: 'Dependienta',
  openingLine: '"Buenos días, ¿en qué puedo ayudarle?"',
};
const findOutScene = {
  situation: 'Acabas de mudarte.', studentRole: 'Vecino nuevo', llmRole: 'Vecina', goal: 'Averigua cómo funciona el edificio.',
  facts: [
    { id: 1, label: 'cuándo recogen la basura', detail: 'martes y viernes' },
    { id: '2', label: 'dónde está el buzón', detail: 'en la entrada' },
    { id: '3', label: 'la contraseña del wifi', detail: 'casa1234' },
    { id: '4', label: 'quién es el portero', detail: 'Luis' },
    { id: '5', label: 'extra', detail: 'dropped' },
  ],
  openingLine: 'Hola, ¡bienvenido!',
};

/* ── the scene ───────────────────────────────────────────────────────── */

test('a roleplay scene reads back, with the opening line unquoted', () => {
  const sc = readScenario(`Here:\n${JSON.stringify(roleplayScene)}`, 'roleplay');
  assert.deepEqual(sc, { ...roleplayScene, openingLine: 'Buenos días, ¿en qué puedo ayudarle?' });
});

test('a find-out scene keeps four facts at most, ids as strings', () => {
  const sc = readScenario(JSON.stringify(findOutScene), 'findout');
  assert.deepEqual(sc.facts.map((f) => f.id), ['1', '2', '3', '4']);
  assert.equal(sc.goal, 'Averigua cómo funciona el edificio.');
});

test('a malformed scene is null', () => {
  assert.equal(readScenario('no json', 'roleplay'), null);
  assert.equal(readScenario(JSON.stringify({ ...roleplayScene, openingLine: '' }), 'roleplay'), null);
  assert.equal(readScenario(JSON.stringify({ ...roleplayScene, scenario: undefined }), 'roleplay'), null);
  assert.equal(readScenario(JSON.stringify({ ...findOutScene, facts: findOutScene.facts.slice(0, 2) }), 'findout'), null, 'fewer than three facts');
  assert.equal(readScenario(JSON.stringify({ ...findOutScene, goal: '' }), 'findout'), null);
  const dupes = { ...findOutScene, facts: [findOutScene.facts[0], findOutScene.facts[0], findOutScene.facts[1]] };
  assert.equal(readScenario(JSON.stringify(dupes), 'findout'), null, 'a repeated id is one fact');
  assert.equal(readScenario(JSON.stringify(roleplayScene), 'findout'), null, 'a roleplay is not a find-out');
});

test('the scene prompt is told the kind, the cards and the request', () => {
  const vars = scenarioVars(settings, 'findout', cards, '  at the bakery ');
  assert.equal(vars.kind, 'find-out');
  assert.equal(vars.request, 'at the bakery');
  assert.match(vars.terms, /^1\. "madrugar"/);
  assert.equal(scenarioVars(settings, 'roleplay', [], '').terms, '(none)');
});

/* ── the cost ────────────────────────────────────────────────────────── */

test('a roleplay needs five replies and a find-out six', () => {
  assert.equal(repliesNeeded('roleplay'), 5);
  assert.equal(repliesNeeded('findout'), 6);
});

test('the calls are counted by model, two jobs on one model on one line', () => {
  const s = withDefaults({ ...settings, textModel: 'flash', gradeModel: 'flash', chatModel: 'lite', models: [{ id: 'flash' }, { id: 'lite' }] });
  assert.deepEqual(callsNeeded(s, 'roleplay'), [
    { model: 'flash', count: 2, jobs: ['the scene', 'the feedback'] },
    { model: 'lite', count: 5, jobs: ['the replies'] },
  ]);
});

test('a conversation that could not be finished today is refused before it starts', () => {
  const s = withDefaults({ ...settings, textModel: 'flash', gradeModel: 'flash', chatModel: 'lite', models: [{ id: 'flash', rpd: 20 }, { id: 'lite', rpd: 6 }] });
  const lim = new RateLimiter({ now: () => 1000 });
  const usage = (m, rpm, rpd) => lim.usage(m, rpm, rpd);
  assert.equal(budgetProblem(s, 'roleplay', usage), null);
  assert.equal(budgetProblem(s, 'findout', usage), null);
  lim.calls.lite = [900];
  assert.equal(budgetProblem(s, 'roleplay', usage), null, 'five left, five needed');
  assert.match(budgetProblem(s, 'findout', usage), /lite has 5 calls left today, and a find-out needs 6 on it \(the replies\)/);
  const open = withDefaults({ ...settings, models: [{ id: 'gemini-3.6-flash', rpd: 0 }] });
  assert.equal(budgetProblem(open, 'findout', usage), null, 'unlimited is never short');
});

/* ── roleplay ────────────────────────────────────────────────────────── */

const roleplay = {
  kind: 'roleplay',
  scenario: readScenario(JSON.stringify(roleplayScene), 'roleplay'),
  turns: [
    { speaker: 'partner', text: 'Buenos días.' },
    { speaker: 'learner', text: 'hola quiero devolver esto' },
    { speaker: 'partner', text: '¿Tiene el tique?' },
    { speaker: 'learner', text: 'si aqui esta' },
  ],
  revealed: [],
};

test('the reply request has the scene, the turn and the transcript by role', () => {
  const { system, user } = roleplayReplyRequest(settings, roleplay, cards);
  assert.match(system, /^You are roleplaying as the "Dependienta" in this scenario: Quieres devolver unos zapatos a la tienda\. The learner is playing "Cliente"\./);
  assert.match(system, /This is turn 2 of 6 for the learner\./);
  assert.match(system, /2\. the grammar pattern "no solo … sino también …"/);
  assert.equal(user, 'Conversation so far:\nDependienta: Buenos días.\nCliente: hola quiero devolver esto\nDependienta: ¿Tiene el tique?\nCliente: si aqui esta\n\nWrite Dependienta\'s next line.');
});

test('a plain-text reply loses its wrapping quotes and a role label', () => {
  assert.equal(readRoleplayReply('"Muy bien, gracias."', roleplay), 'Muy bien, gracias.');
  assert.equal(readRoleplayReply('Dependienta: «Perfecto.»', roleplay), 'Perfecto.');
  assert.equal(readRoleplayReply('  ', roleplay), null);
});

test('the grading request numbers every turn and lists the learner\'s by position', () => {
  const { system, user } = roleplayGradeRequest(settings, roleplay, cards, { closing: true });
  assert.match(system, /This is the final turn of the conversation.*"Dependienta"/);
  assert.match(system, /<feedback_request>\nEnglish\n<\/feedback_request>/);
  assert.doesNotMatch(system, /\{(closing|language|scenario|feedback)\}/);
  assert.match(user, /^Conversation so far \(including the learner's just-sent final turn\):\n0\. Dependienta: Buenos días\.\n1\. Cliente: hola/);
  assert.match(user, /Learner's turns to review:\nPosition 1: "hola quiero devolver esto"\nPosition 3: "si aqui esta"/);
  assert.match(user, /<cards>\n1\. "madrugar"/);
  const early = roleplayGradeRequest(settings, roleplay, cards, { closing: false });
  assert.match(early.system, /ended the conversation early\. Do not write a closing line/);
  assert.match(early.user, /^Full transcript:/);
});

test('turn feedback is kept only for the learner\'s own turns, once each', () => {
  const out = normaliseTurnFeedback([
    { turnIndex: 1, natural: 'Hola, quiero devolver esto.', comment: 'Good.' },
    { turnIndex: 0, comment: 'That was the partner.' },
    { turnIndex: 3 },
    { turnIndex: 1, comment: 'again' },
    { turnIndex: '3', comment: 'string index' },
    { turnIndex: 9, comment: 'no such turn' },
    null,
  ], roleplay.turns);
  assert.deepEqual(out, [
    { turnIndex: 1, natural: 'Hola, quiero devolver esto.', comment: 'Good.' },
    { turnIndex: 3, natural: '', comment: '' },
  ]);
});

test('a closing grade must bring its line; an early one need not', () => {
  const reply = { feedback: [{ turnIndex: 1, comment: 'ok' }], cards: [{ number: 1, verdict: 'absent' }] };
  assert.equal(readRoleplayGrade(JSON.stringify(reply), roleplay, cards, { closing: true }), null);
  const closed = readRoleplayGrade(JSON.stringify({ ...reply, reply: '"¡Hasta luego!"' }), roleplay, cards, { closing: true });
  assert.equal(closed.reply, '¡Hasta luego!');
  assert.deepEqual(closed.cards.map((c) => c.verdict), ['absent']);
  const early = readRoleplayGrade(JSON.stringify(reply), roleplay, cards, { closing: false });
  assert.equal(early.reply, undefined);
  assert.equal(early.feedback.length, 1);
  assert.equal(readRoleplayGrade('{"reply":"x"}', roleplay, cards, { closing: true }), null, 'no feedback list');
  assert.equal(readRoleplayGrade('nope', roleplay, cards, { closing: false }), null);
});

test('"More natural" shows only for a real change, and a changed accent is one', () => {
  assert.equal(suggestionChanged('Sí, aquí está.', 'sí aquí está'), false, 'case and punctuation only');
  assert.equal(suggestionChanged('Sí, aquí está.', 'si aqui esta'), true, 'the accents were missing');
  assert.equal(suggestionChanged('', 'anything'), false);
  assert.equal(suggestionChanged('Quiero devolverlo.', 'quiero devolver esto'), true);
});

/* ── find out ────────────────────────────────────────────────────────── */

const findOut = {
  kind: 'findout',
  scenario: readScenario(JSON.stringify(findOutScene), 'findout'),
  turns: [
    { speaker: 'partner', text: 'Hola.' },
    { speaker: 'learner', text: '¿Cuándo recogen la basura?' },
    { speaker: 'partner', text: 'Martes y viernes.' },
    { speaker: 'learner', text: '¿Tienes consejos?' },
  ],
  revealed: ['1'],
};

test('ids are kept only when the scene has such a fact, each once', () => {
  assert.deepEqual(normaliseIds(['2', 2, '9', 'x', 1], findOut.scenario.facts), ['2', '1']);
  assert.deepEqual(normaliseIds('2', findOut.scenario.facts), []);
});

test('the find-out reply knows the facts, the turns left and what is still unasked', () => {
  const { system, user } = findOutReplyRequest(settings, findOut);
  assert.match(system, /- id "1" -- cuándo recogen la basura: martes y viernes/);
  assert.match(system, /The learner has 4 turn\(s\) left after this one\. They have not yet asked about: dónde está el buzón; la contraseña del wifi; quién es el portero\./);
  assert.doesNotMatch(system, /cuándo recogen la basura\. Do not steer/);
  assert.equal(user, 'The conversation so far:\nYOU: Hola.\nLEARNER: ¿Cuándo recogen la basura?\nYOU: Martes y viernes.\nLEARNER: ¿Tienes consejos?\n\nSay what you say next.');
  const all = { ...findOut, revealed: ['1', '2', '3', '4'] };
  assert.match(findOutReplyRequest(settings, all).system, /already found out everything you know/);
});

test('a find-out reply reads its line and the facts it gave away', () => {
  assert.deepEqual(readFindOutReply('{"reply":"Depende de lo que quieras saber.","revealed":[]}', findOut.scenario.facts),
    { text: 'Depende de lo que quieras saber.', revealed: [] });
  assert.deepEqual(readFindOutReply('ok {"reply":"En la entrada.","revealed":["2","7"]}', findOut.scenario.facts).revealed, ['2']);
  assert.equal(readFindOutReply('{"revealed":["2"]}', findOut.scenario.facts), null);
});

test('found and missed are worked out from what was revealed', () => {
  assert.deepEqual(factStatus(findOut), {
    found: ['cuándo recogen la basura'],
    missed: ['dónde está el buzón', 'la contraseña del wifi', 'quién es el portero'],
  });
  assert.match(factSheet(findOut.scenario.facts), /^- id "1" -- /);
});

test('the find-out grade is told what was found, and its notes are trimmed', () => {
  const { user } = findOutGradeRequest(settings, findOut, cards);
  assert.match(user, /They found out: cuándo recogen la basura\nThey never asked about: dónde está el buzón; /);
  assert.match(user, /LEARNER: ¿Tienes consejos\?/);
  const out = readFindOutGrade(JSON.stringify({
    conversation: 'x'.repeat(2000), asking: 'Good questions.', nextTime: '', cards: [{ number: 2, verdict: 'wrong', note: 'n' }],
  }), findOut, cards);
  assert.equal(out.conversation.length, 1500);
  assert.equal(out.nextTime, null);
  assert.deepEqual(out.found, ['cuándo recogen la basura']);
  assert.equal(out.cards[0].index, 1);
  assert.equal(readFindOutGrade('{"asking":"no main judgement"}', findOut, cards), null);
});

/* ── the turns ───────────────────────────────────────────────────────── */

test('turns are counted for the learner only, and an unanswered last turn waits for a reply', () => {
  assert.equal(learnerTurns(findOut), 2);
  assert.equal(awaitingReply(findOut), true);
  assert.equal(awaitingReply({ ...roleplay, turns: roleplay.turns.slice(0, 3) }), false);
  assert.equal(awaitingReply({ ...findOut, ended: true }), false);
  assert.equal(MAX_LEARNER_TURNS, 6);
  assert.equal(conversationTitle(findOut), 'Averigua cómo funciona el edificio.');
  assert.equal(conversationTitle(roleplay), 'Quieres devolver unos zapatos a la tienda');
});

/* ── spoken turns ────────────────────────────────────────────────────── */

import {
  transcribeRequest, readTranscript, withDelivery, deliveryAddendum, clipPath,
} from '../js/conversation.js';

const clip = (turnIndex, size = 4) => ({ turnIndex, mime: 'audio/ogg', bytes: new Uint8Array(size).fill(65) });

test('the transcriber hears the scene and the line being answered, then the recording', () => {
  const { system, parts } = transcribeRequest(settings, roleplay, clip(5));
  assert.match(system, /spoken turn from a learner of Spanish/);
  assert.match(system, /NEVER correct, tidy up/);
  assert.match(parts[0].text, /Situation: Quieres devolver unos zapatos a la tienda\nThe speaker is playing: Cliente\nThey are talking to: Dependienta\nTheir level: B1/);
  assert.match(parts[0].text, /The line they are replying to: "¿Tiene el tique\?"/);
  assert.ok(parts[0].text.endsWith('The recording:'));
  assert.deepEqual(parts[1], { inlineData: { mimeType: 'audio/ogg', data: 'QUFBQQ==' } });
});

test('a transcript keeps the learner\'s words, an empty one means nothing was heard, and none is a failure', () => {
  assert.equal(readTranscript('{"transcript":"  yo quiere   devolver "}'), 'yo quiere devolver');
  assert.equal(readTranscript('{"transcript":""}'), '');
  assert.equal(readTranscript('{"text":"x"}'), null);
  assert.equal(readTranscript('garbage'), null);
  assert.equal(readTranscript(JSON.stringify({ transcript: 'x'.repeat(3000) })).length, 1000);
});

test('a typed conversation is graded as it was: no addendum, no audio', () => {
  const out = withDelivery(settings, { system: 'SYS', user: 'USER' }, []);
  assert.deepEqual(out, { system: 'SYS', parts: [{ text: 'USER' }], attached: 0 });
});

test('recordings go oldest first, each after a line naming its position, with the delivery addendum', () => {
  const out = withDelivery(settings, { system: 'SYS', user: 'USER' }, [clip(3), clip(1)]);
  assert.equal(out.attached, 2);
  assert.deepEqual(out.parts.map((p) => p.text || 'AUDIO'), [
    'USER',
    "Recording of the learner's turn at position 1:", 'AUDIO',
    "Recording of the learner's turn at position 3:", 'AUDIO',
  ]);
  assert.ok(out.system.startsWith('SYS\n'));
  assert.match(out.system, /"deliveryNote" -- two to four short sentences on how the Spanish SOUNDED/);
});

test('recordings past the 12 MB budget are dropped from the end', () => {
  const big = { turnIndex: 1, mime: 'audio/webm', bytes: new Uint8Array(8 * 1024 * 1024) };
  const out = withDelivery(settings, { system: 'SYS', user: 'USER' }, [big, { ...big, turnIndex: 3 }]);
  assert.equal(out.attached, 1);
});

test('the delivery addendum listens by this language\'s own rules', () => {
  const withRules = withDefaults({
    targetLanguage: 'Spanish',
    shadowRules: { spanish: { generation: 1, rules: [{ id: 1, kind: 'listen', text: 'Tap the r in "pero".' }] } },
  });
  const text = deliveryAddendum(withRules);
  assert.match(text, /<rules>\nWhat to listen for:\n1\. Tap the r in "pero"\.\n<\/rules>/);
  assert.doesNotMatch(text, /Dutch|\{language\}/);
  assert.match(deliveryAddendum(withDefaults({ targetLanguage: 'Klingon' })), /No rules yet/);
});

test('the delivery note is read when there is one, and empty is none', () => {
  const base = { feedback: [], cards: [] };
  assert.equal(readRoleplayGrade(JSON.stringify({ ...base, deliveryNote: '  Your r in "pero" was an English r.  ' }), roleplay, cards, { closing: false }).deliveryNote,
    'Your r in "pero" was an English r.');
  assert.equal(readRoleplayGrade(JSON.stringify({ ...base, deliveryNote: ' ' }), roleplay, cards, { closing: false }).deliveryNote, null);
  assert.equal(readRoleplayGrade(JSON.stringify(base), roleplay, cards, { closing: false }).deliveryNote, null);
});

test('a spoken turn\'s recording is named for its conversation and its position', () => {
  assert.equal(clipPath('c_20260927_0001', 3, 'webm'), 'conversation/c_20260927_0001_3.webm');
});
