# CLAUDE.md

Guidance for working on this repository. The README is the user-facing
documentation and describes every feature; read it first. This file covers
what the README does not: how the code is put together, the rules it keeps,
and how to check a change.

## What this is

A static page — flashcards, typing, dictation, shadowing and reading for any
language — served as-is from GitHub Pages. No build step, no dependencies, no
server, no package.json. Plain ES modules in `js/`, one stylesheet, one `index.html`.
Keep it that way: a change that needs a bundler, an npm package or a backend
is the wrong change.

```sh
python3 -m http.server 8000        # preview; modules do not load from file://
node --test "test/*.test.mjs"      # unit tests, Node's built-in runner
```

## How the code is laid out

- `app.js` boots the page and switches tabs. Each `tab-*.js` owns one panel and
  its DOM, and exports `init()` and optionally `onShow()`. The tab strip is
  two groups, setup (Settings, Flashcards) and practice; a tab with
  `data-soon` is a planned mode with no panel, and clicking it only says it
  is coming soon (see *Planned modes* below).
- `store.js` is the shared state: settings, every deck, the dictation bank,
  the call budget. Tabs read `store.state` and call the store's save
  functions; **a tab never touches storage directly.** Subscribers are told
  after each change (`subscribe('settings' | 'deck' | 'folder' | 'quota' |
  'bank' | 'shadow' | 'reading')`), and once with `'ready'` when the first
  load is done.
  Practice spans every ticked deck, so a card is written back to its *own*
  deck: `store.deckOf(card)`, `store.saveCardDecks(card)`.
- `storage.js` is one directory, laid out the same wherever it lives. It picks
  a backend: `fs-folder.js` (a folder the user chose, Chromium only) or
  `fs-opfs.js` (the origin private file system, every browser). Both hand back
  a `FileSystemDirectoryHandle`, so nothing above `storage.js` can tell them
  apart.
- `deck.js` is the deck format and scoring. **`recordResult` is the only place
  the scoring rules live**; every practice tab calls it, and a changed verdict
  is re-recorded through `amendLastToRight` (or, in Reading,
  `amendLastToWrong`), never by editing `score` or `recent` directly.
- `text.js` compares answers in tiers. `normalize` (case and punctuation
  folded, **diacritics kept**) decides correctness; `base` (diacritics
  stripped) is only ever used to *align* words, so a missed accent reads as
  "this word, wrong accent" rather than a wrong word. Never judge correctness
  on `base`.
- `defaults.js` holds every default: settings, prompts, the Gemini voice
  list and the starter deck. Settings from disk are merged over it, so a new
  key needs only a default here.
- `gemini.js` talks to the Gemini API from the page with the user's key, and
  counts calls per model locally before any request goes out. What the speech
  model is given is built by `speechText`, which adds the register or dialect
  note for audio in code, so a rewritten speech prompt cannot drop it.
- `speech.js` is the device's own text-to-speech, not Gemini: free, instant,
  offline. `azure-tts.js` is Azure's neural voices, optional, with the user's
  own key, called from the page like Gemini. `recorder.js` is the microphone.
- `zip.js` and `bundle.js` are the two backups: a zip laid out like the data
  folder (keeps the audio), and one readable JSON file (decks and settings).
  `backup-due.js` decides when to remind someone using browser storage to
  take one.
- `opus.js` wraps WebCodecs' Opus packets in Ogg, so generated audio is saved
  at a twelfth of WAV's size; `convert-audio.js` converts an older bank's WAVs
  in an order that never leaves a sentence without playable audio.
- `shadowing.js` is Shadowing's pure logic; `tab-shadowing.js` its DOM.
- `reading.js` is Reading's pure logic: the presets, which cards a text uses,
  and parsing the reply. The model marks each use of a card as
  `[[number|words as written]]`, so an inflected form or a split pattern still
  points at its card. `tab-reading.js` is the text and its word popup, which
  borrows the selection popup's styles and `placeUnder`. A verdict is given
  before the meaning is shown, so a change of mind can go either way: back
  through `amendLastToRight` or `amendLastToWrong`. Texts are kept in
  `reading/` (an index, one JSON per text, and its audio once read aloud),
  written and deleted through the store; answers are not kept with a text.
  New audio replaces old only after it is written, and deleting the audio
  alone rewrites the text before the file goes.
- The selection popup (Add from selected text) is not a tab: it opens over
  whichever tab holds the selected text. `lookup.js` is its pure logic
  (which way round, is the word a card already, the sentence around it),
  `translate.js` the one request to Google Translate's keyless endpoint, and
  `lookup-popup.js` its DOM, started by `app.js` after the tabs. A card it
  adds goes through `store.addCard`, so its deck is recorded like any other
  card's; an Update changes the meaning, the notes and the pattern mark
  (`deck.setPattern`, which never removes a `type` it did not set) only.
- `shadow-rules.js` is the per-language listening rules the shadowing model
  grades by: seeded once per language, rated note by note, revised from the
  ratings. The ratings are the only signal. A malformed seed or revision
  reply changes nothing, and a rule the user wrote is never dropped or
  reworded by a revision. `store.js` runs the loop; the tabs only call it.

## Rules the code keeps

- **API keys live in `localStorage` only** (Gemini's and Azure's). They are
  never written to the data directory, a backup or a bundle, so a folder that is a git clone, or a
  backup mailed to oneself, cannot leak them.
- **The deck file is the UI.** The Flashcards tab shows exactly what is stored.
  Fields the app does not know are carried through every save untouched, so
  never drop unknown keys, and never add app-internal state to a card (the
  deck a card belongs to is tracked in memory, not written to it).
- **Nothing is language-specific.** The target language comes from settings;
  accent handling works for any script through Unicode normalisation. Do not
  add rules that only make sense for one language.
- **Every browser.** Safari and Firefox are first-class. Feature-detect, and
  when something is missing say so in the UI rather than failing silently.
- **Logic that can be a plain function is one**, in a module with no DOM, so
  `node --test` can cover it. The DOM stays in the `tab-*.js` files.
- **Every release carries one version.** GitHub Pages lets browsers cache each
  file for ten minutes, so `index.html` pins every module to `?v=<version>`
  through an import map, and the entry script and stylesheet carry the same
  `?v=`. Any change under `js/` or `css/` bumps that version everywhere it
  appears in `index.html` (find and replace). A new module also needs its own
  line in the import map. `test/importmap.test.mjs` fails when either is
  forgotten.

## Conventions

- Comments explain *why*, in full sentences, and are generous where a choice is
  not obvious. Match the surrounding density.
- User-visible changes update the README in the same commit; it is the
  documentation.
- UI labels are sentence case ("Show answer", "Listen again").
- Commits: an imperative subject, then a body in prose saying why the change
  is right, what it deliberately does not do, and anything found on the way.
  One logical change per commit.

## Planned modes

Three more practice modes are planned: **Writing**, **Translate** and
**Conversation** (typed, then spoken turns). Their tabs are already in the
strip, greyed out as coming soon. The plan is written in full in
`practice-mode-port.md` at the repo root, a working note kept out of git (see
`.gitignore`): it adapts lessons-web's modes to decks, settings and the model
catalogue, phase by phase, with the tests each needs. None of it is coded yet;
that comes later. When a mode is built, follow the plan, drop the tab's
`data-soon`, give it a panel, and update this file and the README in the same
commit.

## Checking a change in a browser

Unit tests cover the modules without a DOM — `deck.js`, `text.js`,
`gemini.js`, the model catalogue, `speech.js`, `azure-tts.js`, `zip.js`,
`bundle.js`, `backup-due.js`, `opus.js`, `convert-audio.js`, `shadowing.js`,
`shadow-rules.js`, `lookup.js` and `reading.js` — not the tabs. For anything a
user sees, drive the real page. Playwright's WebKit is Safari's engine and works well; some quirks
cost time the first time:

- Playwright's WebKit keeps a site's OPFS outside the profile folder, so
  settings and decks carry over between runs on the same origin. Serve each
  run on a fresh port.
- OPFS needs a persistent context (`webkit.launchPersistentContext`); a plain
  `launch()` cannot save, and the app then says so.
- On Windows, Playwright's WebKit does not keep what `createWritable` writes
  to OPFS: a file written and read straight back is empty, even through the
  raw API. Anything that reads a file back — reopening a shadowing set, a
  deck after reload — fails there with a JSON parse error that is not the
  app's. Check those steps in Chromium instead
  (`chromium.launchPersistentContext(dir, { channel: 'chromium' })`), whose
  OPFS works; real Safari runs a different WebKit.
- Headless browsers have no speech voices. Stub `window.speechSynthesis` and
  `SpeechSynthesisUtterance` with an init script to see what would be said.
- The repo has no package.json, so Node detects the modules as ESM. Running
  tests from under a directory whose package.json says `"type": "commonjs"`
  makes every module fail to parse.
- Safari keeps old copies of the modules; reload with ⌥⌘R after a change.
