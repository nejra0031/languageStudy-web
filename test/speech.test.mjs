import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageCode, clampRate, rateLabel } from '../js/speech.js';

test('language names and codes both give a code', () => {
  assert.equal(languageCode('Vietnamese'), 'vi');
  assert.equal(languageCode('  spanish '), 'es');
  assert.equal(languageCode('pt-BR'), 'pt-BR');
  assert.equal(languageCode('vi'), 'vi');
  assert.equal(languageCode('Old English'), '');
  assert.equal(languageCode(''), '');
});

test('speaking speed is kept in range, on its step, and labelled plainly', () => {
  assert.equal(clampRate(0.8), 0.8);
  assert.equal(clampRate(0.1), 0.5);
  assert.equal(clampRate(9), 1.5);
  assert.equal(clampRate('0.83'), 0.85);
  assert.equal(clampRate(undefined), 1);
  assert.equal(rateLabel(1), '1×');
  assert.equal(rateLabel(0.85), '0.85×');
});

/* ── the switch between this device and Azure ─────────────────────────── */

import { voiceSetting, voiceStatus, AZURE_PREFIX } from '../js/speech.js';
import { withDefaults } from '../js/defaults.js';

test('an Azure voice chosen before the switch becomes the Azure side, with the switch on Azure', () => {
  const s = withDefaults({ speechVoice: 'azure:vi-VN-HoaiMyNeural' });
  assert.equal(s.speechSource, 'azure');
  assert.equal(s.azureVoice, 'vi-VN-HoaiMyNeural');
  assert.equal(s.speechVoice, '', 'the prefix never stays in the device side');
  const device = withDefaults({ speechVoice: 'Microsoft An' });
  assert.equal(device.speechSource, 'device');
  assert.equal(device.speechVoice, 'Microsoft An');
  assert.equal(withDefaults(null).speechSource, 'device');
  assert.equal(withDefaults({ speechSource: 'nonsense' }).speechSource, 'device');
});

test('each side keeps its own choice, and the switch picks which one speak() is given', () => {
  const s = withDefaults({ speechVoice: 'Microsoft An', azureVoice: 'vi-VN-NamMinhNeural', speechSource: 'device' });
  assert.equal(voiceSetting(s), 'Microsoft An');
  assert.equal(voiceSetting({ ...s, speechSource: 'azure' }), `${AZURE_PREFIX}vi-VN-NamMinhNeural`);
  assert.equal(voiceSetting({ ...s, speechSource: 'azure', azureVoice: '' }), AZURE_PREFIX, 'the first Azure voice');
});

const base = { language: 'Vietnamese', code: 'vi', device: ['Microsoft An'], chosenDevice: '', chosenAzure: '' };
const loaded = { key: true, voices: [{ name: 'vi-VN-HoaiMyNeural', label: 'HoaiMy' }, { name: 'vi-VN-NamMinhNeural', label: 'NamMinh' }], problem: '', saved: 3, code: 'vi' };

test('the status says which voice reads on this device, and why not when none can', () => {
  assert.deepEqual(voiceStatus({ ...base, source: 'device' }), { text: 'This device reads, with Microsoft An. 1 Vietnamese voice installed.', level: 'ok' });
  assert.equal(voiceStatus({ ...base, source: 'device', device: [] }).level, 'warn');
  assert.match(voiceStatus({ ...base, source: 'device', device: [] }).text, /or switch to Azure/);
  assert.match(voiceStatus({ ...base, source: 'device', chosenDevice: 'Gone' }).text, /"Gone" is not installed on this device, so Microsoft An reads instead/);
  assert.match(voiceStatus({ ...base, source: 'device', code: '' }).text, /not a language name/);
});

test('the status says Azure reads, or exactly why the device reads instead', () => {
  assert.match(voiceStatus({ ...base, source: 'azure', azure: loaded }).text, /^Azure reads, with HoaiMy\. 2 Vietnamese voices .* 3 words saved/);
  assert.match(voiceStatus({ ...base, source: 'azure', azure: loaded, chosenAzure: 'vi-VN-NamMinhNeural' }).text, /^Azure reads, with NamMinh\./);
  assert.match(voiceStatus({ ...base, source: 'azure', azure: { key: false } }).text, /no Azure key yet: enter one above\. Until then your device's voice \(Microsoft An\) reads instead/);
  assert.match(voiceStatus({ ...base, source: 'azure', azure: { ...loaded, problem: 'The key was refused.' } }).text, /Azure could not be used: The key was refused\. Until it can, your device's voice/);
  assert.match(voiceStatus({ ...base, source: 'azure', azure: { key: true, voices: [], code: '' } }).text, /Press Load voices/);
  assert.match(voiceStatus({ ...base, source: 'azure', azure: { key: true, voices: [], code: 'vi' } }).text, /Azure has no Vietnamese voice/);
  assert.match(voiceStatus({ ...base, source: 'azure', device: [], azure: { key: false } }).text, /this device has no Vietnamese voice either, so nothing is read aloud/);
  assert.equal(voiceStatus({ ...base, source: 'azure', azure: { key: false } }).level, 'warn');
});
