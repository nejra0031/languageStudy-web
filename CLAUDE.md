# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

The README is the user-facing documentation and describes every feature;
read it first. This file covers what the README does not: how the code is put
together, the rules it keeps, and how to check a change.

## What this is

A static page — flashcards, typing, dictation, shadowing, reading, writing,
translation and conversation for any language — served as-is from GitHub
Pages. No build step, no dependencies, no server, no package.json. Plain ES
modules in `js/`, one stylesheet, one `index.html`. Keep it that way: a change
that needs a bundler, an npm package or a backend is the wrong change.

```sh
python3 -m http.server 8000                    # preview; modules do not load from file://
node --test "test/*.test.mjs"                  # every unit test, Node's built-in runner
node --test test/deck.test.mjs                 # one file
node --test --test-name-pattern="accent" "test/*.test.mjs"   # tests whose name matches
```

GitHub Actions runs the same tests on every push and pull request
(`.github/workflows/test.yml`), and `main` accepts only commits whose `test`
job passed. Contributors' branches take a prefix, `<username>/<topic>`.

## How the code is laid out

- `app.js` boots the page and switches tabs. Each `tab-*.js` owns one panel and
  its DOM, and exports `init()` and optionally `onShow()` and `onHide()`. The
  tab strip is two groups, setup (Settings, Flashcards) and practice.
- `store.js` is the shared state: settings, every deck, the dictation bank,
  the call budget. Tabs read `store.state` and call the store's save
  functions; **a tab never touches storage directly.** Subscribers are told
  after each change (`subscribe('settings' | 'deck' | 'folder' | 'quota' |
  'bank' | 'shadow' | 'reading' | 'writing' | 'conversation')`), and once
  with `'ready'` when the first load is done. Writing and conversations are
  kept by one `keeper()` in the store, the way reading texts are: a file per
  record beside an index, the file written first, held in memory when
  nothing is being saved.
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
  counts calls per model locally before any request goes out. Every call
  site is a job of its own in `MODEL_ROLES` (`defaults.js`): key, label, what
  it does, the Settings section its dropdown sits in, and the job an older
  settings file gives it the model of. A new call gets a new job there, and
  goes through `jobCall(job, …)`, which refuses before spending and makes
  exactly one call; `store.jobUsage(job)` is its budget.
  Grading prompts without `{feedback}` get the Feedback language and style
  block appended by `withFeedbackBlock`. What the speech
  model is given is built by `speechText`, which adds the register or dialect
  note for audio in code, so a rewritten speech prompt cannot drop it.
- `tab-settings.js` is one accordion: a `<details data-acc>` per section,
  and a Prompts panel inside some, whose open state is kept in localStorage
  (`lsw.settingsOpen`), never in `settings.json`. A section's job dropdowns
  are drawn from `MODEL_ROLES` into its `data-roles` element; its prompts are
  listed in `PROMPT_VIEWS` with a preview function in `PREVIEWS`. A new
  setting goes in the section of the mode it belongs to, with a default in
  `defaults.js` and a line in that section's summary (`renderSummaries`).
  Anything with `data-open-sec="<section>"`, on any tab, opens that section.
- `speech.js` is the device's own text-to-speech, not Gemini: free, instant,
  offline. `azure-tts.js` is Azure's neural voices, optional, with the user's
  own key, called from the page like Gemini. Which reads is the
  `speechSource` switch ('device' or 'azure'); each side keeps its own pick
  (`speechVoice`, `azureVoice`), `voiceSetting(settings)` is what a caller
  passes to `speak()`, and `voiceStatus` is the plain function behind the
  line that says what will actually read and why. `recorder.js` is the microphone.
- `zip.js` and `bundle.js` are the two backups: a zip laid out like the data
  folder (keeps the audio), and one readable JSON file (decks and settings).
  `backup-due.js` decides when to remind someone using browser storage to
  take one.
- `opus.js` wraps WebCodecs' Opus packets in Ogg, so generated audio is saved
  at a twelfth of WAV's size; `convert-audio.js` converts an older bank's WAVs
  in an order that never leaves a sentence without playable audio.
- `json-reply.js` reads a grader's reply: `extractTrailingJson` (an object,
  after any prose) and `extractJsonArray` (the first array), both null on
  anything unreadable, and `cardVerdicts`, the one shape every graded mode
  reports cards in: `cards: [{number, verdict: 'right'|'wrong'|'absent',
  note}]`, numbered as the prompt listed them. A tab scores `right` and
  `wrong` through `recordResult` with `typedFront: false` and leaves `absent`
  alone.
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
- `writing.js` is Writing's pure logic: word bounds (the setting for an
  opinion piece, two thirds of it scaled by the source for a summary), the
  grading request and reading the feedback back. The grading prompt is the
  system instruction and holds nothing per call, so implicit prefix caching
  applies; the task, level, source, cards and writing are the user message.
  `readWritingGrade` gives feedback, `{valid:false, reason}` (a verdict that
  scores nothing) or null (a failure: the writing stays, Try again sends it
  again). `tab-writing.js` is the task, the box and the feedback; its
  `scoreVerdicts` and `cardsResultHtml` are shared with the other graded
  modes. Every hand-in is kept in `writing/`.
- `translation.js` is Translate's pure logic: a set (`translateItems`, six
  by default) drawn from the bank in `translateOrder`, Shadowing's order by
  default since a checked set shows every sentence, the
  request (every item, blanks included, keyed by id), reading the array
  back (`null` if it is not one; an item without a verdict is ungraded), and
  `translationScores`, which decides what moves. The bank is only read.
  `tab-translate.js` is the list and the check; a set is not kept.
- `conversation.js` is Conversation's pure logic: the budget a conversation
  needs by model (`callsNeeded`, `budgetProblem`, refused before the scene is
  written), reading the scene (`readScenario`, null on anything malformed),
  and every request and reply of both kinds: a roleplay's replies (plain
  text), its closing call (line and feedback in one) and its early end; a
  find-out's replies (with `revealed`, run through `normaliseIds`) and its
  conclusion, where found and missed are worked out in code. Only learner
  turns are graded. A session stores its number of turns as `maxTurns` when
  it starts (`turnsOf`), so a change in Settings never moves the end of one
  under way. A spoken turn is recorded with `recorder.js`, written to
  `conversation/<id>_<position>.<ext>` as soon as it stops, transcribed by
  the shadowing model (`transcribeRequest`; an empty transcript spends no
  turn), and a roleplay with recordings is graded by the shadowing model
  with `withDelivery`, which attaches the clips and asks for a delivery note
  judged by the language's listening rules. `tab-conversation.js` saves the session after every
  turn, the learner's turn before the call that answers it, resumes an open
  one when shown, and scores the cards once, when it ends with feedback.
  Its briefing (Start) is always on screen, above any conversation: a call
  for one conversation is kept in `out` by its id, not in the tab-wide
  `working` (which is only 'starting', 'talking' and 'saving'), and lands
  on its own record whichever conversation is on screen by then; `take()`
  offers Try again for whatever such a record still owes.
- A third kind, `'live'`, is durkle's Praat without its server: a find-out
  scene, then a timed spoken conversation over the Live API's WebSocket,
  opened from the page with the user's key. `live.js` is its pure logic
  (the partner's instruction, the setup and every message, reading what
  comes back, `createTranscript`, `liveGradeRequest`, `readLiveGrade`, and
  `liveScore`, which computes the percentage from four 0-4 bands, never
  asks for it); `gemini-live.js` the socket, with no SDK; `live-audio.js`
  the microphone as 16 kHz PCM through an AudioWorklet, 24 kHz playback and
  the MediaRecorder of the whole conversation; `live-session.js` the
  conversation from Start talking to the recording. `store.client.openLive`
  counts one call on `liveModel` before the socket opens. The recording is
  written to `conversation/<id>_live.<ext>` the moment it ends, before the
  grading call on `liveGradeModel`, which listens to it; a failure keeps it
  for Try again. The microphone is asked for before the socket, so a
  refusal costs nothing.
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
- **A new session can always be started.** The top of every practice tab
  starts a new one whatever state the current one is in, even with a call
  out for it: that call's answer is kept and scored on the session it was
  made for (Shadowing's `grading`, Writing's `grading`, Translate's
  `checking`, Conversation's `out`) and shown only if that session is still
  on screen. Only a live conversation under way holds Start back.
- **Conversation is with an AI model.** Its UI never calls the other side a
  person or a partner: the model plays a role, named by `llmRole`, and the
  scene says so. The prompts may speak of "the other person", since that is
  the fiction the model is asked to play.
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
- An error from something the learner waited on is shown where the wait
  was, not in the panel's error box at the top. Each tab keeps one error box
  and moves it with `errorSpot` (`error-spot.js`): its `showError` takes the
  element to show it after (the pressed button's row, the chat for a thinking
  bubble), and with none it goes home, for errors that belong to nothing in
  particular. A Try again button travels with it.
- Commits: an imperative subject, then a body in prose saying why the change
  is right, what it deliberately does not do, and anything found on the way.
  One logical change per commit.

## Where the graded modes came from

Writing, Translate and Conversation are ported from lessons-web (the
`praat-site` branch of the durkle repo), following a plan kept out of git as
`practice-mode-port.md`. Their prompts are lessons-web's with the Dutch, the
CEFR tables, scores and lesson content taken out, and each prompt's comment
in `defaults.js` says what was changed and why. Left out on purpose:
reading the typed partner's lines aloud, a microphone check screen, numeric
scores and any per-language cleanup. Praat, the live voice conversation, was
left out at first for want of a WebSocket client; it is now the live kind of
Conversation (see above), ported from durkle's `praat-site` branch, and its
percentage is the one numeric score, computed from bands in code. A new graded mode should follow
the same shape: prompts in `defaults.js` with a box in Settings, pure request
building and reply reading in a module of its own, `jobCall` on one job's
model, card verdicts through `cardVerdicts`, and one call per press with a
Try again, never an automatic retry.

## Checking a change in a browser

Unit tests cover the modules without a DOM — `deck.js`, `text.js`,
`gemini.js`, the model catalogue, `speech.js`, `azure-tts.js`, `zip.js`,
`bundle.js`, `backup-due.js`, `opus.js`, `convert-audio.js`, `shadowing.js`,
`shadow-rules.js`, `lookup.js`, `reading.js`, `json-reply.js`, `writing.js`,
`translation.js`, `conversation.js` and `live.js` with `gemini-live.js` —
not the tabs, and not `live-audio.js` or `live-session.js`, which need a
browser's audio. For anything a
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
- Chromium records from a fake microphone when launched with
  `--use-fake-ui-for-media-stream --use-fake-device-for-media-stream`, which
  is enough to drive Shadowing and spoken Conversation turns. To see the
  refused-microphone path, replace `navigator.mediaDevices.getUserMedia` in
  an init script with one that rejects.
- Stub `generativelanguage.googleapis.com` with `context.route` to check the
  graded modes without a key; tell the calls apart by their system
  instruction. A `waitForFunction` given an async function passes at once
  (the promise is truthy), so poll `store.state.ready` with `evaluate`.
- Headless browsers have no speech voices. Stub `window.speechSynthesis` and
  `SpeechSynthesisUtterance` with an init script to see what would be said.
- The repo has no package.json, so Node detects the modules as ESM. Running
  tests from under a directory whose package.json says `"type": "commonjs"`
  makes every module fail to parse.
- Safari keeps old copies of the modules; reload with ⌥⌘R after a change.
