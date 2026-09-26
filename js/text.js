/* Text comparison for practice answers and dictation transcriptions.

   Three tiers, and keeping them apart is the whole point:
     normalize  — NFC, case-folded, punctuation stripped. Diacritics KEPT.
                  This is the form correctness is judged on.
     base       — NFD with combining marks removed, plus đ→d. Used ONLY to
                  align two sentences against each other, never to decide
                  whether a word is right.
     raw        — what gets displayed back to the user.

   Aligning on base forms is what turns a missed accent into "this word, wrong
   accent" instead of "missing word + extra word", which is a far more useful
   thing to show a learner. */

const PUNCT = /[.,!?;:"'“”‘’…()\[\]{}«»\-–—]/g;

export function normalize(s) {
  return String(s || '')
    .normalize('NFC')
    .toLowerCase()
    .replace(PUNCT, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function words(s) {
  const n = normalize(s);
  return n ? n.split(' ') : [];
}

/* Diacritic-insensitive base form. NFD decomposes Vietnamese's stacked tone
   marks, Spanish acutes and German umlauts alike into U+0300–U+036F, so one
   rule covers them all. đ/Đ has no decomposition, hence the explicit pass.
   Lowercases on its own so it is correct when called outside normalize(). */
export function base(w) {
  return String(w || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd');
}

/* A card's front can be a pattern rather than a phrase: "hễ … là …",
   "không những … mà còn …", "A mà B". A gap means any words may go there, so
   a sentence uses the pattern when its fixed parts appear in order, each one
   word for word. Without this, a pattern with a gap in the middle could never
   be found in a real sentence — "hễ là" is not something anyone says.

   An ellipsis (… or ...) is a gap wherever it appears. A lone capital Latin
   letter is a gap only when the caller says the front is a pattern (the
   card's type, see deck.js): on any other card it may be a real word —
   Spanish "A veces", "Y tú" — and guessing which would be a rule for some
   languages and not others. Parentheticals are usage notes, not part of the
   string to match, so "đóng (học phí)" is matched on "đóng".

   Returns the fixed parts as word lists; a plain phrase is one part. */
const GAP = /…|\.{3,}/g;
const SLOT = /(?<![\p{L}\p{N}])[A-Z](?![\p{L}\p{N}])/gu;

export function termPieces(term, pattern = false) {
  let t = String(term || '').replace(/\([^)]*\)/g, ' ');
  if (pattern) t = t.replace(SLOT, ' … ');
  return t.split(GAP).map(words).filter((p) => p.length);
}

/* Each piece found whole, after the one before it. Taking the earliest place
   each piece fits leaves the most room for the rest, so this finds a match
   whenever there is one. */
function inOrder(haystack, pieces) {
  if (!pieces.length) return false;
  let from = 0;
  for (const piece of pieces) {
    let at = -1;
    for (let i = from; i + piece.length <= haystack.length; i++) {
      let hit = true;
      for (let k = 0; k < piece.length; k++) {
        if (haystack[i + k] !== piece[k]) { hit = false; break; }
      }
      if (hit) { at = i; break; }
    }
    if (at === -1) return false;
    from = at + piece.length;
  }
  return true;
}

/* True when the term appears once accents are ignored — the word was heard,
   whether or not its marks were. Built on the same pieces as contains(), so
   it agrees with it on everything except the accents. */
export function containsLoosely(haystack, term, pattern = false) {
  return inOrder(haystack.map(base), termPieces(term, pattern).map((p) => p.map(base)));
}

/* True when the term appears verbatim — accents and all — somewhere in
   `haystack`: a phrase as a run of words, a pattern as its parts in order. */
export function contains(haystack, term, pattern = false) {
  return inOrder(haystack, termPieces(term, pattern));
}

/* Longest common subsequence over base forms, returned as index pairs. */
export function align(ref, usr) {
  const a = ref.map(base);
  const b = usr.map(base);
  const n = a.length;
  const m = b.length;
  const dp = [];
  for (let i = 0; i <= n; i++) dp.push(new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const pairs = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { pairs.push([i, j]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++;
    else j++;
  }
  return pairs;
}

/* Word-level diff of a transcription against the reference sentence.
   Returns tokens [{kind, text}] plus counts. Kinds:
     ok      — matched, identical
     accent  — matched on base form but the accents differ
     missing — in the reference, never typed
     extra   — typed, not in the reference */
export function diff(refWords, usrWords) {
  const pairs = align(refWords, usrWords);
  const refMatch = new Map();
  const usrMatch = new Map();
  for (const [i, j] of pairs) { refMatch.set(i, j); usrMatch.set(j, i); }

  const tokens = [];
  const counts = { ok: 0, accent: 0, missing: 0, extra: 0 };
  let i = 0;
  let j = 0;
  const emit = (kind, text) => { tokens.push({ kind, text }); counts[kind]++; };

  while (i < refWords.length || j < usrWords.length) {
    if (i < refWords.length && refMatch.get(i) === j) {
      emit(refWords[i] === usrWords[j] ? 'ok' : 'accent', usrWords[j]);
      i++; j++;
    } else if (j < usrWords.length && !usrMatch.has(j)) {
      emit('extra', usrWords[j]); j++;
    } else if (i < refWords.length && !refMatch.has(i)) {
      emit('missing', refWords[i]); i++;
    } else if (i < refWords.length) i++;
    else j++;
  }
  return { tokens, ...counts };
}

/* How a single typed answer compares to the expected one.
   'exact'  — same once case and punctuation are ignored
   'accent' — the right word with the wrong accents; still wrong, but the user
              should be told which of the two mistakes they made
   'wrong'  — neither */
export function compareAnswer(typed, expected) {
  const a = normalize(typed);
  const b = normalize(expected);
  if (!a) return 'wrong';
  if (a === b) return 'exact';
  if (base(a) === base(b)) return 'accent';
  return 'wrong';
}

/* A meaning is judged more loosely than a word, and deliberately so. A card's
   back is written to be read, not typed back verbatim — in practice it looks
   like "to go back; to return" or "to deal with (penalise)". So, for meanings
   only:

     - each part between semicolons is a meaning on its own;
     - a bracketed note is context, and may be left out;
     - a leading "to" on a verb is optional.

   Commas are deliberately NOT split on. In a sentence or a pattern a comma is
   grammar — "If I were him, I'd have quit" — and accepting one half of that
   would be accepting a wrong answer. */
export function meaningVariants(meaning) {
  const noNotes = (s) => String(s).replace(/\([^)]*\)/g, ' ');
  const parts = String(meaning || '').split(';');
  const all = [meaning, noNotes(meaning), ...parts, ...parts.map(noNotes)];
  return [...new Set(all.map((v) => String(v).trim()).filter((v) => normalize(v)))];
}

function dropTo(s) {
  return normalize(s).replace(/^to /, '');
}

/* 'exact', 'accent' or 'wrong', the best over every way of reading the
   meaning. The same three verdicts compareAnswer gives, so the UI can treat a
   typed meaning and a typed word alike. */
export function compareMeaning(typed, meaning) {
  const t = dropTo(typed);
  if (!t) return 'wrong';
  let best = 'wrong';
  for (const v of meaningVariants(meaning)) {
    const verdict = compareAnswer(t, dropTo(v));
    if (verdict === 'exact') return 'exact';
    if (verdict === 'accent') best = 'accent';
  }
  return best;
}

/* The best verdict over every accepted answer, and the answer it was given
   against: the first exact one, else the first accent-only one, else the
   first answer. The match is what an accent miss is marked against, since
   the accents went astray from that answer and not from the card's own
   side. `compare` is compareAnswer for a word and compareMeaning for a
   meaning. */
export function bestMatch(typed, options, compare) {
  let accent = null;
  for (const o of options) {
    const verdict = compare(typed, o);
    if (verdict === 'exact') return { verdict, match: o };
    if (verdict === 'accent' && accent === null) accent = o;
  }
  return accent !== null ? { verdict: 'accent', match: accent } : { verdict: 'wrong', match: options[0] };
}

/* Character-level marks for an accent-only miss, so the offending letters can
   be highlighted. Lengths match because the base forms are equal. */
export function accentMarks(typed, expected) {
  const t = [...String(typed)];
  const e = [...String(expected)];
  if (t.length !== e.length) return t.map((ch) => ({ ch, bad: false }));
  return t.map((ch, k) => ({ ch, bad: ch.toLowerCase() !== e[k].toLowerCase() }));
}

/* A score, drawn in the app's own vocabulary: a square, then the word for it.
   Lives here rather than in a tab because both practice modes report moves. */
export function scoreMark(score, label) {
  return `<i class="score-dot s-${score}"></i>${label ? ' ' + escapeHtml(label) : ''}`;
}

export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
