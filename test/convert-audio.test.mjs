import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertBank, isWavEntry } from '../js/convert-audio.js';
import { pcmToWav } from '../js/gemini.js';

const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 1, 2]);

/* A fake audio/ folder, with a log of what was done to it in order. */
function folder(files) {
  const disk = new Map(Object.entries(files));
  const log = [];
  let savedManifest = null;
  return {
    disk, log,
    saved: () => savedManifest,
    io: (manifest, over = {}) => ({
      read: async (p) => disk.get(p) || null,
      write: async (p, bytes) => { disk.set(p, bytes); log.push(`write ${p}`); return true; },
      remove: async (p) => { disk.delete(p); log.push(`remove ${p}`); },
      list: async () => [...disk.keys()].map((p) => p.replace(/^audio\//, '')),
      save: async () => { savedManifest = manifest.map((e) => e.file); log.push('save'); },
      encode: async () => OGG,
      ...over,
    }),
  };
}

const wav = () => pcmToWav(new Uint8Array(4800), 'audio/L16;rate=24000');
const entry = (id, ext = 'wav') => ({ id, file: `audio/${id}.${ext}`, sentence: id });

test('isWavEntry picks out the sentences still saved as WAV', () => {
  assert.equal(isWavEntry(entry('a')), true);
  assert.equal(isWavEntry(entry('a', 'ogg')), false);
  assert.equal(isWavEntry({}), false);
});

test('each WAV becomes an Ogg, and the WAV goes only after the manifest stops pointing at it', async () => {
  const manifest = [entry('a'), entry('b', 'ogg'), entry('c')];
  const f = folder({ 'audio/a.wav': wav(), 'audio/b.ogg': OGG, 'audio/c.wav': wav() });
  const progress = [];
  const r = await convertBank(manifest, f.io(manifest), { onProgress: (i, n) => progress.push(`${i}/${n}`) });

  assert.deepEqual(manifest.map((e) => e.file), ['audio/a.ogg', 'audio/b.ogg', 'audio/c.ogg']);
  assert.deepEqual(f.saved(), ['audio/a.ogg', 'audio/b.ogg', 'audio/c.ogg']);
  assert.deepEqual([...f.disk.keys()].sort(), ['audio/a.ogg', 'audio/b.ogg', 'audio/c.ogg']);
  assert.deepEqual(f.log, ['write audio/a.ogg', 'write audio/c.ogg', 'save', 'remove audio/a.wav', 'remove audio/c.wav']);
  assert.deepEqual(progress, ['1/2', '2/2']);
  assert.equal(r.converted, 2);
  assert.equal(r.before, 2 * wav().length);
  assert.equal(r.after, 2 * OGG.length);
});

test('a big bank is saved in batches, each batch\'s WAVs removed after its own save', async () => {
  const manifest = ['a', 'b', 'c', 'd', 'e'].map((id) => entry(id));
  const f = folder(Object.fromEntries(manifest.map((e) => [e.file, wav()])));
  await convertBank(manifest, f.io(manifest), { batch: 2 });
  const saves = f.log.map((l, i) => (l === 'save' ? i : -1)).filter((i) => i >= 0);
  assert.equal(saves.length, 3);
  for (const id of ['a', 'b']) assert.ok(f.log.indexOf(`remove audio/${id}.wav`) > saves[0]);
  for (const id of ['c', 'd']) assert.ok(f.log.indexOf(`remove audio/${id}.wav`) > saves[1]);
});

test('what cannot be converted is left as it was, and still plays', async () => {
  const stereo = wav();
  new DataView(stereo.buffer).setUint16(22, 2, true);
  const manifest = [entry('missing'), entry('stereo'), entry('refused'), entry('good')];
  const f = folder({ 'audio/stereo.wav': stereo, 'audio/refused.wav': wav(), 'audio/good.wav': wav() });
  let calls = 0;
  const r = await convertBank(manifest, f.io(manifest, { encode: async () => (++calls === 1 ? null : OGG) }));
  assert.deepEqual(manifest.map((e) => e.file), ['audio/missing.wav', 'audio/stereo.wav', 'audio/refused.wav', 'audio/good.ogg']);
  assert.ok(f.disk.has('audio/stereo.wav') && f.disk.has('audio/refused.wav'));
  assert.deepEqual({ missing: r.missing, unusual: r.unusual, failed: r.failed, converted: r.converted }, { missing: 1, unusual: 1, failed: 1, converted: 1 });
});

test('a write that does not land leaves the entry on its WAV', async () => {
  const manifest = [entry('a')];
  const f = folder({ 'audio/a.wav': wav() });
  const r = await convertBank(manifest, f.io(manifest, { write: async () => false }));
  assert.equal(manifest[0].file, 'audio/a.wav');
  assert.ok(f.disk.has('audio/a.wav'));
  assert.equal(r.failed, 1);
});

test('if something throws partway, what was switched is saved and its WAV removed', async () => {
  const manifest = [entry('a'), entry('b')];
  const f = folder({ 'audio/a.wav': wav(), 'audio/b.wav': wav() });
  let calls = 0;
  const io = f.io(manifest, { encode: async () => { if (++calls === 2) throw new Error('boom'); return OGG; } });
  await assert.rejects(convertBank(manifest, io), /boom/);
  assert.deepEqual(f.saved(), ['audio/a.ogg', 'audio/b.wav']);
  assert.ok(!f.disk.has('audio/a.wav'));
  assert.ok(f.disk.has('audio/b.wav'));
});

test('a WAV left behind by an interrupted run is swept, but only when its Ogg is in the bank', async () => {
  const manifest = [entry('a', 'ogg')];
  const f = folder({ 'audio/a.ogg': OGG, 'audio/a.wav': wav(), 'audio/stray.wav': wav() });
  await convertBank(manifest, f.io(manifest));
  assert.ok(!f.disk.has('audio/a.wav'));
  assert.ok(f.disk.has('audio/stray.wav'), 'a WAV the bank does not know is not ours to judge');
});
