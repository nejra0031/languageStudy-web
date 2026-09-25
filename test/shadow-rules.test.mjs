import test from 'node:test';
import assert from 'node:assert/strict';

import {
  languageKey, rulesFor, withRules, cleanRules, cleanEntry, cleanRulesMap,
  seedFromSounds, formatRulesBlock, buildSeedPrompt, buildRevisionPrompt,
  readRules, seedEntry, applyRevision, undoRevision, editRules, rulesToText,
  countRatings, ratingsFor, shouldRevise, collectRated, ruleStats, migrateSounds,
  newEntry, MAX_LISTEN, MAX_STYLE, DEFAULT_STYLE_RULES,
} from '../js/shadow-rules.js';
import {
  withDefaults, upgradePrompts, DEFAULT_SHADOW_PROMPT, RETIRED_SHADOW_PROMPTS,
} from '../js/defaults.js';
import { shadowSystem, feedbackRequestText } from '../js/gemini.js';

const NOW = new Date('2026-09-24T12:00:00Z');

function entryOf(rules, generation = 1) {
  return { ...newEntry(rules, '', NOW), generation };
}

const BASE = [
  { id: 1, kind: 'listen', text: 'Listen for the rising tone.', origin: 'seed' },
  { id: 2, kind: 'listen', text: 'Listen for final stops.', origin: 'seed' },
  { id: 3, kind: 'style', text: 'Lead with the fix.', origin: 'seed' },
];

/* ── where the rules live ────────────────────────────────────────────── */

test('rules are kept per language, folded for case and space only', () => {
  assert.equal(languageKey('  French '), 'french');
  const settings = { shadowRules: withRules({}, 'French', entryOf(BASE)) };
  assert.ok(rulesFor(settings, 'french'));
  assert.ok(rulesFor(settings, 'FRENCH '));
  assert.equal(rulesFor(settings, 'Français'), null);
  assert.equal(rulesFor({}, 'French'), null);
});

/* ── cleaning ────────────────────────────────────────────────────────── */

test('rules are deduplicated, capped per kind and given unique ids', () => {
  const many = [
    ...Array.from({ length: MAX_LISTEN + 3 }, (_, i) => ({ kind: 'listen', text: `listen ${i}` })),
    ...Array.from({ length: MAX_STYLE + 3 }, (_, i) => ({ kind: 'style', text: `style ${i}` })),
    { kind: 'listen', text: 'LISTEN 0' },
  ];
  const out = cleanRules(many);
  assert.equal(out.filter((r) => r.kind === 'listen').length, MAX_LISTEN);
  assert.equal(out.filter((r) => r.kind === 'style').length, MAX_STYLE);
  assert.equal(new Set(out.map((r) => r.id)).size, out.length);
});

test('a duplicated id goes to the first rule, and the second gets a fresh one', () => {
  const out = cleanRules([
    { id: 4, text: 'a' }, { id: 4, text: 'b' }, { text: '' }, null, { id: -2, text: 'c' },
  ]);
  assert.deepEqual(out.map((r) => [r.id, r.text]), [[4, 'a'], [5, 'b'], [6, 'c']]);
  assert.equal(out[0].kind, 'listen', 'an unknown kind is a listening rule');
});

test('an unreadable stored entry is dropped rather than half kept', () => {
  assert.equal(cleanEntry(null), null);
  assert.equal(cleanEntry({ rules: [] }), null);
  const map = cleanRulesMap({ French: { generation: 'x', rules: BASE, history: 'nope' }, bad: 3 });
  assert.deepEqual(Object.keys(map), ['french']);
  assert.equal(map.french.generation, 1);
  assert.deepEqual(map.french.history, []);
});

/* ── seeding ─────────────────────────────────────────────────────────── */

test('the old sounds setting splits on top-level commas and keeps list tails together', () => {
  const rules = seedFromSounds('the six tones (ngang, huyền, sắc, hỏi, ngã, nặng), the unreleased final consonants -c, -ch, -t, -p, -n, -ng, and the vowels ư, ơ and â');
  const listen = rules.filter((r) => r.kind === 'listen').map((r) => r.text);
  assert.equal(listen.length, 3);
  assert.match(listen[0], /six tones \(ngang, huyền, sắc, hỏi, ngã, nặng\)/);
  assert.match(listen[1], /-c, -ch, -t, -p, -n, -ng/);
  assert.match(listen[2], /the vowels ư, ơ and â/);
  assert.equal(rules.filter((r) => r.kind === 'style').length, DEFAULT_STYLE_RULES.length);
  assert.deepEqual(seedFromSounds('   '), []);
});

test('the default sounds migrate only for the language they were written for', () => {
  const defaults = { sounds: 'the tones', language: 'Vietnamese' };
  assert.ok(migrateSounds('Vietnamese', 'the tones', defaults).vietnamese);
  assert.deepEqual(migrateSounds('French', 'the tones', defaults), {});
  /* Sounds you typed yourself are yours, whatever the language. */
  assert.ok(migrateSounds('French', 'nasal vowels, liaison', defaults).french);
  assert.deepEqual(migrateSounds('French', '', defaults), {});
});

test('the seed prompt names the language and asks for audible rules only', () => {
  const p = buildSeedPrompt({ language: 'Korean', level: 'beginner', languageNote: 'Seoul speech.' });
  assert.match(p, /Korean pronunciation coach/);
  assert.match(p, /beginner learner/);
  assert.match(p, /Seoul speech\./);
  assert.match(p, /Nothing about grammar/);
  assert.doesNotMatch(p, /\{\w+\}/, 'every placeholder is filled');
});

test('a drafted seed without style rules is given the default ones', () => {
  const reply = readRules('{"rules":[{"kind":"listen","text":"Aspirated stops."}]}');
  const entry = seedEntry(reply, NOW);
  assert.equal(entry.generation, 1);
  assert.equal(entry.rules.filter((r) => r.kind === 'style').length, DEFAULT_STYLE_RULES.length);
  assert.ok(entry.rules.every((r) => r.origin === 'seed'));
});

/* ── the prompt block ────────────────────────────────────────────────── */

test('the rules block numbers rules by id, listening first', () => {
  const block = formatRulesBlock([BASE[2], BASE[0], BASE[1]]);
  const lines = block.split('\n');
  assert.equal(lines[0], 'What to listen for:');
  assert.equal(lines[1], '1. Listen for the rising tone.');
  assert.ok(lines.includes('How to write each comment:'));
  assert.ok(lines.includes('3. Lead with the fix.'));
  assert.match(formatRulesBlock([]), /No rules yet/);
});

/* ── reading replies ─────────────────────────────────────────────────── */

test('a malformed or listen-less reply changes nothing', () => {
  assert.equal(readRules('not json'), null);
  assert.equal(readRules('{"rules":"no"}'), null);
  assert.equal(readRules('{"rules":[{"kind":"listen","text":"cut'), null);
  assert.equal(readRules('{"rules":[{"kind":"style","text":"Be firm."}]}'), null);
  const ok = readRules('Here you go: {"rules":[{"id":1,"kind":"listen","text":"x"}],"changes":[{"kind":"edit","id":1,"why":"sharper"},{"kind":"bogus"}],"reason":"r"}');
  assert.equal(ok.rules.length, 1);
  assert.deepEqual(ok.changes, [{ kind: 'edit', id: 1, why: 'sharper' }]);
});

/* ── ratings and when to revise ──────────────────────────────────────── */

const rows = [
  { language: 'French', rulesGeneration: 1, ratings: { useful: 5, vague: 1, soft: 0, wrong: 0 } },
  { language: 'french', rulesGeneration: 1, ratings: { useful: 4, vague: 0, soft: 2, wrong: 0 } },
  { language: 'French', rulesGeneration: 0, ratings: { useful: 0, vague: 9, soft: 0, wrong: 0 } },
  { language: 'German', rulesGeneration: 1, ratings: { useful: 0, vague: 9, soft: 0, wrong: 0 } },
];

test('ratings are summed for one language and one version only', () => {
  assert.deepEqual(ratingsFor(rows, 'French', 1), { useful: 9, vague: 1, soft: 2, wrong: 0 });
  assert.deepEqual(countRatings([{ rating: 'soft' }, { rating: 'nope' }, {}]), { useful: 0, vague: 0, soft: 1, wrong: 0 });
});

test('a revision waits for the threshold and for a reason', () => {
  const entry = entryOf(BASE, 1);
  assert.equal(shouldRevise(entry, rows, 'French', 12), true);
  assert.equal(shouldRevise(entry, rows, 'French', 13), false, 'not enough ratings yet');
  const happy = [{ language: 'French', rulesGeneration: 1, ratings: { useful: 20, vague: 0, soft: 0, wrong: 0 } }];
  assert.equal(shouldRevise(entry, happy, 'French', 12), false, 'all useful means the rules work');
  assert.equal(shouldRevise({ ...entry, generation: 2 }, rows, 'French', 1), false, 'a new version starts the count again');
  assert.equal(shouldRevise(null, rows, 'French', 1), false);
});

const sessions = [{
  language: 'French',
  items: [{ index: 0, text: 'Bonjour' }, { index: 1, text: 'Merci' }],
  feedback: {
    rulesGeneration: 1,
    notes: [
      { itemIndex: 0, comment: 'Good.', rating: 'soft', why: 'the r was off', rules: [1] },
      { itemIndex: 1, comment: 'The u in merci…', rating: 'useful', rules: [1, 2] },
    ],
  },
}, {
  language: 'French',
  items: [{ index: 0, text: 'Old' }],
  feedback: { rulesGeneration: 0, notes: [{ itemIndex: 0, comment: 'x', rating: 'wrong' }] },
}];

test('rated notes are collected with their line and pinned on the rules they cited', () => {
  const rated = collectRated(sessions, 'French', 1);
  assert.equal(rated.length, 2);
  assert.equal(rated[0].line, 'Bonjour');
  assert.equal(rated[0].why, 'the r was off');
  const stats = ruleStats(rated);
  assert.deepEqual(stats.get(1), { useful: 1, vague: 0, soft: 1, wrong: 0 });
  assert.deepEqual(stats.get(2), { useful: 1, vague: 0, soft: 0, wrong: 0 });
});

test('the revision prompt carries the ratings, your words and the version before', () => {
  const entry = entryOf([...BASE, { id: 7, kind: 'listen', text: 'My own rule.', origin: 'you' }], 2);
  const p = buildRevisionPrompt({
    language: 'French', level: 'beginner', entry,
    rated: collectRated(sessions, 'French', 1),
    current: { useful: 1, vague: 0, soft: 1, wrong: 0 },
    previous: { generation: 1, rules: BASE, counts: { useful: 3, vague: 0, soft: 0, wrong: 0 } },
  });
  assert.match(p, /version 2/);
  assert.match(p, /Line: "Bonjour"/);
  assert.match(p, /The learner added: "the r was off"/);
  assert.match(p, /1\. \[listen\] Listen for the rising tone\. -- 1 useful, 1 soft/);
  assert.match(p, /7\. \[listen\] \(yours\) My own rule\./);
  assert.match(p, /version 1\) had 3 of 3 notes rated useful; this version has 1 of 2/);
  assert.doesNotMatch(p, /\{(language|level|rules|rated|previous|generation|languageNote)\}/);
});

/* ── applying, undoing, editing ──────────────────────────────────────── */

test('a revision keeps your rules verbatim and bumps the version', () => {
  const mine = { id: 7, kind: 'listen', text: 'My own rule.', origin: 'you' };
  const entry = entryOf([...BASE, mine], 3);
  const reply = readRules(JSON.stringify({
    rules: [
      { id: 1, kind: 'listen', text: 'Listen for the rising tone.' },         // kept as is
      { id: 2, kind: 'listen', text: 'Final stops are unreleased: flag a puff of air.' }, // edited
      { id: 7, kind: 'listen', text: 'The model rewrote your rule.' },       // not allowed
      { id: 99, kind: 'style', text: 'Correction first, always.' },         // new
    ],
    changes: [{ kind: 'edit', id: 2, why: 'notes were vague' }],
    reason: 'Sharper stops.',
  }));
  const next = applyRevision(entry, reply, NOW);
  assert.equal(next.generation, 4);
  assert.equal(next.reason, 'Sharper stops.');
  assert.equal(next.history.at(-1).generation, 3);
  const byId = new Map(next.rules.map((r) => [r.id, r]));
  assert.deepEqual(byId.get(7), mine, 'your rule is back as you wrote it');
  assert.equal(byId.get(1).origin, 'seed', 'untouched rules keep their origin');
  assert.equal(byId.get(2).origin, 'model');
  assert.equal(byId.has(99), false, 'an id the rules never had is a new rule, not a claim on one');
  assert.ok(next.rules.some((r) => r.text === 'Correction first, always.'));
  assert.equal(next.rules.filter((r) => r.text.includes('rewrote')).length, 0);
});

test('history is capped, and undo walks back while the version only goes up', () => {
  let entry = entryOf(BASE, 1);
  for (let i = 0; i < 8; i++) {
    entry = applyRevision(entry, { rules: [{ id: 1, kind: 'listen', text: `v${i}` }], changes: [], reason: '' }, NOW);
  }
  assert.equal(entry.generation, 9);
  assert.equal(entry.history.length, 5);
  const back = undoRevision(entry, NOW);
  assert.equal(back.generation, 10);
  assert.equal(back.rules[0].text, 'v6');
  assert.equal(back.history.length, 4);
  assert.equal(undoRevision(entryOf(BASE), NOW), null, 'nothing to undo');
});

test('editing by hand: unchanged lines keep their number, changed ones become yours', () => {
  const entry = entryOf(BASE, 2);
  const text = rulesToText(entry.rules);
  assert.equal(editRules(entry, text, NOW), null, 'saving an untouched box is not a new version');

  const edited = text.replace('Listen for final stops.', 'Final stops, unreleased.') + '\nstyle: Be blunt.';
  const next = editRules(entry, edited, NOW);
  assert.equal(next.generation, 3);
  const byText = new Map(next.rules.map((r) => [r.text, r]));
  assert.equal(byText.get('Listen for the rising tone.').id, 1);
  assert.equal(byText.get('Listen for the rising tone.').origin, 'seed');
  assert.equal(byText.get('Final stops, unreleased.').origin, 'you');
  assert.equal(byText.get('Be blunt.').kind, 'style');
  assert.equal(new Set(next.rules.map((r) => r.id)).size, next.rules.length);

  const fresh = editRules(null, 'Nasal vowels.', NOW);
  assert.equal(fresh.generation, 1);
  assert.equal(fresh.rules[0].origin, 'you');
});

/* ── the settings migration and the filled prompt ────────────────────── */

test('a fresh install starts the default language with rules, and no other', () => {
  const fresh = withDefaults(null);
  assert.ok(rulesFor(fresh, fresh.targetLanguage));
  assert.equal('shadowSounds' in fresh, false, 'the old key is not written back');
  assert.deepEqual(withDefaults({ targetLanguage: 'French' }).shadowRules, {});
});

test('an old settings file carries its sounds over once, and then never again', () => {
  const old = withDefaults({ targetLanguage: 'French', shadowSounds: 'nasal vowels, liaison' });
  assert.equal(rulesFor(old, 'French').rules.filter((r) => r.kind === 'listen').length, 2);
  /* Saved and loaded again: the rules are the record now. Clearing them
     must not bring the sounds back. */
  const cleared = withDefaults({ ...old, shadowRules: {}, shadowSounds: 'nasal vowels' });
  assert.deepEqual(cleared.shadowRules, {});
});

test('the shadowing prompt is sent with the rules numbered and no placeholder left', () => {
  const s = withDefaults({ targetLanguage: 'French', shadowSounds: 'nasal vowels' });
  const system = shadowSystem(s, 10);
  assert.match(system, /1\. Listen for nasal vowels/);
  assert.match(system, /"rules":\[/);
  assert.doesNotMatch(system, /\{(rules|sounds|language|count)\}/);
  assert.match(DEFAULT_SHADOW_PROMPT, /at least one concrete thing to change/);
  /* A prompt customised before rules existed still fills cleanly. */
  const legacy = shadowSystem({ ...s, prompts: { shadowing: 'Listen.{sounds} {rules}' } }, 3);
  assert.doesNotMatch(legacy, /\{sounds\}/);
  assert.match(shadowSystem(withDefaults({ targetLanguage: 'Thai' }), 1), /No rules yet/);
});

test('an install still holding an old default prompt is moved to the current one', () => {
  for (const old of RETIRED_SHADOW_PROMPTS) {
    assert.notEqual(old.trim(), DEFAULT_SHADOW_PROMPT.trim(), 'a retired prompt is never the current one');
    assert.doesNotMatch(old, /\{feedback\}/, 'every retired prompt predates the feedback request');
    /* A textarea round trip turns line endings into CRLF on some systems. */
    const loaded = withDefaults({ prompts: { shadowing: old.replace(/\n/g, '\r\n') + '\n' } });
    assert.equal(loaded.prompts.shadowing, DEFAULT_SHADOW_PROMPT);
  }
  assert.equal(upgradePrompts({ shadowing: DEFAULT_SHADOW_PROMPT }).shadowing, DEFAULT_SHADOW_PROMPT);
});

test('a prompt you edited is left exactly as you wrote it', () => {
  const edited = `${RETIRED_SHADOW_PROMPTS[0]}\n- Be brief.`;
  assert.equal(withDefaults({ prompts: { shadowing: edited } }).prompts.shadowing, edited);
  assert.equal(withDefaults({ prompts: { shadowing: 'Mine.' } }).prompts.shadowing, 'Mine.');
});

/* ── the feedback request ─────────────────────────────────────────── */

test('the feedback request is sent as typed, English when empty, and even with a custom prompt', () => {
  assert.equal(feedbackRequestText('  English, avoid technical terms '), 'English, avoid technical terms');
  assert.equal(feedbackRequestText(''), 'English.');

  const s = withDefaults({ targetLanguage: 'Vietnamese', feedbackRequest: 'English and Vietnamese' });
  const system = shadowSystem(s, 3);
  assert.match(system, /<feedback_request>\nEnglish and Vietnamese\n<\/feedback_request>/);
  assert.equal(system.match(/<feedback_request>/g).length, 1);
  assert.doesNotMatch(system, /\{feedback\}/);

  const custom = shadowSystem({ ...s, prompts: { ...s.prompts, shadowing: 'Listen. {rules}' } }, 3);
  assert.match(custom, /^Listen\./);
  assert.match(custom, /<feedback_request>\nEnglish and Vietnamese\n<\/feedback_request>/, 'appended to a prompt without {feedback}');
});
