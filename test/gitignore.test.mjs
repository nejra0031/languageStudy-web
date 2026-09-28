import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

/* A learner may point the app at a clone of this repo as their data folder,
   and then everything it writes sits in the working tree: their recordings,
   their writing, their conversations. .gitignore keeps all of it out of a
   commit, but only for the folders it names, and a folder added to the data
   layout later would be committed without a word. So the layout's own list
   is read from storage.js and checked against .gitignore. storage.js is read
   as text rather than imported, since it needs a browser. */

const root = new URL('../', import.meta.url);
const ignored = readFileSync(new URL('.gitignore', root), 'utf8')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith('#'));

function dataDirs() {
  const source = readFileSync(new URL('js/storage.js', root), 'utf8');
  const match = source.match(/const DATA_DIRS = \[([^\]]*)\]/);
  assert.ok(match, 'js/storage.js declares DATA_DIRS');
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('every folder the app writes data into is ignored by git', () => {
  const dirs = dataDirs();
  assert.ok(dirs.length > 0, 'DATA_DIRS lists at least one folder');
  for (const dir of dirs) {
    assert.ok(ignored.includes(`${dir}/`), `${dir}/ is in DATA_DIRS but not in .gitignore`);
  }
});

test('the settings file is ignored by git', () => {
  assert.ok(ignored.includes('settings.json'), 'settings.json is not in .gitignore');
});
