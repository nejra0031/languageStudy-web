import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

/* index.html pins every module to one release version through an import map,
   so a deploy cannot leave a browser holding a new page and an old module.
   A module left out of the map would still load, from an unversioned URL a
   browser may have cached from the previous release, which is exactly the
   failure the map exists to prevent. Nothing would show it until a deploy
   broke someone's page, so these tests do. */

const root = new URL('../', import.meta.url);
const html = readFileSync(new URL('index.html', root), 'utf8');

function importMap() {
  const match = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
  assert.ok(match, 'index.html has an import map');
  return JSON.parse(match[1]).imports;
}

const versionOf = (url) => (String(url).match(/\?v=([^"&]+)$/) || [])[1];

test('every module in js/ except the entry script is in the import map', () => {
  const map = importMap();
  const modules = readdirSync(new URL('js/', root)).filter((f) => f.endsWith('.js') && f !== 'app.js');
  for (const file of modules) {
    assert.ok(map[`./js/${file}`], `js/${file} is missing from the import map in index.html`);
  }
  for (const key of Object.keys(map)) {
    assert.ok(modules.includes(key.replace('./js/', '')), `the import map names ${key}, which does not exist`);
  }
});

test('each entry maps a module to itself, versioned', () => {
  for (const [key, value] of Object.entries(importMap())) {
    assert.equal(value.replace(/\?v=[^"&]+$/, ''), key, `${key} must map to the same file`);
    assert.ok(versionOf(value), `${key} carries no ?v= version`);
  }
});

test('the map, the entry script and the stylesheet all carry one version', () => {
  const versions = new Set(Object.values(importMap()).map(versionOf));
  const entry = html.match(/<script type="module" src="js\/app\.js\?v=([^"]+)"/);
  const style = html.match(/<link rel="stylesheet" href="css\/app\.css\?v=([^"]+)"/);
  assert.ok(entry, 'the entry script is versioned');
  assert.ok(style, 'the stylesheet is versioned');
  versions.add(entry[1]);
  versions.add(style[1]);
  assert.equal(versions.size, 1, `index.html carries more than one version: ${[...versions].join(', ')}`);
});

test('the import map comes before the entry script', () => {
  /* A module script that starts loading before the map is parsed resolves
     without it, and the browser then ignores the map. */
  assert.ok(html.indexOf('type="importmap"') < html.indexOf('type="module"'));
});
