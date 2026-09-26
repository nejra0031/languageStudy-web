/* Turning a piece of selected text into a flashcard: the parts that are plain
   logic. Which way round the translation goes, whether the word is already a
   card, what a translation reply says, and which bit of the page counts as
   the sentence it was selected from. No DOM and no network here — the popup
   is lookup-popup.js and the one request is translate.js. */

import { normalize } from './text.js';
import { accepted } from './deck.js';

/* The languages Google Translate offers, by the code it takes and the
   English name the rest of the app uses for a language. The two dropdowns
   in Settings are filled from this, and it is how an English name such as
   the target language is turned into a code. */
export const LANGUAGES = [
  ['af', 'Afrikaans'], ['sq', 'Albanian'], ['am', 'Amharic'], ['ar', 'Arabic'],
  ['hy', 'Armenian'], ['as', 'Assamese'], ['az', 'Azerbaijani'], ['eu', 'Basque'],
  ['be', 'Belarusian'], ['bn', 'Bengali'], ['bs', 'Bosnian'], ['bg', 'Bulgarian'],
  ['my', 'Burmese'], ['ca', 'Catalan'], ['ceb', 'Cebuano'], ['zh-CN', 'Chinese (Simplified)'],
  ['zh-TW', 'Chinese (Traditional)'], ['co', 'Corsican'], ['hr', 'Croatian'], ['cs', 'Czech'],
  ['da', 'Danish'], ['nl', 'Dutch'], ['en', 'English'], ['eo', 'Esperanto'],
  ['et', 'Estonian'], ['fil', 'Filipino'], ['fi', 'Finnish'], ['fr', 'French'],
  ['fy', 'Frisian'], ['gl', 'Galician'], ['ka', 'Georgian'], ['de', 'German'],
  ['el', 'Greek'], ['gu', 'Gujarati'], ['ht', 'Haitian Creole'], ['ha', 'Hausa'],
  ['haw', 'Hawaiian'], ['iw', 'Hebrew'], ['hi', 'Hindi'], ['hmn', 'Hmong'],
  ['hu', 'Hungarian'], ['is', 'Icelandic'], ['ig', 'Igbo'], ['id', 'Indonesian'],
  ['ga', 'Irish'], ['it', 'Italian'], ['ja', 'Japanese'], ['jw', 'Javanese'],
  ['kn', 'Kannada'], ['kk', 'Kazakh'], ['km', 'Khmer'], ['rw', 'Kinyarwanda'],
  ['ko', 'Korean'], ['ku', 'Kurdish'], ['ky', 'Kyrgyz'], ['lo', 'Lao'],
  ['la', 'Latin'], ['lv', 'Latvian'], ['lt', 'Lithuanian'], ['lb', 'Luxembourgish'],
  ['mk', 'Macedonian'], ['mg', 'Malagasy'], ['ms', 'Malay'], ['ml', 'Malayalam'],
  ['mt', 'Maltese'], ['mi', 'Maori'], ['mr', 'Marathi'], ['mn', 'Mongolian'],
  ['ne', 'Nepali'], ['no', 'Norwegian'], ['ny', 'Nyanja'], ['or', 'Odia'],
  ['ps', 'Pashto'], ['fa', 'Persian'], ['pl', 'Polish'], ['pt', 'Portuguese'],
  ['pa', 'Punjabi'], ['ro', 'Romanian'], ['ru', 'Russian'], ['sm', 'Samoan'],
  ['gd', 'Scots Gaelic'], ['sr', 'Serbian'], ['st', 'Sesotho'], ['sn', 'Shona'],
  ['sd', 'Sindhi'], ['si', 'Sinhala'], ['sk', 'Slovak'], ['sl', 'Slovenian'],
  ['so', 'Somali'], ['es', 'Spanish'], ['su', 'Sundanese'], ['sw', 'Swahili'],
  ['sv', 'Swedish'], ['tg', 'Tajik'], ['ta', 'Tamil'], ['tt', 'Tatar'],
  ['te', 'Telugu'], ['th', 'Thai'], ['tr', 'Turkish'], ['tk', 'Turkmen'],
  ['uk', 'Ukrainian'], ['ur', 'Urdu'], ['ug', 'Uyghur'], ['uz', 'Uzbek'],
  ['vi', 'Vietnamese'], ['cy', 'Welsh'], ['xh', 'Xhosa'], ['yi', 'Yiddish'],
  ['yo', 'Yoruba'], ['zu', 'Zulu'],
];

/* Names people type for a language that are not the name in the list above. */
const ALIASES = {
  chinese: 'zh-CN', mandarin: 'zh-CN', cantonese: 'zh-TW', tagalog: 'fil',
  hebrew: 'iw', 'norwegian bokmål': 'no', bokmal: 'no', farsi: 'fa',
};

/* The code for an English language name, or a code given as it is; '' for
   neither. The target language is free text in Settings, so this is how the
   "same as target language" choice finds out what it means. */
export function codeFor(name) {
  const s = String(name || '').trim();
  if (!s) return '';
  const lower = s.toLowerCase();
  if (ALIASES[lower]) return ALIASES[lower];
  const hit = LANGUAGES.find(([code, label]) => label.toLowerCase() === lower || code.toLowerCase() === lower);
  if (hit) return hit[0];
  return /^[a-z]{2,3}(-[a-z0-9]{2,8})*$/i.test(s) ? s : '';
}

export function nameFor(code) {
  const hit = LANGUAGES.find(([c]) => sameLanguage(c, code));
  return hit ? hit[1] : String(code || '');
}

/* zh-CN and zh are one language for the question "which of the two is this?",
   and Google has spelt Hebrew both iw and he. */
export function sameLanguage(a, b) {
  const head = (c) => {
    const h = String(c || '').toLowerCase().split('-')[0];
    return h === 'he' ? 'iw' : h;
  };
  return !!head(a) && head(a) === head(b);
}

/* ── the translation request ─────────────────────────────────────────── */

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

export function translateUrl(text, sl, tl) {
  const q = new URLSearchParams({ client: 'gtx', sl: sl || 'auto', tl, dt: 't', q: String(text || '') });
  return `${ENDPOINT}?${q}`;
}

/* The reply is an undocumented array: [0] is the translation in pieces (one
   per sentence), each piece [translated, original, …], and [2] is the
   language Google detected. Anything else is null, never a half reading —
   a wrong meaning saved to a card is worse than an empty field. */
export function readTranslation(data) {
  if (!Array.isArray(data) || !Array.isArray(data[0])) return null;
  const pieces = data[0].filter((p) => Array.isArray(p) && typeof p[0] === 'string');
  if (!pieces.length) return null;
  const text = pieces.map((p) => p[0]).join('').trim();
  if (!text) return null;
  return { text, detected: typeof data[2] === 'string' ? data[2] : '' };
}

/* Which side of a card the selection is. Text in the student's own language
   is the meaning, and the word being learnt has to be looked up; anything
   else — the learning language, or a third one Google thinks it saw — is
   taken as the word itself, since that is what a page of practice mostly
   holds. */
export function resolveDirection(detected, learning, native) {
  if (sameLanguage(detected, native) && !sameLanguage(learning, native)) return 'reverse';
  return 'forward';
}

/* ── is it a card already? ───────────────────────────────────────────── */

/* Judged on normalize(), which keeps diacritics: a word with different
   accents is a different word, the rule text.js keeps everywhere. Case and
   punctuation do not make a new card. Each side matches anything the card
   accepts for it, alternatives included; `back` is the selection when it was
   in the student's own language. */
export function findCard(cards, { front = '', back = '' } = {}) {
  const f = normalize(front);
  const b = normalize(back);
  for (const card of cards || []) {
    if (f && accepted(card, 'front').some((w) => normalize(w) === f)) return card;
  }
  if (!b) return null;
  for (const card of cards || []) {
    if (accepted(card, 'back').some((m) => normalize(m) === b)) return card;
  }
  return null;
}

/* Whether a word typed into the popup has a gap in it: an ellipsis, … or
   "...". That is how a pattern is written, and nothing else would be, so the
   popup ticks Grammar pattern for it. A capital letter is a gap only on a
   card already marked as a pattern ("A mà B"), and elsewhere is a word
   ("A veces"), so it never ticks the box by itself — see deck.js. */
export function hasGap(front) {
  return /…|\.{3,}/.test(String(front || ''));
}

/* ── the selection ───────────────────────────────────────────────────── */

export const MAX_CHARS = 100;
export const MAX_WORDS = 8;

/* The selection as a card's word, or '' when it is not one: empty, or a
   paragraph dragged across by mistake, which should not open anything. */
export function cleanSelection(s) {
  const t = String(s || '').replace(/\s+/g, ' ').trim()
    .replace(/^[\s"'“”‘’«»([{]+|[\s"'“”‘’«»)\]},;:]+$/g, '');
  if (!t || t.length > MAX_CHARS) return '';
  if (t.split(' ').length > MAX_WORDS) return '';
  return t;
}

/* The sentence a selection sits in, from the text of the element around it.
   Sent with a request for notes, so the example and the sense fit the place
   the word was met. Sentences end at . ! ? … or a line break; a very long
   one is cut down around the selection. */
export function sentenceAround(text, start, end, max = 300) {
  const t = String(text || '');
  if (!t) return '';
  const s = Math.max(0, Math.min(start, t.length));
  const e = Math.max(s, Math.min(end, t.length));
  const stop = /[.!?…。！？\n]/;
  let a = s;
  while (a > 0 && !stop.test(t[a - 1])) a--;
  let b = e;
  while (b < t.length && !stop.test(t[b])) b++;
  if (b < t.length && t[b] !== '\n') b++;
  let out = t.slice(a, b);
  if (out.length > max) {
    /* Centred on the selection, as far as the sentence allows. */
    const lead = Math.max(0, Math.min(s - a - Math.floor((max - (e - s)) / 2), out.length - max));
    out = out.slice(lead, lead + max);
  }
  return out.replace(/\s+/g, ' ').trim();
}
