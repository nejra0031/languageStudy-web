/* Auto-save's timing: one save per delay while something is being typed,
   the last change always saved, and saves that never overlap. The timers
   are fakes, so nothing here waits. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAutosave } from '../js/autosave.js';

/* Timers that fire only when told to. */
function fakeTimers() {
  let next = 1;
  const pending = new Map();
  return {
    setTimer: (fn) => { const id = next++; pending.set(id, fn); return id; },
    clearTimer: (id) => { pending.delete(id); },
    count: () => pending.size,
    fire() {
      const fns = [...pending.values()];
      pending.clear();
      return Promise.all(fns.map((fn) => fn()));
    },
  };
}

test('typing saves once per delay, not once per keystroke', async () => {
  const t = fakeTimers();
  let saves = 0;
  const auto = createAutosave(() => { saves++; }, t);
  auto.touch();
  auto.touch();
  auto.touch();
  assert.equal(t.count(), 1, 'one timer, however many keystrokes');
  assert.equal(saves, 0, 'nothing is written before the delay is up');
  await t.fire();
  assert.equal(saves, 1);
  assert.equal(t.count(), 0);
});

test('someone who never pauses is still saved, every delay', async () => {
  const t = fakeTimers();
  let saves = 0;
  const auto = createAutosave(() => { saves++; }, t);
  for (let i = 0; i < 3; i++) {
    auto.touch();
    auto.touch();
    await t.fire();
  }
  assert.equal(saves, 3);
});

test('nothing changed, nothing saved', async () => {
  const t = fakeTimers();
  let saves = 0;
  const auto = createAutosave(() => { saves++; }, t);
  await auto.flush();
  assert.equal(saves, 0);
  auto.touch();
  await t.fire();
  await auto.flush();
  assert.equal(saves, 1, 'a flush with nothing waiting writes nothing');
});

test('a flush saves now, and the timer it replaced does not save again', async () => {
  const t = fakeTimers();
  let saves = 0;
  const auto = createAutosave(() => { saves++; }, t);
  auto.touch();
  await auto.flush();
  assert.equal(saves, 1);
  assert.equal(t.count(), 0);
  await t.fire();
  assert.equal(saves, 1);
});

test('a cancel drops what was waiting', async () => {
  const t = fakeTimers();
  let saves = 0;
  const auto = createAutosave(() => { saves++; }, t);
  auto.touch();
  auto.cancel();
  assert.equal(t.count(), 0);
  await auto.flush();
  assert.equal(saves, 0);
  auto.touch();
  await auto.flush();
  assert.equal(saves, 1, 'and it still works afterwards');
});

test('saves never overlap: one asked for during another waits for it', async () => {
  const t = fakeTimers();
  const order = [];
  let release = null;
  let n = 0;
  const auto = createAutosave(() => {
    const mine = ++n;
    order.push(`start ${mine}`);
    if (mine > 1) { order.push(`end ${mine}`); return null; }
    return new Promise((resolve) => { release = () => { order.push('end 1'); resolve(); }; });
  }, t);
  auto.touch();
  const first = auto.flush();
  await Promise.resolve();
  auto.touch();
  const second = auto.flush();
  await Promise.resolve();
  assert.deepEqual(order, ['start 1'], 'the second has not started while the first is writing');
  release();
  await first;
  await second;
  assert.deepEqual(order, ['start 1', 'end 1', 'start 2', 'end 2']);
});

test('a save that fails is forgotten, and the next change is saved', async () => {
  const t = fakeTimers();
  const error = console.error;
  console.error = () => {};
  try {
    let saves = 0;
    const auto = createAutosave(() => { saves++; if (saves === 1) throw new Error('disk full'); }, t);
    auto.touch();
    await auto.flush();
    auto.touch();
    await auto.flush();
    assert.equal(saves, 2);
  } finally {
    console.error = error;
  }
});
