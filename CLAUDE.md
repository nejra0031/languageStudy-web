# CLAUDE.md

Guidance for working on this repository. The README is the user-facing
documentation and describes every feature; read it first. This file covers
what the README does not: how the code is put together, the rules it keeps,
and how to check a change.

## What this is

A static page — flashcards, typing, dictation and shadowing for any language —
served as-is from GitHub Pages. No build step, no dependencies, no server, no
package.json. Plain ES modules in `js/`, one stylesheet, one `index.html`.
Keep it that way: a change that needs a bundler, an npm package or a backend
is the wrong change.

```sh
python3 -m http.server 8000        # preview; modules do not load from file://
node --test "test/*.test.mjs"      # unit tests, Node's built-in runner
```

## How the code is laid out

- `app.js` boots the page and switches tabs. Each `tab-*.js` owns one panel and
  its DOM, and exports `init()` and optionally `onShow()`.
- `store.js` is the shared state: settings, every deck, the dictation bank,
  the call budget. Tabs read `store.state` and call the store's save
  functions; **a tab never touches storage directly.** Subscribers are told
  after each change (`subscribe('settings' | 'deck' | 'folder' | 'quota' |
  'bank' | 'shadow')`).
  Practice spans every ticked deck, so a card is written back to its *own*
  deck: `store.deckOf(card)`, `store.saveCardDecks(card)`.
- `storage.js` is one directory, laid out the same wherever it lives. It picks
  a backend: `fs-folder.js` (a folder the user chose, Chromium only) or
  `fs-opfs.js` (the origin private file system, every browser). Both hand back
  a `FileSystemDirectoryHandle`, so nothing above `storage.js` can tell them
  apart.
- `deck.js` is the deck format and scoring. **`recordResult` is the only place
  the scoring rules live**; both practice tabs call it, and a changed verdict
  is re-recorded through `amendLastToRight`, never by editing `score` or
  `recent` directly.
- `text.js` compares answers in tiers. `normalize` (case and punctuation
  folded, **diacritics kept**) decides correctness; `base` (diacritics
  stripped) is only ever used to *align* words, so a missed accent reads as
  "this word, wrong accent" rather than a wrong word. Never judge correctness
  on `base`.
- `gemini.js` talks to the Gemini API from the page with the user's key, and
  counts calls per model locally before any request goes out.
- `speech.js` is the device's own text-to-speech, not Gemini: free, instant,
  offline. `recorder.js` is the microphone.
- `zip.js` and `bundle.js` are the two backups: a zip laid out like the data
  folder (keeps the audio), and one readable JSON file (decks and settings).
- `shadowing.js` is Shadowing's pure logic; `tab-shadowing.js` its DOM.

## Rules the code keeps

- **The API key lives in `localStorage` only.** It is never written to the data
  directory, a backup or a bundle, so a folder that is a git clone, or a
  backup mailed to oneself, cannot leak it.
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

## Conventions

- Comments explain *why*, in full sentences, and are generous where a choice is
  not obvious. Match the surrounding density.
- User-visible changes update the README in the same commit; it is the
  documentation.
- UI labels are sentence case ("Show answer", "Listen again").
- Commits: an imperative subject, then a body in prose saying why the change
  is right, what it deliberately does not do, and anything found on the way.
  One logical change per commit.

## Checking a change in a browser

Unit tests cover the modules without a DOM — `deck.js`, `text.js`,
`gemini.js`, the model catalogue, `speech.js`, `zip.js`, `bundle.js`,
`opus.js`, `convert-audio.js` and `shadowing.js` — not the tabs. For anything a user sees, drive the
real page. Playwright's WebKit is Safari's engine and works well; some quirks
cost time the first time:

- Playwright's WebKit keeps a site's OPFS outside the profile folder, so
  settings and decks carry over between runs on the same origin. Serve each
  run on a fresh port.
- OPFS needs a persistent context (`webkit.launchPersistentContext`); a plain
  `launch()` cannot save, and the app then says so.
- Headless browsers have no speech voices. Stub `window.speechSynthesis` and
  `SpeechSynthesisUtterance` with an init script to see what would be said.
- The repo has no package.json, so Node detects the modules as ESM. Running
  tests from under a directory whose package.json says `"type": "commonjs"`
  makes every module fail to parse.
- Safari keeps old copies of the modules; reload with ⌥⌘R after a change.
