/* The browser's own text-to-speech, and the language codes it needs.

   This is not Gemini. Typing practice reads every card aloud, many times a
   session, and that must cost nothing and start instantly — which the
   browser's built-in voices do, offline. Gemini's voices are kept for
   dictation, where a fresh sentence is worth a call.

   Voices come from the operating system. macOS and iOS ship a Vietnamese one
   (Linh), and most languages have at least one; where none is installed the
   caller is told, and nothing is spoken. */

/* English names people type into Settings, to BCP 47 codes. A code typed
   directly ("vi", "pt-BR") is used as it is. */
const CODES = {
  arabic: 'ar', cantonese: 'zh-HK', chinese: 'zh', czech: 'cs', danish: 'da',
  dutch: 'nl', english: 'en', filipino: 'fil', finnish: 'fi', french: 'fr',
  german: 'de', greek: 'el', hebrew: 'he', hindi: 'hi', hungarian: 'hu',
  indonesian: 'id', italian: 'it', japanese: 'ja', korean: 'ko', malay: 'ms',
  mandarin: 'zh-CN', norwegian: 'nb', polish: 'pl', portuguese: 'pt',
  romanian: 'ro', russian: 'ru', spanish: 'es', swedish: 'sv', tagalog: 'fil',
  thai: 'th', turkish: 'tr', ukrainian: 'uk', vietnamese: 'vi',
};

export function languageCode(name) {
  const s = String(name || '').trim();
  const known = CODES[s.toLowerCase()];
  if (known) return known;
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(s) ? s : '';
}

import * as azure from './azure-tts.js';

const synth = typeof window !== 'undefined' && window.speechSynthesis ? window.speechSynthesis : null;

/* Some browsers fill the voice list a moment after load. */
let voices = [];
function loadVoices() { voices = synth ? synth.getVoices() : []; }
if (synth) {
  loadVoices();
  synth.addEventListener?.('voiceschanged', loadVoices);
}

/* Told when either list of voices changes: the device's, or Azure's. */
const voiceListeners = new Set();
export function onVoicesChanged(fn) {
  voiceListeners.add(fn);
  if (synth) synth.addEventListener?.('voiceschanged', fn);
}
function voicesChanged() {
  for (const fn of voiceListeners) { try { fn(); } catch (e) { console.error(e); } }
}

/* ── Azure neural voices, when the user has given a key ─────────────────

   A chosen Azure voice is stored as "azure:<ShortName>", beside the device
   voice names, so one setting says which voice reads. */

export const AZURE_PREFIX = 'azure:';
/* saved: how many clips voice/ holds — shown in Settings, so it is visible
   that a word already heard costs nothing the next time. */
const azureState = { region: azure.DEFAULT_REGION, code: '', voices: [], problem: '', saved: 0 };

export function azureStatus() {
  return { ...azureState, key: !!azure.getKey() };
}

/* Fetches the Azure voices for a language. Called at boot and whenever the
   key, region or language changes; with no key it just empties the list. */
export async function loadAzure(region, code) {
  azureState.region = azure.cleanRegion(region) || azure.DEFAULT_REGION;
  azureState.code = code;
  azureState.problem = '';
  const key = azure.getKey();
  if (!key || !code) {
    azureState.voices = [];
    voicesChanged();
    return azureState;
  }
  try {
    azureState.voices = await azure.listVoices({ region: azureState.region, key, code });
    if (clipStore && clipStore.count) azureState.saved = await clipStore.count().catch(() => azureState.saved);
  } catch (e) {
    azureState.voices = [];
    azureState.problem = e.message;
  }
  voicesChanged();
  return azureState;
}

function azureVoicesFor(code) {
  const lang = String(code || '').toLowerCase().split('-')[0];
  return azureState.voices.filter((v) => v.locale.toLowerCase().split('-')[0] === lang);
}

/* Every installed voice for a code, best first: an exact region match before
   the rest of the language, and within those a downloaded higher-quality voice
   ("Linh (Enhanced)") before the compact default, on-device before remote. */
export function voicesFor(code) {
  if (!synth || !code) return [];
  if (!voices.length) loadVoices();
  const want = code.toLowerCase();
  const lang = want.split('-')[0];
  const norm = (v) => String(v.lang || '').toLowerCase().replace('_', '-');
  const rank = (v) => (norm(v) === want ? 4 : 0)
    + (/enhanced|premium/i.test(v.name) ? 2 : 0) + (v.localService ? 1 : 0);
  return voices
    .filter((v) => norm(v).split('-')[0] === lang)
    .sort((a, b) => rank(b) - rank(a));
}

/* The chosen voice if it is still installed, else the best there is. */
export function voiceFor(code, name = '') {
  const list = voicesFor(code);
  return (name && list.find((v) => v.name === name)) || list[0] || null;
}

/* The one voice setting speak() takes, from the settings: which source
   reads (speechSource, the switch in Settings) and that source's own
   choice, so switching back and forth keeps each side's pick. An Azure
   choice is "azure:<ShortName>", or a bare "azure:" for the first Azure
   voice there is; a device choice is the voice's name, or '' for the best
   installed. */
export function voiceSetting(settings) {
  if (settings && settings.speechSource === 'azure') return AZURE_PREFIX + String(settings.azureVoice || '');
  return String((settings && settings.speechVoice) || '');
}

/* Whether anything can read this language from this source: the device
   needs an installed voice; Azure needs a key and a voice for the language,
   and without one the device reads, so a device voice counts too. */
export function canSpeak(code, source = 'device') {
  if (source === 'azure' && azure.getKey() && azureVoicesFor(code).length) return true;
  return !!voiceFor(code);
}

/* Speaks text, cutting off anything still being said. Returns false when
   there is no voice for the language. `voice` is voiceSetting(): an Azure
   voice is used when that is the source and a key is set, and the device's
   voice otherwise — including when Azure is chosen but cannot be used,
   which Settings says in so many words. */
export function speak(text, code, { rate = 1, voice: name = '' } = {}) {
  if (!text) return false;
  if (name.startsWith(AZURE_PREFIX) && azure.getKey()) {
    const wanted = name.slice(AZURE_PREFIX.length);
    const azureVoices = azureVoicesFor(code);
    /* A chosen Azure voice is spoken with straight away, without waiting for
       the voice list: the list arrives a moment after boot, and the first
       card is read before then — by the device's voice, which is the wrong
       one. Its name carries its locale ("vi-VN-NamMinhNeural"), which is all
       a request needs; the list is only for the picker. With no choice, the
       first Azure voice for the language reads, once the list is in. */
    const pick = wanted
      ? (azureVoices.find((v) => v.name === wanted) || azureVoiceFromName(wanted, code))
      : azureVoices[0] || null;
    if (pick) {
      speakAzure(String(text), pick, rate, code);
      return true;
    }
  }
  return speakDevice(text, code, rate, name);
}

/* "vi-VN-NamMinhNeural" → { name, locale: "vi-VN" }, if it is a voice for
   this language at all. */
export function azureVoiceFromName(name, code) {
  const m = /^([a-z]{2,3}-[A-Za-z]{2,4})-\w+$/.exec(String(name || ''));
  if (!m) return null;
  const lang = String(code || '').toLowerCase().split('-')[0];
  if (lang && m[1].toLowerCase().split('-')[0] !== lang) return null;
  return { name, locale: m[1], label: name };
}

function speakDevice(text, code, rate, name) {
  const voice = voiceFor(code, name.startsWith(AZURE_PREFIX) ? '' : name);
  if (!voice) return false;
  stop();
  const u = new SpeechSynthesisUtterance(String(text));
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = rate;
  synth.speak(u);
  spoken({ voice: voice.name.replace(/\s*\(.*\)\s*$/, ''), source: 'device' });
  return true;
}

/* Where fetched clips are kept between sessions: set by app.js to the
   store's voice/ directory. speech.js does not know about storage itself. */
let clipStore = null;
export function setClipStore(store) { clipStore = store; }

/* Who read the last text, and from where, for a note beside Listen again:
   { voice, source: 'saved' | 'fetched' | 'device', blocked }. Saying it is
   what makes the saving visible — "saved clip" is a word that cost nothing. */
const spokenListeners = new Set();
export function onSpoken(fn) { spokenListeners.add(fn); }
function spoken(info) {
  for (const fn of spokenListeners) { try { fn(info); } catch (e) { console.error(e); } }
}

/* "vi-VN-NamMinhNeural" → "NamMinh". */
export function shortVoiceName(name) {
  const m = /^[a-z]{2,3}-[A-Za-z]{2,4}-(.+?)(Neural)?$/.exec(String(name || ''));
  return m ? m[1] : String(name || '');
}

/* Each text is fetched from Azure once, ever: after that it comes from
   memory this session and from the saved clip in later ones, so Listen
   again, a card coming round again and tomorrow's practice cost nothing. */
const azureCache = new Map();
let player = null;
let latest = 0;

async function speakAzure(text, voice, rate, code) {
  stop();
  const ticket = ++latest;
  const cacheKey = `${voice.name}\n${text}`;
  try {
    let fresh = false;
    if (!azureCache.has(cacheKey)) {
      const fetching = clipFor(voice, text).then(({ blob, source }) => ({ url: URL.createObjectURL(blob), source }));
      azureCache.set(cacheKey, fetching);
      fetching.catch(() => azureCache.delete(cacheKey));
      fresh = true;
    }
    const { url, source } = await azureCache.get(cacheKey);
    /* Something else was asked for while this one was on its way. */
    if (ticket !== latest) return;
    const info = { voice: shortVoiceName(voice.name), source: fresh ? source : 'saved' };
    player = new Audio(url);
    player.playbackRate = rate;
    try {
      await player.play();
    } catch (e) {
      /* Autoplay refused — Safari will not play audio with sound before the
         page has been clicked or typed in, as after a reload. Said out loud,
         so Listen again is pressed rather than the card left silent. */
      if (e && e.name === 'NotAllowedError') { spoken({ ...info, blocked: true }); return; }
      throw e;
    }
    azureState.problem = '';
    spoken(info);
  } catch (e) {
    /* Fall back to the device's voice, and say why in Settings. */
    azureState.problem = e.message || String(e);
    voicesChanged();
    if (ticket === latest) speakDevice(text, code, rate, '');
  }
}

/* Speaking speed. 1 is the voice's own pace, which on some systems —
   Windows voices in Chrome and Edge especially — is brisk for a learner. */
export const RATE = { min: 0.5, max: 1.5, step: 0.05, default: 1 };

export function clampRate(rate) {
  const r = Number(rate);
  if (!Number.isFinite(r)) return RATE.default;
  const stepped = Math.round(r / RATE.step) * RATE.step;
  /* Two decimals, so 0.85 is 0.85 and not 0.8500000000000001. */
  return Math.min(RATE.max, Math.max(RATE.min, Number(stepped.toFixed(2))));
}

export function rateLabel(rate) {
  return `${Number(clampRate(rate).toFixed(2))}×`;
}

/* The <option>s for one source's voice picker. The device's: "Best
   available" first, then every installed voice for the language. Azure's:
   "First voice" first, then every Azure voice for the language, by the
   short name the option's value carries without its prefix. The chosen one
   is kept on the list even when it is not available here, so picking on
   one machine is not undone by opening the app on another. */
export function voiceOptions(code, chosen = '', source = 'device') {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  if (source === 'azure') {
    const cloud = azure.getKey() ? azureVoicesFor(code) : [];
    const missing = chosen && !cloud.some((v) => v.name === chosen);
    return [
      `<option value="">First voice${cloud[0] ? ` (${esc(cloud[0].label)})` : ''}</option>`,
      ...cloud.map((v) => `<option value="${esc(v.name)}">${esc(v.label)} · ${esc(v.locale)}${v.gender ? ` · ${esc(v.gender.toLowerCase())}` : ''}</option>`),
      ...(missing ? [`<option value="${esc(chosen)}">${esc(chosen)} · ${cloud.length ? 'not offered for this language' : 'not loaded'}</option>`] : []),
    ].join('');
  }
  const list = voicesFor(code);
  const missing = chosen && !list.some((v) => v.name === chosen);
  return [
    `<option value="">Best available${list[0] ? ` (${esc(list[0].name)})` : ''}</option>`,
    ...list.map((v) => `<option value="${esc(v.name)}">${esc(v.name)} · ${esc(v.lang)}${v.localService ? '' : ' · online'}</option>`),
    ...(missing ? [`<option value="${esc(chosen)}">${esc(chosen)} · not installed here</option>`] : []),
  ].join('');
}

/* The line under Read-aloud voice: what will actually read, said plainly,
   with anything in the way. A plain function of what is known, so every
   case can be tested:

     source        'device' or 'azure', the switch
     language      the target language's name, for the words
     code          its language code, '' when the name is not one we know
     device        the installed voices' names for it, best first
     chosenDevice  the device side's pick, '' for the best
     azure         {key, voices: [{name, label}], problem, saved, code}
     chosenAzure   the Azure side's pick, '' for the first

   Returns {text, level}, level being 'ok' or 'warn'. */
export function voiceStatus({ source, language, code, device = [], chosenDevice = '', azure: az = {}, chosenAzure = '' }) {
  const warn = (text) => ({ text, level: 'warn' });
  if (!code) return warn(`"${language}" is not a language name this app knows a code for — try its English name, or a code such as "vi".`);
  const fallback = device.length ? `your device's voice (${chosenDevice && device.includes(chosenDevice) ? chosenDevice : device[0]}) reads instead` : `and this device has no ${language} voice either, so nothing is read aloud`;
  if (source === 'azure') {
    if (!az.key) return warn(`Azure is chosen but there is no Azure key yet: enter one above. Until then ${fallback}.`);
    if (az.problem) return warn(`Azure could not be used: ${az.problem} Until it can, ${fallback}.`);
    if (!az.voices || !az.voices.length) {
      return warn(az.code ? `Azure has no ${language} voice, so ${fallback}.` : `Press Load voices to fetch Azure's ${language} voices. Until then ${fallback}.`);
    }
    const picked = chosenAzure && az.voices.find((v) => v.name === chosenAzure);
    if (chosenAzure && !picked) return warn(`${chosenAzure} is not one of Azure's ${language} voices, so the first one, ${az.voices[0].label}, reads.`);
    const who = picked ? picked.label : az.voices[0].label;
    return { text: `Azure reads, with ${who}. ${az.voices.length} ${language} voice${az.voices.length === 1 ? '' : 's'} to choose from; ${az.saved || 0} word${az.saved === 1 ? '' : 's'} saved, played without calling Azure again.`, level: 'ok' };
  }
  if (!device.length) return warn(`No ${language} voice is installed on this device, so nothing is read aloud. Install one (see above), or switch to Azure.`);
  if (chosenDevice && !device.includes(chosenDevice)) return warn(`"${chosenDevice}" is not installed on this device, so ${device[0]} reads instead.`);
  return { text: `This device reads, with ${chosenDevice || device[0]}. ${device.length} ${language} voice${device.length === 1 ? '' : 's'} installed.`, level: 'ok' };
}

/* A saved clip if there is one; otherwise Azure, and the answer saved. */
async function clipFor(voice, text) {
  const name = await azure.clipName(voice.name, text);
  const saved = clipStore ? await clipStore.read(name).catch(() => null) : null;
  if (saved && saved.size) return { blob: saved, source: 'saved' };
  const blob = await azure.synthesize({
    region: azureState.region, key: azure.getKey(), voice: voice.name, locale: voice.locale, text,
  });
  if (clipStore) {
    clipStore.write(name, blob)
      .then((ok) => { if (ok) { azureState.saved++; voicesChanged(); } })
      .catch((e) => console.error('Could not save a voice clip', e));
  }
  return { blob, source: 'fetched' };
}

/* Silences whatever is speaking, and anything still being fetched. */
export function stop() {
  latest++;
  if (synth) synth.cancel();
  if (player) { player.pause(); player = null; }
}
