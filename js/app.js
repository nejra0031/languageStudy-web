/* Boot and tab switching. */

import * as store from './store.js';
import * as speech from './speech.js';
import * as settings from './tab-settings.js';
import * as flashcards from './tab-flashcards.js';
import * as typing from './tab-typing.js';
import * as dictation from './tab-dictation.js';
import * as shadowing from './tab-shadowing.js';
import * as reading from './tab-reading.js';
import * as lookup from './lookup-popup.js';

const TABS = {
  settings: { module: settings },
  flashcards: { module: flashcards },
  typing: { module: typing },
  dictation: { module: dictation },
  shadowing: { module: shadowing },
  reading: { module: reading },
};

function show(name) {
  for (const [key, { module }] of Object.entries(TABS)) {
    const leaving = key !== name;
    const panel = document.getElementById('panel-' + key);
    /* A tab being hidden gets told, because one of them holds a microphone
       open and a stream left running keeps the browser's recording indicator
       lit — something really would still be listening. */
    if (leaving && !panel.hidden && module.onHide) module.onHide();
    panel.hidden = leaving;
    document.getElementById('tab-' + key).setAttribute('aria-selected', String(!leaving));
  }
  try { localStorage.setItem('lsw.tab', name); } catch (e) { /* ignore */ }
  const mod = TABS[name].module;
  if (mod.onShow) mod.onShow();
}

function wireTabs() {
  document.querySelector('.tabs').addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    if (btn.dataset.soon) comingSoon(btn);
    else show(btn.dataset.tab);
  });

  /* Arrow keys walk the tab strip, as a tablist should. */
  document.querySelector('.tabs').addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const names = Object.keys(TABS);
    const here = names.findIndex((n) => document.getElementById('tab-' + n).getAttribute('aria-selected') === 'true');
    const next = names[(here + (e.key === 'ArrowRight' ? 1 : names.length - 1)) % names.length];
    show(next);
    document.getElementById('tab-' + next).focus();
  });
}

/* A planned mode's tab has no panel, so clicking it leaves the current tab
   where it is and says why under the button for a moment. One note, reused,
   so clicking several in a row never stacks them up. */
let soonTimer = 0;
function comingSoon(btn) {
  let note = document.getElementById('soon-note');
  if (!note) {
    note = document.createElement('div');
    note.id = 'soon-note';
    note.className = 'soon-note';
    note.setAttribute('role', 'status');
    document.body.append(note);
  }
  note.textContent = `${btn.dataset.soon} is coming soon. Check back later.`;
  note.hidden = false;
  const r = btn.getBoundingClientRect();
  const left = Math.min(r.left, window.innerWidth - note.offsetWidth - 8);
  note.style.left = `${Math.max(8, left)}px`;
  note.style.top = `${r.bottom + 6}px`;
  clearTimeout(soonTimer);
  soonTimer = setTimeout(() => { note.hidden = true; }, 2500);
}

function wireTheme() {
  const btn = document.getElementById('theme-btn');
  const apply = (theme) => {
    document.documentElement.dataset.theme = theme;
    btn.textContent = theme === 'dark' ? 'Light' : 'Dark';
  };
  apply(store.state.settings.theme === 'light' ? 'light' : 'dark');
  btn.addEventListener('click', () => {
    const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    apply(next);
    store.saveSettings({ theme: next });
  });
  store.subscribe('settings', (s) => apply(s.settings.theme === 'light' ? 'light' : 'dark'));
}

async function boot() {
  store.bootLocal();
  /* Azure clips are saved into the data directory, like Dictation's audio. */
  speech.setClipStore({ read: store.readVoiceClip, write: store.writeVoiceClip, count: store.countVoiceClips });
  wireTabs();
  wireTheme();

  for (const { module } of Object.values(TABS)) module.init();
  /* Not a tab: it opens over whichever tab holds the text that was selected. */
  lookup.init();

  let start = 'settings';
  try { start = localStorage.getItem('lsw.tab') || 'settings'; } catch (e) { /* ignore */ }
  show(TABS[start] ? start : 'settings');

  /* Last, because it may adopt a store and re-render everything. Ready
     either way: a store that could not be opened still leaves the app
     running on what it has. */
  try {
    await settings.restoreStore();
  } finally {
    store.markReady();
  }
}

boot();
