/* Export: one kept record as one file someone else can open.

   A shadowing set, a reading text, a piece of writing or a conversation,
   written out as a single .html file: the task, what the learner wrote or
   said, the feedback, and, when asked for, the recordings. It is for
   showing work to a teacher, so the file format is the one the receiver
   needs nothing for. An .html file opens by double-click in any browser, on
   a phone or a computer, offline; it prints, and saves as a PDF from the
   print dialog. There is nothing to unzip and nothing to install.

   The file is self-contained. Its styles are in it, its audio is in it as
   data: URIs, and it has no script and loads nothing from anywhere. Every
   piece of text from a record is escaped on the way in: a record holds what
   a model wrote, and a file that is going to be opened by someone else must
   not run any of it.

   Everything here is a plain function over a record, with no DOM and no
   storage: the tab reads the recordings and hands them over, and saves the
   result with storage.download(). Nothing from Settings goes into a file,
   and no key could: a record never holds one. */

import { escapeHtml } from './text.js';
import { languageCode } from './speech.js';
import { toBase64, handinsOf, lineList } from './shadowing.js';
import { contentOf, isLive, factStatus, turnsOf, suggestionChanged } from './conversation.js';
import { BANDS, BAND_LABELS, minutesLabel } from './live.js';

/* ── audio ───────────────────────────────────────────────────────────── */

const MIME_BY_EXT = {
  webm: 'audio/webm', ogg: 'audio/ogg', mp4: 'audio/mp4', m4a: 'audio/mp4', wav: 'audio/wav', mp3: 'audio/mpeg',
};

/* The type to play a file as, from its name: a recording is named by the
   type its recorder gave it (extensionFor() in shadowing.js), and a file
   read back from the store does not always say. */
export function mimeForPath(path) {
  const ext = String(path || '').split('.').pop().toLowerCase();
  return MIME_BY_EXT[ext] || 'audio/webm';
}

export function dataUri(path, bytes) {
  return `data:${mimeForPath(path)};base64,${toBase64(bytes)}`;
}

/* Every recording a record has, as paths, in the order they are heard: what
   the tab reads before building the file. */
export function audioPaths(kind, record) {
  const out = [];
  const add = (p) => { if (p && !out.includes(p)) out.push(p); };
  if (kind === 'shadowing') {
    for (const h of handinsOf(record.feedback)) for (const n of h.notes || []) add(n.file);
    for (const item of record.items || []) add(item.file);
  } else if (kind === 'reading') {
    add(record.audio && record.audio.file);
  } else if (kind === 'conversation') {
    add(record.take);
    for (const t of record.turns || []) add(t.take);
  }
  return out;
}

/* The recordings as data: URIs, by path. `read(path)` gives a Blob or
   null; one that cannot be read is left out, and listed in `missing`, so the
   file says a recording is absent instead of showing a player that plays
   nothing. */
export async function gatherAudio(paths, read) {
  const audio = new Map();
  const missing = [];
  let bytes = 0;
  for (const path of paths) {
    const blob = await read(path);
    if (!blob) { missing.push(path); continue; }
    const data = new Uint8Array(await blob.arrayBuffer());
    if (!data.length) { missing.push(path); continue; }
    bytes += data.length;
    audio.set(path, dataUri(path, data));
  }
  return { audio, missing, bytes };
}

/* "840 KB", "2.3 MB": how big the file came out, said after it is saved. */
export function sizeLabel(bytes) {
  const n = Math.max(0, Number(bytes) || 0);
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/* ── the page ────────────────────────────────────────────────────────── */

const e = escapeHtml;

const STYLE = `
:root { color-scheme: light dark; }
body { font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; margin: 0; padding: 24px 16px 48px; }
main { max-width: 46rem; margin: 0 auto; }
h1 { font-size: 1.5rem; line-height: 1.3; margin: 0 0 4px; }
h2 { font-size: 1.05rem; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #8884; }
h3 { font-size: .95rem; margin: 18px 0 6px; }
p { margin: 8px 0; }
.meta, .sub, footer { color: #777; font-size: .85rem; }
.sub { display: block; }
.box { border: 1px solid #8886; border-radius: 6px; padding: 10px 14px; margin: 10px 0; }
.text { white-space: pre-wrap; font-size: 1.05rem; }
.me { border-left: 4px solid #c9a227; }
.them { border-left: 4px solid #8886; }
.who { font-size: .75rem; text-transform: uppercase; letter-spacing: .06em; color: #777; display: block; }
ul, ol { padding-left: 1.3rem; margin: 8px 0; }
li { margin: 6px 0; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 8px 0; }
dt { color: #777; }
dd { margin: 0; }
mark { background: #c9a22733; color: inherit; padding: 0 2px; border-radius: 2px; }
del { color: #b3261e; }
ins { color: #1b7f3b; text-decoration: none; font-weight: 600; }
.ok { color: #1b7f3b; }
.bad { color: #b3261e; }
.tag { font-size: .75rem; border: 1px solid #8886; border-radius: 3px; padding: 0 5px; margin-right: 6px; }
.score { font-size: 2rem; font-weight: 700; }
audio { display: block; width: 100%; max-width: 28rem; margin: 6px 0; }
footer { max-width: 46rem; margin: 40px auto 0; border-top: 1px solid #8884; padding-top: 10px; }
@media print { body { padding: 0; } audio { display: none; } .box { break-inside: avoid; } }
`;

function page({ title, lang, meta, body, audioCount, withAudio, missing }) {
  const notes = [];
  if (audioCount && withAudio) {
    notes.push('The recordings are inside this file. They are as the browser that made them recorded them (Ogg, WebM or MP4 audio): if one does not play here, open the file in another browser.');
  } else if (audioCount) {
    notes.push('This was exported without its recordings.');
  }
  if (missing) notes.push(`${missing} recording${missing === 1 ? '' : 's'} could not be read and ${missing === 1 ? 'is' : 'are'} not in this file.`);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1${lang ? ` lang="${e(lang)}"` : ''}>${e(title)}</h1>
<p class="meta">${meta.filter(Boolean).map(e).join(' · ')}</p>
${body}
</main>
<footer>
<p>Exported from Language Study. The feedback in it was written by an AI model.</p>
${notes.map((n) => `<p>${e(n)}</p>`).join('\n')}
</footer>
</body>
</html>
`;
}

/* A player for one recording, or a line saying why there is none. */
function player(path, audio, withAudio, label) {
  if (!path) return '';
  if (!withAudio) return '';
  const src = audio.get(path);
  if (!src) return '<span class="sub">This recording could not be read.</span>';
  return `<audio controls preload="none" src="${src}"${label ? ` aria-label="${e(label)}"` : ''}></audio>`;
}

const VERDICT = { right: 'Right', wrong: 'Wrong', absent: 'Not used' };

/* The learner's cards and what the grader said of each. `cards` are
   {front}; `verdicts` come from cardVerdicts(). */
function cardsHtml(cards, verdicts, lang) {
  if (!cards || !cards.length) return '';
  const by = new Map((verdicts || []).map((v) => [v.index, v]));
  return `<h2>Flashcards</h2><ul>${cards.map((c, i) => {
    const v = by.get(i);
    const cls = v && v.verdict === 'right' ? 'ok' : v && v.verdict === 'wrong' ? 'bad' : '';
    return `<li><strong lang="${e(lang)}">${e(c.front)}</strong> — <span class="${cls}">${v ? VERDICT[v.verdict] || 'Not judged' : 'Not judged'}</span>${v && v.note ? `<span class="sub">${e(v.note)}</span>` : ''}</li>`;
  }).join('')}</ul>`;
}

function fileName(kind, record) {
  return `${kind}-${String(record.id || 'export').replace(/[^\w.-]+/g, '_')}.html`;
}

function count(map, paths) {
  return paths.filter((p) => !map.has(p)).length;
}

/* ── shadowing ───────────────────────────────────────────────────────── */

/* A set by hand-in, as the tab shows it: each hand-in's overall note, then
   the lines it heard, each with the take it heard and what was said of it.
   Lines never handed in come last, with their recording if they have one. */
export function shadowingExport(session, { audio = new Map(), withAudio = true } = {}) {
  const lang = languageCode(session.language);
  const items = session.items || [];
  const byIndex = new Map(items.map((it) => [it.index, it]));
  const paths = audioPaths('shadowing', session);
  const handins = handinsOf(session.feedback);
  const heard = new Set();
  /* Numbered as in the set, whichever hand-in a line turns up under. */
  const line = (index, item, file, comment) => `<li class="box me" value="${index + 1}">
    <span class="text" lang="${e(lang)}">${e(item ? item.text : '')}</span>
    ${item && item.gloss ? `<span class="sub">${e(item.gloss)}</span>` : ''}
    ${player(file, audio, withAudio, 'Your recording of this line')}
    ${comment ? `<p>${e(comment)}</p>` : ''}
  </li>`;
  const blocks = handins.map((h) => {
    const notes = new Map((h.notes || []).map((n) => [n.itemIndex, n]));
    for (const i of h.lines || []) heard.add(i);
    return `<h2>Hand-in ${h.n}${h.gradedAt ? ` · ${e(String(h.gradedAt).slice(0, 10))}` : ''}</h2>
      <p class="meta">${e(lineList(h.lines))}${h.model ? ` · ${e(h.model)}` : ''}</p>
      ${h.overall ? `<h3>How you sounded</h3><p>${e(h.overall)}</p>` : ''}
      ${h.focusNote ? `<p><strong>To work on:</strong> ${e(h.focusNote)}</p>` : ''}
      <ol>${(h.lines || []).map((i) => {
        const n = notes.get(i);
        const item = byIndex.get(i);
        return line(i, item, (n && n.file) || (item && item.file), n && n.comment);
      }).join('')}</ol>`;
  });
  const rest = items.filter((it) => !heard.has(it.index));
  if (rest.length) {
    blocks.push(`<h2>${handins.length ? 'Not handed in' : 'The lines'}</h2>
      <ol>${rest.map((it) => line(it.index, it, it.file, '')).join('')}</ol>`);
  }
  return {
    filename: fileName('shadowing', session),
    html: page({
      title: `Shadowing set, ${session.created || ''}`.trim(),
      meta: [session.language, session.level, `${items.length} line${items.length === 1 ? '' : 's'}`, `${items.filter((i) => i.file).length} recorded`],
      body: blocks.join('\n'),
      audioCount: paths.length,
      withAudio,
      missing: withAudio ? count(audio, paths) : 0,
    }),
  };
}

/* ── reading ─────────────────────────────────────────────────────────── */

/* The text, with the learner's words marked where they are used, its audio
   if it was read aloud, and the cards it was written around. Answers are
   not kept with a text, so there are none to show. */
export function readingExport(record, { audio = new Map(), withAudio = true } = {}) {
  const lang = languageCode(record.language);
  const paths = audioPaths('reading', record);
  const items = record.items || [];
  const used = new Set(record.used || []);
  const paragraphs = (record.paragraphs || []).map((runs) => `<p>${runs.map((r) => {
    const text = e(r.text).replace(/\n/g, '<br>');
    return r.item === undefined ? text : `<mark title="${e((items[r.item] && items[r.item].back) || '')}">${text}</mark>`;
  }).join('')}</p>`).join('\n');
  const body = `${paths.length ? player(paths[0], audio, withAudio, 'The text read aloud') : ''}
    <div class="text" lang="${e(lang)}" style="white-space:normal">${paragraphs}</div>
    ${record.request ? `<h2>What was asked for</h2><p>${e(record.request)}</p>` : ''}
    ${items.length ? `<h2>Flashcards in this text</h2><ul>${items.map((it, i) => `<li><strong lang="${e(lang)}">${e(it.front)}</strong> — ${e(it.back || '')}${it.pattern ? ' <span class="tag">pattern</span>' : ''}${used.has(i) ? '' : '<span class="sub">not used in the text</span>'}</li>`).join('')}</ul>` : ''}`;
  return {
    filename: fileName('reading', record),
    html: page({
      title: record.title || 'Reading text',
      lang,
      meta: ['Reading', record.created, record.language, record.level, record.model],
      body,
      audioCount: paths.length,
      withAudio,
      missing: withAudio ? count(audio, paths) : 0,
    }),
  };
}

/* ── writing ─────────────────────────────────────────────────────────── */

/* The task, what was written, and the feedback in the sections the tab
   shows it in. A draft has no feedback yet, and says so. `source` is the
   text a summary is of, {title, text}, when the tab could still read it. */
export function writingExport(record, { source = null } = {}) {
  const lang = languageCode(record.language);
  const r = record.result;
  const summary = record.kind === 'summary';
  const parts = [];
  parts.push('<h2>The task</h2>');
  parts.push(summary
    ? `<p>Summarise “${e(record.readingTitle || 'a reading text')}” in your own words.</p>`
    : `<p lang="${e(lang)}">${e(record.brief || '')}</p>`);
  if (summary && source && source.text) {
    parts.push(`<details><summary>The text summarised</summary><div class="box text" lang="${e(lang)}">${e(source.text)}</div></details>`);
  }
  parts.push('<h2>What was written</h2>');
  parts.push(`<div class="box me text" lang="${e(lang)}">${e(record.text || '')}</div>`);
  if (!r) {
    parts.push('<p class="meta">Not handed in yet: this is a draft, and has no feedback.</p>');
    if ((record.cards || []).length) {
      parts.push(`<h2>Flashcards to try to use</h2><ul>${record.cards.map((c) => `<li><strong lang="${e(lang)}">${e(c.front)}</strong></li>`).join('')}</ul>`);
    }
  } else if (!r.valid) {
    parts.push(`<h2>Feedback</h2><p><strong>This was not counted as an attempt at the task.</strong> ${e(r.reason || '')} Nothing was scored.</p>`);
  } else {
    parts.push('<h2>Feedback</h2>');
    if (r.detectedLevel) parts.push(`<p>This reads at <strong>${e(r.detectedLevel)}</strong>.</p>`);
    if (r.languageNote) parts.push(`<p>${e(r.languageNote)}</p>`);
    if (r.contentNote) parts.push(`<p>${e(r.contentNote)}</p>`);
    if ((r.taskPoints || []).length) {
      parts.push(`<h3>What the task asked for</h3><ul>${r.taskPoints.map((p) => `<li><span class="${p.met ? 'ok' : 'bad'}">${p.met ? '✓' : '✗'}</span> ${e(p.point)}${!p.met && p.note ? `<span class="sub">${e(p.note)}</span>` : ''}</li>`).join('')}</ul>`);
    }
    parts.push('<h3>Grammar and spelling</h3>');
    parts.push((r.grammarMistakes || []).length
      ? `<ul>${r.grammarMistakes.map((g) => `<li>${e(g.description)}${g.correction ? ` → <ins lang="${e(lang)}">${e(g.correction)}</ins>` : ''}</li>`).join('')}</ul>`
      : '<p>No mistakes found.</p>');
    if ((r.vocabStyle || []).length) {
      parts.push(`<h3>Ways to say it a level up</h3><ul>${r.vocabStyle.map((v) => `<li><span class="tag">${v.category === 'STYLE' ? 'Style' : 'Word choice'}</span><span lang="${e(lang)}">“${e(v.original)}”</span> → <ins lang="${e(lang)}">${(v.suggestions || []).map(e).join(' / ')}</ins>${v.reason ? `<span class="sub">${e(v.reason)}</span>` : ''}</li>`).join('')}</ul>`);
    }
    parts.push(cardsHtml(record.cards, r.cards, lang));
  }
  return {
    filename: fileName('writing', record),
    html: page({
      title: record.title || (summary ? 'Summary' : 'Opinion piece'),
      lang: summary ? '' : lang,
      meta: [summary ? 'Writing: a summary' : 'Writing: an opinion piece', record.created, record.language, record.level, record.model, r ? '' : 'draft'],
      body: parts.join('\n'),
      audioCount: 0,
      withAudio: false,
      missing: 0,
    }),
  };
}

/* ── conversation ────────────────────────────────────────────────────── */

function sceneHtml(s, lang) {
  const sc = s.scenario || {};
  const findOut = contentOf(s) === 'findout';
  const rows = [
    ['The situation', findOut ? sc.situation : sc.scenario],
    ['The learner played', sc.studentRole],
    ['The AI model played', sc.llmRole],
  ];
  if (findOut) rows.push(['Sent to find out', sc.goal]);
  let html = `<h2>The scene</h2><dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd lang="${e(lang)}">${e(v || '')}</dd>`).join('')}</dl>`;
  if (findOut && (sc.facts || []).length) {
    const { found } = factStatus(s);
    /* The answers are given only once the conversation is over, as on the
       tab: until then they are what is being found out. */
    html += `<h3>What there was to find out</h3><ul>${sc.facts.map((f) => {
      const got = found.includes(f.label);
      return `<li><span class="${got ? 'ok' : ''}">${got ? '✓' : '○'}</span> <span lang="${e(lang)}">${e(f.label)}${s.ended ? `<span class="sub">${e(f.detail)}</span>` : ''}</span></li>`;
    }).join('')}</ul>`;
  }
  return html;
}

function turnsHtml(s, lang, audio, withAudio) {
  const sc = s.scenario || {};
  return `<h2>The conversation</h2>${(s.turns || []).map((t) => {
    const mine = t.speaker === 'learner';
    return `<div class="box ${mine ? 'me' : 'them'}">
      <span class="who">${e(mine ? sc.studentRole : sc.llmRole)}${mine ? '' : ' · AI model'}</span>
      <span class="text" lang="${e(lang)}">${e(t.text)}</span>
      ${mine ? player(t.take, audio, withAudio, 'Your recording of this turn') : ''}
    </div>`;
  }).join('')}`;
}

function liveFeedbackHtml(s, fb, lang, audio, withAudio) {
  const sc = s.scenario || {};
  const parts = ['<h2>Feedback</h2>'];
  if (fb.score !== null && fb.score !== undefined && fb.bands) {
    parts.push(`<p><span class="score">${e(String(fb.score))}%</span> <span class="meta">computed from four marks out of 4</span></p>`);
    parts.push(`<ul>${BANDS.map((b) => `<li><strong>${BAND_LABELS[b]}</strong>: ${e(String(fb.bands[b]))} of 4${fb.reasons && fb.reasons[b] ? `<span class="sub">${e(fb.reasons[b])}</span>` : ''}</li>`).join('')}</ul>`);
  } else {
    parts.push('<p class="meta">Too little was said to score.</p>');
  }
  if (fb.overall) parts.push(`<p>${e(fb.overall)}</p>`);
  if (s.take) {
    parts.push(`<h3>The recording${s.talked ? ` · ${e(minutesLabel(s.talked))}` : ''}</h3>`);
    parts.push(player(s.take, audio, withAudio, 'The recording of the conversation'));
  }
  parts.push('<h2>The conversation, as it was said</h2>');
  parts.push((fb.lines || []).map((l) => {
    const mine = l.speaker === 'learner';
    const fixes = (l.corrections || []).map((c) => `<p><del lang="${e(lang)}">${e(c.original)}</del> → <ins lang="${e(lang)}">${e(c.correction)}</ins>${c.why ? `<span class="sub">${e(c.why)}</span>` : ''}</p>`).join('');
    const alts = (l.alternatives || []).map((a) => `<p>More natural: <ins lang="${e(lang)}">${(a.suggestions || []).map((x) => `“${e(x)}”`).join(' or ')}</ins> for <span lang="${e(lang)}">“${e(a.original)}”</span>${a.why ? `<span class="sub">${e(a.why)}</span>` : ''}</p>`).join('');
    return `<div class="box ${mine ? 'me' : 'them'}"><span class="who">${e(mine ? sc.studentRole : sc.llmRole)}${mine ? '' : ' · AI model'}</span><span class="text" lang="${e(lang)}">${e(l.text)}</span>${fixes}${alts}</div>`;
  }).join(''));
  if ((fb.pronunciation || []).length) {
    parts.push(`<h3>How it sounded</h3><ul>${fb.pronunciation.map((n) => `<li><strong lang="${e(lang)}">${e(n.word)}</strong> ${e(n.comment)}</li>`).join('')}</ul>`);
  }
  parts.push(cardsHtml(s.cards, fb.cards, lang));
  return parts.join('\n');
}

function turnFeedbackHtml(s, fb, lang) {
  const parts = ['<h2>Feedback</h2>'];
  if (contentOf(s) === 'findout') {
    if (fb.conversation) parts.push(`<p>${e(fb.conversation)}</p>`);
    if (fb.asking) parts.push(`<p>${e(fb.asking)}</p>`);
    if (fb.nextTime) parts.push(`<p><strong>Next time:</strong> ${e(fb.nextTime)}</p>`);
    if ((fb.missed || []).length) parts.push(`<p class="meta">Never asked about: <span lang="${e(lang)}">${fb.missed.map(e).join('; ')}</span></p>`);
  } else {
    if (s.deliveryNote) parts.push(`<h3>How it sounded</h3><p>${e(s.deliveryNote)}</p>`);
    const by = new Map((fb.turns || []).map((f) => [f.turnIndex, f]));
    parts.push(`<h3>Turn by turn</h3><ol>${(s.turns || []).map((t, i) => ({ t, i })).filter(({ t }) => t.speaker === 'learner').map(({ t, i }) => {
      const f = by.get(i);
      return `<li><span lang="${e(lang)}">“${e(t.text)}”</span>
        ${f && suggestionChanged(f.natural, t.text) ? `<p>More natural: <ins lang="${e(lang)}">“${e(f.natural)}”</ins></p>` : ''}
        ${f && f.comment ? `<span class="sub">${e(f.comment)}</span>` : ''}</li>`;
    }).join('')}</ol>`);
  }
  parts.push(cardsHtml(s.cards, fb.cards, lang));
  return parts.join('\n');
}

/* A conversation of any kind, held either way: the scene, what was said,
   with the learner's recordings, and the feedback in the shape that kind
   gets. One still open is exported as far as it has got. */
export function conversationExport(session, { audio = new Map(), withAudio = true } = {}) {
  const lang = languageCode(session.language);
  const live = isLive(session);
  const fb = session.feedback;
  const paths = audioPaths('conversation', session);
  const parts = [sceneHtml(session, lang)];
  if (live && fb) {
    parts.push(liveFeedbackHtml(session, fb, lang, audio, withAudio));
  } else {
    if (live && session.take) {
      parts.push(`<h2>The recording${session.talked ? ` · ${e(minutesLabel(session.talked))}` : ''}</h2>`);
      parts.push(player(session.take, audio, withAudio, 'The recording of the conversation'));
    }
    parts.push(turnsHtml(session, lang, audio, withAudio));
    if (fb) parts.push(turnFeedbackHtml(session, fb, lang));
    else parts.push(`<p class="meta">${session.ended ? 'The feedback on this conversation could not be fetched.' : 'This conversation has no feedback yet.'}</p>`);
  }
  const kind = contentOf(session) === 'findout' ? 'a find out' : 'a roleplay';
  return {
    filename: fileName('conversation', session),
    html: page({
      title: session.title || 'Conversation',
      lang,
      meta: [
        `Conversation: ${kind}, ${live ? 'held live' : 'turn by turn'}`, session.created, session.language, session.level,
        live ? (session.talked ? `${minutesLabel(session.talked)} talked` : '') : `${(session.turns || []).filter((t) => t.speaker === 'learner').length} of ${turnsOf(session)} turns`,
        session.ended ? '' : 'not finished',
      ],
      body: parts.join('\n'),
      audioCount: paths.length,
      withAudio,
      missing: withAudio ? count(audio, paths) : 0,
    }),
  };
}
