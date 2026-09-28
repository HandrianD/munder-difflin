import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  isSafeSegment,
  MAX_MESSAGES_PER_THREAD,
  MAX_THREADS,
  type RemoteDm,
  type RemoteThread
} from '../shared/remoteDm';

/**
 * The cross-machine DM archive (Track B).
 *
 * Local mail is disposable by design: an agent drains `inbox/` and the handled
 * files move to `inbox/.done/`, so an inbox read only ever shows what is still
 * owed. That is right for work orders and wrong for a conversation — a thread
 * with another machine has to still be there tomorrow, after both sides have
 * handled everything in it.
 *
 * So mail that crossed the relay is archived HERE as well as delivered, in a
 * tree keyed the way a person thinks about it:
 *
 *     <hive>/dm/<node>/<peer>/<messageId>.json
 *
 * `node` is the machine the peer ran on (known inbound from the envelope,
 * resolved outbound by looking up where that peer's mail has come from) and
 * `peer` is the remote agent's id. Append-only, idempotent by filename, and
 * never the delivery path — routing does not read this, so nothing here can
 * stall or duplicate a message that is already on the wire.
 */

function dmRoot(hiveRoot: string): string {
  return join(hiveRoot, 'dm');
}

function threadDir(hiveRoot: string, node: string, peer: string): string {
  return join(dmRoot(hiveRoot), node, peer);
}

/** Atomic within a filesystem: a crash mid-write leaves the old file or none,
 *  never half a message. Same pattern as the inbox and config.json. */
function atomicWriteJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, file);
}

/**
 * Archive one message. Returns false only when the shape cannot be stored
 * safely (an id or peer that is not a path segment) — callers treat that as
 * "no archive", never as an error to surface.
 */
export function appendRemoteDm(
  hiveRoot: string,
  dm: Omit<RemoteDm, 'node' | 'peer'> & { node: string; peer: string }
): boolean {
  if (!hiveRoot) return false;
  if (!isSafeSegment(dm.id) || !isSafeSegment(dm.node) || !isSafeSegment(dm.peer)) return false;
  try {
    const dir = threadDir(hiveRoot, dm.node, dm.peer);
    mkdirSync(dir, { recursive: true });
    atomicWriteJson(join(dir, `${dm.id}.json`), dm);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which machine this peer's mail has come from, if any.
 *
 * An outbound reply does not know its destination node — the relay fans out to
 * every machine — so the node is recovered from the inbound half of the same
 * conversation. Absent that, the thread is filed under `unknown` rather than
 * guessed: guessing could file a reply into a different machine's copy of the
 * same agent id.
 */
export function findNodeForPeer(hiveRoot: string, peer: string): string | null {
  if (!hiveRoot || !isSafeSegment(peer)) return null;
  try {
    const base = dmRoot(hiveRoot);
    if (!existsSync(base)) return null;
    const nodes = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isSafeSegment(e.name))
      .map((e) => e.name);
    for (const node of nodes) {
      if (existsSync(threadDir(hiveRoot, node, peer))) return node;
    }
    return null;
  } catch {
    return null;
  }
}

/** Read every thread back, newest activity first. Unreadable files are skipped
 *  rather than failing the whole listing — one corrupt message must not hide a
 *  conversation. */
export function listRemoteDms(hiveRoot: string): RemoteThread[] {
  if (!hiveRoot) return [];
  const byKey = new Map<string, RemoteThread>();
  let base: string;
  try {
    base = dmRoot(hiveRoot);
    if (!existsSync(base)) return [];
  } catch {
    return [];
  }

  let nodes: string[] = [];
  try {
    nodes = readdirSync(base, { withFileTypes: true })
      .filter((e) => e.isDirectory() && isSafeSegment(e.name))
      .map((e) => e.name);
  } catch {
    return [];
  }

  for (const node of nodes) {
    let peers: string[] = [];
    try {
      peers = readdirSync(join(base, node), { withFileTypes: true })
        .filter((e) => e.isDirectory() && isSafeSegment(e.name))
        .map((e) => e.name);
    } catch {
      continue;
    }
    for (const peer of peers) {
      const thread = readThread(base, node, peer);
      if (thread) byKey.set(thread.key, thread);
      if (byKey.size >= MAX_THREADS) break;
    }
    if (byKey.size >= MAX_THREADS) break;
  }

  return [...byKey.values()]
    .map((t) => ({ ...t, messages: t.messages.slice(-MAX_MESSAGES_PER_THREAD) }))
    .sort((a, b) => lastAt(b) - lastAt(a) || a.key.localeCompare(b.key));
}

function lastAt(t: RemoteThread): number {
  const last = t.messages[t.messages.length - 1];
  const ms = last ? Date.parse(last.created_at) : NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

function readThread(base: string, node: string, peer: string): RemoteThread | null {
  const dir = join(base, node, peer);
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'));
  } catch {
    return null;
  }
  const messages: RemoteDm[] = [];
  for (const name of names) {
    try {
      const parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
      if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
        messages.push({ ...parsed, node, peer } as RemoteDm);
      }
    } catch {
      /* a half-written or hand-edited file must not hide the rest of the thread */
    }
  }
  if (messages.length === 0) return null;
  messages.sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  return { key: `${node}:${peer}`, node, peer, messages };
}
