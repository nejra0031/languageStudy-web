import { test } from 'node:test';
import assert from 'node:assert/strict';
import { packetSamples, oggCrc, oggOpus, encodeOggOpus, canEncodeOpus } from '../js/opus.js';
import { speechFile, pcmToWav, wavSamples } from '../js/gemini.js';

/* Reads an Ogg file back into its pages, checking each page's CRC. */
function pages(bytes) {
  const out = [];
  let at = 0;
  while (at < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + at);
    assert.equal(String.fromCharCode(...bytes.subarray(at, at + 4)), 'OggS');
    const count = bytes[at + 26];
    const lacing = [...bytes.subarray(at + 27, at + 27 + count)];
    const length = 27 + count + lacing.reduce((a, b) => a + b, 0);
    const copy = bytes.slice(at, at + length);
    copy.fill(0, 22, 26);
    assert.equal(view.getUint32(22, true), oggCrc(copy), `CRC of page ${out.length}`);
    out.push({
      flags: bytes[at + 5],
      granule: Number(view.getBigUint64(6, true)),
      serial: view.getUint32(14, true),
      sequence: view.getUint32(18, true),
      body: bytes.subarray(at + 27 + count, at + length),
      packets: lacing.filter((n) => n < 255).length,
    });
    at += length;
  }
  return out;
}

/* A fake 20 ms CELT packet: config 31, one frame. */
const PACKET = new Uint8Array([31 << 3, 1, 2, 3]);

test('packetSamples reads the frame length and count from the TOC byte', () => {
  assert.equal(packetSamples(PACKET), 960);                        // 20 ms CELT
  assert.equal(packetSamples(new Uint8Array([(1 << 3) | 0])), 960); // 20 ms SILK
  assert.equal(packetSamples(new Uint8Array([(3 << 3) | 0])), 2880); // 60 ms SILK
  assert.equal(packetSamples(new Uint8Array([(16 << 3) | 0])), 120); // 2.5 ms CELT
  assert.equal(packetSamples(new Uint8Array([(31 << 3) | 1])), 1920); // two frames
  assert.equal(packetSamples(new Uint8Array([(31 << 3) | 3, 3])), 2880); // code 3, three
  assert.equal(packetSamples(new Uint8Array()), 0);
});

test('oggCrc is the unreflected CRC Ogg uses, not zip\'s', () => {
  assert.equal(oggCrc(new TextEncoder().encode('123456789')), 0x89a1897f);
});

test('oggOpus writes the two header pages, then audio ending on EOS', () => {
  const packets = Array.from({ length: 120 }, () => PACKET);
  const got = pages(oggOpus(packets, { preSkip: 312, inputRate: 24000, serial: 7 }));
  assert.equal(got.length, 2 + 3);                                  // 50 + 50 + 20
  assert.deepEqual(got.map((p) => p.sequence), [0, 1, 2, 3, 4]);
  assert.ok(got.every((p) => p.serial === 7));
  assert.equal(got[0].flags, 0x02, 'first page begins the stream');
  assert.equal(got.at(-1).flags, 0x04, 'last page ends it');
  assert.equal(String.fromCharCode(...got[0].body.subarray(0, 8)), 'OpusHead');
  assert.equal(got[0].body[9], 1, 'mono');
  assert.equal(got[0].body[10] | (got[0].body[11] << 8), 312);
  assert.equal(String.fromCharCode(...got[1].body.subarray(0, 8)), 'OpusTags');
  assert.deepEqual(got.slice(2).map((p) => p.packets), [50, 50, 20]);
  assert.deepEqual(got.slice(2).map((p) => p.granule), [312 + 48000, 312 + 96000, 312 + 115200]);
});

test('the last position trims the encoder\'s padding to the real length', () => {
  const got = pages(oggOpus([PACKET, PACKET, PACKET], { preSkip: 312, samples: 2500, serial: 1 }));
  assert.equal(got.at(-1).granule, 312 + 2500);
});

test('a packet longer than 255 bytes is laced across segments', () => {
  const big = new Uint8Array(600);
  big[0] = 31 << 3;
  const got = pages(oggOpus([big, PACKET], { serial: 1 }));
  assert.equal(got[2].packets, 2);
  assert.equal(got[2].body.length, 604);
});

test('without an encoder the sentence is still saved, as WAV', async () => {
  assert.equal(canEncodeOpus(), false, 'node has no WebCodecs');
  assert.equal(await encodeOggOpus(new Uint8Array(480), 24000), null);
  const pcm = new Uint8Array(480);
  const file = await speechFile(pcm, 'audio/L16;rate=24000');
  assert.equal(file.ext, 'wav');
  assert.equal(file.type, 'audio/wav');
  assert.deepEqual(file.bytes, pcmToWav(pcm, 'audio/L16;rate=24000'));
});

test('audio that arrives in a container keeps its own kind', async () => {
  const ogg = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 0]);
  assert.equal((await speechFile(ogg, 'audio/ogg')).ext, 'ogg');
  const riff = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0]);
  assert.equal((await speechFile(riff, '')).ext, 'wav');
});

test('wavSamples finds the samples in a WAV like the one Gemini sends', () => {
  const pcm = new Uint8Array([1, 2, 3, 4, 5, 6]);
  const got = wavSamples(pcmToWav(pcm, 'audio/L16;rate=24000'));
  assert.equal(got.rate, 24000);
  assert.deepEqual([...got.pcm], [...pcm]);
});

test('wavSamples walks past other chunks, and reads a streaming size to the end', () => {
  const wav = pcmToWav(new Uint8Array([9, 8, 7, 6]), 'audio/L16;rate=16000');
  const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 3, 0, 0, 0, 1, 2, 3, 0]); // LIST, odd size, padded
  const withList = new Uint8Array([...wav.slice(0, 36), ...list, ...wav.slice(36)]);
  let got = wavSamples(withList);
  assert.equal(got.rate, 16000);
  assert.deepEqual([...got.pcm], [9, 8, 7, 6]);

  const streaming = wav.slice();
  new DataView(streaming.buffer).setUint32(40, 0xffffffff, true);
  assert.deepEqual([...wavSamples(streaming).pcm], [9, 8, 7, 6]);
});

test('wavSamples leaves alone what the encoder should not be given', () => {
  const stereo = pcmToWav(new Uint8Array(8), 'audio/L16;rate=24000');
  new DataView(stereo.buffer).setUint16(22, 2, true);
  assert.equal(wavSamples(stereo), null);
  const float = pcmToWav(new Uint8Array(8), '');
  new DataView(float.buffer).setUint16(20, 3, true);
  assert.equal(wavSamples(float), null);
  assert.equal(wavSamples(new Uint8Array([0x4f, 0x67, 0x67, 0x53])), null);
});
