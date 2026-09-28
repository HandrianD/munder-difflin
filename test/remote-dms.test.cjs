'use strict';

/**
 * src/main/remoteThreads.ts — the durable cross-machine DM archive, and the two
 * hooks in hive.ts that feed it.
 *
 * The property under test is the one the inbox cannot give you: a conversation
 * with another machine is still readable after BOTH sides have handled every
 * message in it. Local mail drains to inbox/.done/ and disappears from every
 * read path; this archive must not.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const loadTs = require('./load-ts.cjs');

const { appendRemoteDm, findNodeForPeer, listRemoteDms } = loadTs('src/main/remoteThreads.ts');
const { isSafeSegment } = loadTs('src/shared/remoteDm.ts');
const { HiveManager } = loadTs('src/main/hive.ts');

function tmpRoot(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-dm-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return path.join(home, 'hive');
}

const dm = (over = {}) => ({
  id: '2026-09-28T00-00-00-000Z-abc123',
  conversation: 'conv-1',
  in_reply_to: null,
  from: 'peer-agent',
  to: 'jim-1',
  act: 'request',
  subject: 'hello',
  body: 'body',
  created_at: '2026-09-28T00:00:00.000Z',
  node: 'node-alpha',
  peer: 'peer-agent',
  direction: 'in',
  ...over
});

// ─── the archive itself ─────────────────────────────────────────────────────

test('an archived message reads back as one thread keyed node:peer', (t) => {
  const root = tmpRoot(t);
  assert.equal(appendRemoteDm(root, dm()), true);

  const threads = listRemoteDms(root);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].key, 'node-alpha:peer-agent');
  assert.equal(threads[0].node, 'node-alpha');
  assert.equal(threads[0].peer, 'peer-agent');
  assert.equal(threads[0].messages.length, 1);
  assert.equal(threads[0].messages[0].body, 'body');
  assert.equal(threads[0].messages[0].direction, 'in');
});

test('the same message id archived twice is one file, not two', (t) => {
  const root = tmpRoot(t);
  appendRemoteDm(root, dm());
  appendRemoteDm(root, dm({ body: 'the real one' }));

  const [thread] = listRemoteDms(root);
  assert.equal(thread.messages.length, 1, 'idempotent by filename, as delivery is');
  assert.equal(thread.messages[0].body, 'the real one');
});

test('nothing off the wire is allowed to become a path', (t) => {
  const root = tmpRoot(t);
  const bad = [
    '../escape', 'a/b', 'a\\b', 'a:b', 'a b', '..', '.', '', 'x'.repeat(65)
  ];
  for (const seg of bad) {
    assert.equal(isSafeSegment(seg), false, `should refuse ${JSON.stringify(seg)}`);
    assert.equal(appendRemoteDm(root, dm({ peer: seg })), false, `peer ${JSON.stringify(seg)}`);
    assert.equal(appendRemoteDm(root, dm({ node: seg })), false, `node ${JSON.stringify(seg)}`);
    assert.equal(appendRemoteDm(root, dm({ id: seg })), false, `id ${JSON.stringify(seg)}`);
  }
  assert.deepEqual(listRemoteDms(root), [], 'a refused write must leave nothing behind');
  assert.equal(findNodeForPeer(root, '../escape'), null);
  assert.equal(findNodeForPeer(root, '.'), null);
});

test('a corrupt file hides itself, not its conversation', (t) => {
  const root = tmpRoot(t);
  appendRemoteDm(root, dm({ id: 'good-1', created_at: '2026-09-28T00:00:00.000Z' }));
  appendRemoteDm(root, dm({ id: 'good-2', created_at: '2026-09-28T01:00:00.000Z' }));
  const dir = path.join(root, 'dm', 'node-alpha', 'peer-agent');
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ not json', 'utf8');

  const [thread] = listRemoteDms(root);
  assert.deepEqual(thread.messages.map((m) => m.id), ['good-1', 'good-2']);
});

test('threads are listed newest activity first', (t) => {
  const root = tmpRoot(t);
  appendRemoteDm(root, dm({ node: 'node-a', peer: 'quiet', id: 'q-1', created_at: '2026-09-01T00:00:00.000Z' }));
  appendRemoteDm(root, dm({ node: 'node-b', peer: 'busy', id: 'b-1', created_at: '2026-09-02T00:00:00.000Z' }));
  appendRemoteDm(root, dm({ node: 'node-b', peer: 'busy', id: 'b-2', created_at: '2026-09-05T00:00:00.000Z' }));

  assert.deepEqual(listRemoteDms(root).map((x) => x.key), ['node-b:busy', 'node-a:quiet']);
});

test('the node a peer came from is discoverable for a later reply', (t) => {
  const root = tmpRoot(t);
  assert.equal(findNodeForPeer(root, 'peer-agent'), null, 'nothing archived yet');

  appendRemoteDm(root, dm());
  assert.equal(findNodeForPeer(root, 'peer-agent'), 'node-alpha');
  assert.equal(findNodeForPeer(root, 'someone-else'), null, 'only the peer that was archived');
});

test('an empty or absent hive root lists as no threads', () => {
  assert.deepEqual(listRemoteDms(''), []);
  assert.deepEqual(listRemoteDms(path.join(os.tmpdir(), 'md-dm-does-not-exist')), []);
});

// ─── the hooks in hive.ts ───────────────────────────────────────────────────

async function floor(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'md-dm-hive-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const hive = new HiveManager(() => home);
  await hive.ensureAgent({ id: 'god-1', name: 'Michael', provider: 'claude', cwd: home, isGod: true });
  await hive.ensureAgent({ id: 'jim-1', name: 'Jim', provider: 'claude', cwd: home });
  return { home, hive, root: path.join(home, 'hive') };
}

const inbound = (over = {}) => ({
  id: 'env-from-peer-1',
  conversation: 'conv-peer',
  in_reply_to: null,
  from: 'peer-agent',
  to: 'jim-1',
  act: 'request',
  subject: 'from the other machine',
  body: 'please take this',
  hops: 0,
  requires_reply: true,
  needs_human: false,
  created_at: '2026-09-28T00:00:00.000Z',
  ...over
});

test('mail that ARRIVED from a relay is archived under the sending machine', async (t) => {
  const { hive, root } = await floor(t);

  hive.receiveRemote(inbound(), 'node-alpha');

  const threads = listRemoteDms(root);
  assert.equal(threads.length, 1);
  assert.equal(threads[0].key, 'node-alpha:peer-agent');
  assert.equal(threads[0].messages[0].direction, 'in');
  assert.equal(threads[0].messages[0].subject, 'from the other machine');
  // …and it was still delivered locally: the archive is a copy, not a redirect.
  assert.equal(hive.inbox('jim-1').length, 1);
});

test('mail mirrored OUT is archived beside the thread it belongs to', async (t) => {
  const { hive, root } = await floor(t);
  hive.setRelayMirror(() => true);

  // The peer has written to us before, so we know which machine it is on.
  hive.receiveRemote(inbound({ id: 'env-1', from: 'remote-1' }), 'node-alpha');
  hive.send({ to: 'remote-1', act: 'agree', subject: 'on it', body: 'yes' }, 'jim-1');

  const [thread] = listRemoteDms(root);
  assert.equal(thread.key, 'node-alpha:remote-1', 'the reply joins the same thread');
  assert.deepEqual(thread.messages.map((m) => m.direction), ['in', 'out']);
});

test('a reply to a peer we have never heard from is filed, not guessed onto a machine', async (t) => {
  const { hive, root } = await floor(t);
  hive.setRelayMirror(() => true);

  hive.send({ to: 'stranger-1', act: 'query', subject: 'anyone there?' }, 'god-1');

  const [thread] = listRemoteDms(root);
  assert.equal(thread.key, 'unknown:stranger-1', 'no inbound half means no known node');
  assert.equal(thread.messages[0].direction, 'out');
});

test('local mail is never archived', async (t) => {
  const { hive, root } = await floor(t);
  hive.setRelayMirror(() => true);

  hive.send({ to: 'jim-1', act: 'inform', subject: 'stay here' }, 'god-1');

  assert.deepEqual(listRemoteDms(root), [], 'it never crossed a relay');
  assert.equal(hive.inbox('jim-1').length, 1);
});

test('a refused mirror leaves no archive entry', async (t) => {
  const { hive, root } = await floor(t);
  hive.setRelayMirror(() => false);

  hive.send({ to: 'remote-1', act: 'request', subject: 'undeliverable' }, 'god-1');

  assert.deepEqual(listRemoteDms(root), [], 'the mail did not go anywhere');
});

test('with no relay installed the archive stays empty and routing is untouched', async (t) => {
  const { hive, root } = await floor(t);

  hive.receiveRemote(inbound(), 'node-alpha');
  hive.send({ to: 'remote-1', act: 'request', subject: 'nowhere to go' }, 'god-1');

  // Inbound is still archived: the message really did arrive from another
  // machine earlier, and losing it because the relay is now off would be
  // losing exactly the history the archive exists for.
  assert.deepEqual(listRemoteDms(root).map((x) => x.key), ['node-alpha:peer-agent']);
  const drops = hive.logTail(500).filter((e) => e.kind === 'drop' && e.reason === 'no-inbox');
  assert.equal(drops.length, 1, 'outbound with no mirror still reports undeliverable');
});

test('an inbound broadcast is archived under whoever sent it', async (t) => {
  const { hive, root } = await floor(t);

  hive.receiveRemote(inbound({ to: 'broadcast', from: 'peer-hall' }), 'node-beta');

  const [thread] = listRemoteDms(root);
  assert.equal(thread.key, 'node-beta:peer-hall');
  assert.equal(thread.messages[0].direction, 'in');
});

test('an inbound message addressed to an id this machine lacks is still archived', async (t) => {
  const { hive, root } = await floor(t);
  hive.setRelayMirror(() => true);

  hive.receiveRemote(inbound({ to: 'nobody-here' }), 'node-alpha');

  // Dropped from the floor (there is no such inbox), but the conversation it
  // belongs to is real — this is the one case where the two stores differ.
  const drops = hive.logTail(500).filter((e) => e.kind === 'drop' && e.reason === 'no-inbox');
  assert.equal(drops.length, 1);
  assert.equal(listRemoteDms(root).length, 1, 'the archive keeps what the floor could not place');
});
