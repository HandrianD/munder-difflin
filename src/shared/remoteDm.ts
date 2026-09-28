/**
 * Cross-machine DM shapes (Track B) — shared by the main-process archive
 * (`src/main/remoteThreads.ts`), the preload bridge, and the renderer's Inbox.
 * Kept here rather than next to the filesystem code so every side agrees on the
 * key format without importing `node:fs`.
 */

/** One archived message that crossed the relay, plus who it is really about. */
export interface RemoteDm {
  id: string;
  conversation: string;
  in_reply_to: string | null;
  from: string;
  to: string;
  act: string;
  subject: string;
  body: string;
  created_at: string;
  /** Which machine the peer was on. `unknown` when we have only ever sent. */
  node: string;
  /** The remote agent's id. */
  peer: string;
  direction: 'in' | 'out';
}

export interface RemoteThread {
  /** `node:peer` — the key conversations are grouped and persisted by. */
  key: string;
  node: string;
  peer: string;
  messages: RemoteDm[];
}

/** Bounds, so one very chatty peer cannot make an IPC reply unbounded. */
export const MAX_MESSAGES_PER_THREAD = 500;
export const MAX_THREADS = 200;

/** Node's path segment rules, tightened: ids come off the wire, so nothing
 *  gets to be a path. Anything else is refused rather than mangled — mangling
 *  two different peers into one directory would merge two conversations. */
const SEGMENT_RE = /^[A-Za-z0-9._-]{1,64}$/;

export function isSafeSegment(v: unknown): v is string {
  return typeof v === 'string' && SEGMENT_RE.test(v) && v !== '.' && v !== '..';
}
