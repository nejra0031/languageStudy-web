/* The model catalogue: every model entered once, with the limits that belong
   to it, and four jobs pointing into the list. The rules worth pinning down
   are the ones a settings file can break — a duplicate id, a job naming a
   model nobody has, and a file written before the catalogue existed. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  withDefaults, normalizeModels, modelLimits, rolesUsing, MODEL_ROLES, DEFAULT_SETTINGS,
} from '../js/defaults.js';
import { RateLimiter } from '../js/gemini.js';

/* ── the catalogue ───────────────────────────────────────────────────── */

test('a model is listed once, with the two rows reconciled', () => {
  const models = normalizeModels([
    { id: 'flash', rpm: 4, rpd: 20 },
    { id: 'tts', rpm: 2, rpd: 10 },
    { id: 'flash', rpm: 2, rpd: 60 },
  ], {});
  assert.deepEqual(models.map((m) => m.id), ['flash', 'tts']);
  /* The larger of two real limits, because one bucket served both. */
  assert.deepEqual(models[0], { id: 'flash', rpm: 4, rpd: 60 });
});

test('unlimited beats a number when two rows disagree', () => {
  const [flash] = normalizeModels([
    { id: 'flash', rpm: 4, rpd: 20 },
    { id: 'flash', rpm: 0, rpd: 0 },
  ], {});
  assert.deepEqual(flash, { id: 'flash', rpm: 0, rpd: 0 });
});

test('rows are cleaned up, and one with no id is not a model', () => {
  const models = normalizeModels([
    { id: '  spaced  ', rpm: '4', rpd: 20.4 },
    { id: '', rpm: 9, rpd: 9 },
    { id: 'negative', rpm: -3, rpd: Number.NaN },
  ], {});
  assert.deepEqual(models, [
    { id: 'spaced', rpm: 4, rpd: 20 },
    { id: 'negative', rpm: 0, rpd: 0 },
  ]);
});

test('a job always names a model in the list', () => {
  const models = normalizeModels([{ id: 'flash', rpm: 4, rpd: 20 }], {
    textModel: 'flash', ttsModel: 'tts-only', shadowModel: 'flash',
  });
  assert.deepEqual(models.map((m) => m.id), ['flash', 'tts-only']);
  /* Added rather than reassigned, and unlimited: nothing here knows what a
     model it has never been told about is allowed to spend. */
  assert.deepEqual(models[1], { id: 'tts-only', rpm: 0, rpd: 0 });
});

test('an empty catalogue falls back to the defaults rather than to nothing', () => {
  assert.deepEqual(normalizeModels([], {}), DEFAULT_SETTINGS.models);
  assert.deepEqual(normalizeModels(null, {}), DEFAULT_SETTINGS.models);
});

/* ── limits and jobs ─────────────────────────────────────────────────── */

test('the limits come from the model, whatever job is asking', () => {
  const s = withDefaults({
    models: [{ id: 'flash', rpm: 4, rpd: 20 }, { id: 'tts', rpm: 2, rpd: 10 }],
    textModel: 'flash', ttsModel: 'tts', shadowModel: 'flash',
  });
  assert.deepEqual(modelLimits(s, s.textModel), { rpm: 4, rpd: 20 });
  assert.deepEqual(modelLimits(s, s.shadowModel), { rpm: 4, rpd: 20 });
  /* A model the catalogue does not know is unlimited here: the local count is
     a courtesy, never the authority on what Google allows. */
  assert.deepEqual(modelLimits(s, 'never-heard-of-it'), { rpm: 0, rpd: 0 });
});

test('rolesUsing names every job a model is doing', () => {
  const s = withDefaults({
    models: [{ id: 'flash', rpm: 4, rpd: 20 }, { id: 'tts', rpm: 2, rpd: 10 }],
    textModel: 'flash', ttsModel: 'tts', shadowModel: 'flash',
  });
  /* Notes is on flash too: a file that never named a notes model gives the
     job its text model. */
  assert.deepEqual(rolesUsing(s, 'flash'), ['Text', 'Shadowing', 'Notes']);
  assert.deepEqual(rolesUsing(s, 'tts'), ['Speech']);
  assert.deepEqual(rolesUsing(s, 'idle'), []);
});

test('a settings file from before the notes job gives it the text model', () => {
  const s = withDefaults({
    models: [{ id: 'my-flash', rpm: 4, rpd: 20 }, { id: 'tts', rpm: 2, rpd: 10 }],
    textModel: 'my-flash', ttsModel: 'tts', shadowModel: 'my-flash',
  });
  assert.equal(s.notesModel, 'my-flash');
  /* Nothing is added to the catalogue behind the user's back: the default
     notes model is not one this user has. */
  assert.deepEqual(s.models.map((m) => m.id), ['my-flash', 'tts']);
});

test('a notes model that was chosen is kept', () => {
  const s = withDefaults({
    models: [{ id: 'flash', rpm: 4, rpd: 20 }, { id: 'lite', rpm: 0, rpd: 0 }],
    textModel: 'flash', notesModel: 'lite',
  });
  assert.equal(s.notesModel, 'lite');
  assert.deepEqual(rolesUsing(s, 'lite'), ['Notes']);
});

/* ── the migration ───────────────────────────────────────────────────── */

test('a settings file with per-job limits becomes a catalogue', () => {
  const s = withDefaults({
    textModel: 'flash', ttsModel: 'tts', shadowModel: 'flash',
    limits: { textRpm: 4, textRpd: 20, ttsRpm: 2, ttsRpd: 10, shadowRpm: 2, shadowRpd: 10 },
  });
  /* Two models, not three jobs: the one doing text and shadowing is entered
     once, and keeps the larger of the two allowances it used to be given. */
  assert.deepEqual(s.models, [
    { id: 'flash', rpm: 4, rpd: 20 },
    { id: 'tts', rpm: 2, rpd: 10 },
  ]);
  assert.equal(s.limits, undefined, 'the old key is read once and not written back');
});

test('the defaults migrate to the two models they always were', () => {
  assert.deepEqual(withDefaults(null).models, [
    { id: 'gemini-3.6-flash', rpm: 4, rpd: 20 },
    { id: 'gemini-3.1-flash-tts-preview', rpm: 2, rpd: 10 },
  ]);
  assert.deepEqual(withDefaults({}).models, withDefaults(null).models);
});

test('a job left blank falls back to its default model', () => {
  const s = withDefaults({ textModel: '   ', ttsModel: null });
  assert.equal(s.textModel, DEFAULT_SETTINGS.textModel);
  assert.equal(s.ttsModel, DEFAULT_SETTINGS.ttsModel);
  for (const [key] of MODEL_ROLES) {
    assert.ok(s.models.some((m) => m.id === s[key]), `${key} names a listed model`);
  }
});

/* ── what the budget then says ───────────────────────────────────────── */

test('one model doing two jobs runs one counter down', async () => {
  const lim = new RateLimiter({ now: () => 1_000_000 });
  const s = withDefaults({
    models: [{ id: 'flash', rpm: 0, rpd: 10 }, { id: 'tts', rpm: 0, rpd: 10 }],
    textModel: 'flash', ttsModel: 'tts', shadowModel: 'flash',
  });
  await lim.reserve('flash', 0, 10);
  const q = lim.report(s);
  assert.equal(q.text.usedDay, 1);
  assert.equal(q.shadow.usedDay, 1, 'the shadowing job sees the text job’s call');
  assert.equal(q.tts.usedDay, 0, 'the speech model is a bucket of its own');
});

test('a card costs two calls when one model writes and speaks', async () => {
  const lim = new RateLimiter({ now: () => 1_000_000 });
  const one = withDefaults({
    models: [{ id: 'flash', rpm: 0, rpd: 9 }],
    textModel: 'flash', ttsModel: 'flash', shadowModel: 'flash',
  });
  assert.equal(lim.report(one).cardsLeftToday, 4, 'nine calls buy four cards, not nine');
  const two = withDefaults({
    models: [{ id: 'flash', rpm: 0, rpd: 9 }, { id: 'tts', rpm: 0, rpd: 9 }],
    textModel: 'flash', ttsModel: 'tts', shadowModel: 'flash',
  });
  assert.equal(lim.report(two).cardsLeftToday, 9);
});
