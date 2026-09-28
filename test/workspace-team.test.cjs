'use strict';

/**
 * The Team screen and the join-code path that feeds it.
 *
 * Nothing here needs a display: these are the checks that keep a nav entry from
 * pointing at a missing string (a blank item in the rail) and keep an error the
 * main process can return from reaching the renderer as a raw key like
 * `team.joinCode.badToken` printed on screen. Both failures are silent in
 * development and obvious in a screenshot.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const locale = (code) => JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`));

const LOCALES = ['en', 'ar', 'zh-CN'];
const LOCALES_LOADED = Object.fromEntries(LOCALES.map((c) => [c, locale(c)]));

function get(obj, key) {
  return key.split('.').reduce((v, k) => (v == null ? v : v[k]), obj);
}

const SHELL = read('src/renderer/src/components/workspace/WorkspaceShell.tsx');
const TAB = read('src/renderer/src/components/workspace/TeamTab.tsx');
const CODEC = read('src/shared/relayCode.ts');

/** Every literal key passed to `t(...)` in a source string. */
function tKeys(src) {
  const out = new Set();
  for (const m of src.matchAll(/\bt\(\s*'([^']+)'/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) out.add(m[1]);
  for (const m of src.matchAll(/labelKey:\s*'([^']+)'/g)) out.add(m[1]);
  for (const m of src.matchAll(/titleKey="([^"]+)"/g)) out.add(m[1]);
  for (const m of src.matchAll(/subKey="([^"]+)"/g)) out.add(m[1]);
  for (const m of src.matchAll(/\bsay\(\s*'([^']+)'/g)) out.add(m[1]);
  return out;
}

test('every screen in the shell has a nav entry, and the other way round', () => {
  const unionMatch = SHELL.match(/export type WorkspaceScreen =([\s\S]*?);/);
  assert.ok(unionMatch, 'WorkspaceScreen union not found');
  const members = unionMatch[1]
    .replace(/\|/g, ' ')
    .split(/\s+/)
    .map((s) => s.trim().replace(/^'|'$/g, ''))
    .filter(Boolean);

  const navKeys = [...SHELL.matchAll(/\{\s*key:\s*'([^']+)',\s*labelKey:\s*'([^']+)',\s*icon:\s*'([^']+)'\s*\}/g)]
    .map((m) => ({ key: m[1], labelKey: m[2], icon: m[3] }));

  assert.deepEqual(navKeys.map((n) => n.key).sort(), [...members].sort(),
    'NAV and the WorkspaceScreen union have drifted — a screen would render blank');

  for (const n of navKeys) {
    assert.ok(n.icon, `${n.key} has no icon`);
    assert.equal(typeof n.icon, 'string');
  }
});

test('every nav label and Team string exists in en, ar and zh-CN', () => {
  const keys = [...tKeys(SHELL), ...tKeys(TAB)];
  assert.ok(keys.length >= 20, `only ${keys.length} literal keys found — the extractor is not matching`);
  const missing = [];
  for (const key of keys) {
    if (key.includes('${')) continue; // built at runtime; covered below
    for (const code of LOCALES) {
      const v = get(LOCALES_LOADED[code], key);
      if (typeof v !== 'string' || !v.trim()) missing.push(`${code}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], 'a literal key would render as the raw key on screen');
});

test('every connection state has a label in every locale', () => {
  for (const code of LOCALES) {
    const states = LOCALES_LOADED[code].team?.state ?? {};
    for (const s of ['idle', 'connecting', 'authenticating', 'online', 'backoff', 'rejected']) {
      assert.equal(typeof states[s], 'string', `${code} is missing team.state.${s}`);
    }
  }
  // The badge fill map is the other half of that lookup: a state with a label
  // but no colour renders on a transparent chip.
  const fills = [...TAB.matchAll(/(idle|connecting|authenticating|online|backoff|rejected):\s*'var\(/g)]
    .map((m) => m[1]);
  assert.deepEqual([...new Set(fills)].sort(),
    ['authenticating', 'backoff', 'connecting', 'idle', 'online', 'rejected']);
});

test('every error the relay IPC can return has a translated line', () => {
  // The JoinCodeError union in the codec…
  const union = CODEC.match(/export type JoinCodeError =([\s\S]*?);/);
  assert.ok(union, 'JoinCodeError union not found');
  const codecErrors = union[1]
    .replace(/\|/g, ' ')
    .split(/\s+/)
    .map((s) => s.replace(/'/g, '').trim())
    .filter(Boolean);
  assert.ok(codecErrors.length >= 7, `only ${codecErrors.length} codec errors found`);

  // …plus the two the main-process handlers invent themselves. Scoped to the
  // join handlers so a new `error:` literal from anywhere else in index.ts
  // cannot masquerade as coverage here.
  const index = read('src/main/index.ts');
  const from = index.indexOf("ipcMain.handle('relay:joinCode'");
  const apply = index.indexOf("ipcMain.handle('relay:applyJoinCode'");
  assert.ok(from >= 0, 'main never registers relay:joinCode');
  assert.ok(apply > from, 'main never registers relay:applyJoinCode');
  const region = index.slice(from, apply + 1200);
  const ipcErrors = [...region.matchAll(/error: '([a-zA-Z]+)'/g)].map((m) => m[1]);

  const expected = [...new Set([...codecErrors, ...ipcErrors])].sort();
  assert.deepEqual([...ipcErrors].sort(), ['notConfigured', 'tokenNotStored'],
    'the join handlers gained a new error string — translate it too');

  const enTeam = LOCALES_LOADED.en.team ?? {};
  const actual = Object.keys(enTeam.joinCode ?? {}).sort();
  assert.deepEqual(actual, expected, 'team.joinCode does not cover the errors main can return');
  for (const code of LOCALES) {
    assert.deepEqual(Object.keys(LOCALES_LOADED[code].team.joinCode ?? {}).sort(), expected,
      `${code} joinCode keys drifted`);
  }
});

test('the join-code IPC channel exists on both sides of the bridge', () => {
  const index = read('src/main/index.ts');
  const preload = read('src/preload/index.ts');
  for (const ch of ['relay:joinCode', 'relay:applyJoinCode']) {
    assert.ok(index.includes(`ipcMain.handle('${ch}'`), `main never registers ${ch}`);
    assert.ok(preload.includes(`invoke('${ch}'`), `preload never calls ${ch}`);
  }
  for (const fn of ['relayJoinCode', 'relayApplyJoinCode', 'relayRestart', 'relayStatus']) {
    assert.match(preload, new RegExp(`\\b${fn}:`), `preload is missing ${fn}`);
    assert.ok(TAB.includes(`cth.${fn}(`), `TeamTab never calls ${fn}`);
  }
});

test('the seat token is never read back into the renderer', () => {
  // A `relayGetSeatToken` would be the one change that turns a write-only
  // credential into an exfiltratable one, so assert the shape rather than
  // trusting the review.
  const preload = read('src/preload/index.ts');
  assert.ok(!/relayGetSeatToken|relaySeatToken\s*:/.test(preload),
    'preload must not offer a way to read the seat token back');
  assert.ok(preload.includes('relayHasSeatToken'), 'the boolean check is the allowed shape');
  // The field is masked and starts empty; it is never seeded from config.
  assert.ok(!TAB.includes('config.relay?.seatToken'), 'a seat token would be sitting in renderer state');
});
