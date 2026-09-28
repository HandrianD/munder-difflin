'use strict';

/**
 * The cross-machine DM half of the Inbox: the archive read path, the badge
 * bookkeeping, and the wiring that keeps a key typo from rendering as a raw
 * `remoteDms.foo` on screen.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const locale = (code) => JSON.parse(read(`src/renderer/src/i18n/locales/${code}.json`));

const LOCALES = ['en', 'ar', 'zh-CN'];

const PANEL = read('src/renderer/src/components/workspace/RemoteDmsPanel.tsx');
const SEEN = read('src/renderer/src/components/workspace/remoteDmSeen.ts');
const SHELL = read('src/renderer/src/components/workspace/WorkspaceShell.tsx');

function get(obj, key) {
  return key.split('.').reduce((v, k) => (v == null ? v : v[k]), obj);
}

test('every remoteDms string exists in en, ar and zh-CN', () => {
  const keys = new Set();
  for (const src of [PANEL, SEEN, SHELL]) {
    for (const m of src.matchAll(/'(remoteDms\.[A-Za-z0-9.]+)'/g)) keys.add(m[1]);
    for (const m of src.matchAll(/"(remoteDms\.[A-Za-z0-9.]+)"/g)) keys.add(m[1]);
  }
  assert.ok(keys.size >= 10, `only ${keys.size} keys found — the extractor is not matching`);

  const missing = [];
  for (const key of keys) {
    for (const code of LOCALES) {
      const v = get(locale(code), key);
      if (typeof v !== 'string' || !v.trim()) missing.push(`${code}: ${key}`);
    }
  }
  assert.deepEqual(missing, [], 'a typo would render as the raw key');
});

test('the archive is reachable over the bridge on both sides', () => {
  const index = read('src/main/index.ts');
  const preload = read('src/preload/index.ts');
  assert.ok(index.includes("ipcMain.handle('hive:remoteDms'"), 'main never registers hive:remoteDms');
  assert.ok(preload.includes("invoke('hive:remoteDms'"), 'preload never calls hive:remoteDms');
  assert.match(preload, /\bhiveRemoteDms:/, 'preload does not expose hiveRemoteDms');
  assert.ok(PANEL.includes('cth.hiveRemoteDms()'), 'the panel never reads the archive');
  assert.ok(SHELL.includes('cth.hiveRemoteDms()'), 'the badge never reads the archive');
});

test('the Inbox screen mounts the remote panel and folds its unread into the badge', () => {
  assert.ok(SHELL.includes('<RemoteDmsPanel />'), 'RemoteDmsPanel is not mounted');
  const inbox = SHELL.match(/screen === 'inbox' && \(([\s\S]*?)\n {8}\)/);
  assert.ok(inbox, 'the inbox screen branch is not where it was');
  assert.ok(inbox[1].includes('<RemoteDmsPanel />'), 'the panel is outside the inbox screen');
  assert.ok(inbox[1].includes('<AskMeTab />'), 'the local half of the inbox went missing');
  assert.match(SHELL, /count \+= totalUnread\(threads\)/, 'unread remote mail is not in the nav badge');
});

// ─── badge bookkeeping ──────────────────────────────────────────────────────

/** A fresh localStorage per test, so the badge state of one test is not the
 *  other's. The module reads `window.localStorage` at call time, not load
 *  time, so swapping the backing store is enough. */
function withSeen(t) {
  let store = new Map();
  global.window = {
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => { store.set(k, String(v)); },
      removeItem: (k) => { store.delete(k); }
    }
  };
  t.after(() => { delete global.window; });
  return {
    setRaw: (v) => store.set('cth.remoteDmsSeen', v),
    getRaw: () => store.get('cth.remoteDmsSeen')
  };
}

const thread = (key, ids) => ({
  key,
  node: key.split(':')[0],
  peer: key.split(':')[1],
  messages: ids.map((id, i) => ({
    id,
    conversation: 'c',
    in_reply_to: null,
    from: 'them',
    to: 'us',
    act: 'inform',
    subject: '',
    body: id,
    created_at: `2026-09-28T00:00:${String(i).padStart(2, '0')}.000Z`,
    node: key.split(':')[0],
    peer: key.split(':')[1],
    direction: i % 2 ? 'out' : 'in'
  }))
});

test('a thread never opened counts entirely as unread, and clears once read', (t) => {
  withSeen(t);
  const seen = require('./load-ts.cjs')('src/renderer/src/components/workspace/remoteDmSeen.ts');

  const th = thread('node-a:peer', ['m1', 'm2', 'm3']);
  assert.equal(seen.unreadAfter(th), 3, 'nothing has been read yet');
  assert.equal(seen.totalUnread([th]), 3);

  seen.markThreadSeen(th);
  assert.equal(seen.unreadAfter(th), 0, 'opening the thread reads it');
  assert.equal(seen.totalUnread([th]), 0);
});

test('new mail arriving after a read bumps the badge, and only by the delta', (t) => {
  withSeen(t);
  const seen = require('./load-ts.cjs')('src/renderer/src/components/workspace/remoteDmSeen.ts');

  const th = thread('node-a:peer', ['m1', 'm2']);
  seen.markThreadSeen(th);
  assert.equal(seen.unreadAfter(th), 0);

  const grown = thread('node-a:peer', ['m1', 'm2', 'm3', 'm4']);
  assert.equal(seen.unreadAfter(grown), 2, 'only the two new messages count');
  seen.markThreadSeen(grown);
  assert.equal(seen.unreadAfter(grown), 0);
});

test('threads are tracked independently', (t) => {
  withSeen(t);
  const seen = require('./load-ts.cjs')('src/renderer/src/components/workspace/remoteDmSeen.ts');

  const a = thread('node-a:peer', ['a1']);
  const b = thread('node-b:peer', ['b1', 'b2']);
  seen.markThreadSeen(a);

  assert.equal(seen.unreadAfter(a), 0);
  assert.equal(seen.unreadAfter(b), 2, 'reading one conversation must not read another');
  assert.equal(seen.totalUnread([a, b]), 2);
});

test('a marker that no longer matches reads as "everything", never as "nothing"', (t) => {
  withSeen(t);
  const seen = require('./load-ts.cjs')('src/renderer/src/components/workspace/remoteDmSeen.ts');

  const th = thread('node-a:peer', ['m1', 'm2']);
  seen.markThreadSeen(th);
  // The thread was rebuilt elsewhere (a different machine wrote the same ids,
  // or the cap dropped the marked message): err towards showing mail.
  const rewritten = thread('node-a:peer', ['x1', 'x2', 'x3']);
  assert.equal(seen.unreadAfter(rewritten), 3);
});

test('unread storage that will not parse degrades to "everything unread"', (t) => {
  const storage = withSeen(t);
  storage.setRaw('{ not json');
  const seen = require('./load-ts.cjs')('src/renderer/src/components/workspace/remoteDmSeen.ts');

  const th = thread('node-a:peer', ['m1']);
  assert.equal(seen.unreadAfter(th), 1, 'corrupt state must not hide mail');
  seen.markThreadSeen(th); // must not throw
  assert.equal(seen.unreadAfter(th), 0);
});
