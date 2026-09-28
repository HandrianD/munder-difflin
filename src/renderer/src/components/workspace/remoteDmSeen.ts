import type { RemoteThread } from '@shared/remoteDm';

/**
 * Which cross-machine messages this operator has already read.
 *
 * Lives in localStorage rather than main because "read" is a property of the
 * person at this window, not of the hive — two windows on one machine share a
 * profile anyway, and nothing on disk should be rewritten just because someone
 * scrolled a thread. The marker is the last-seen MESSAGE id, not a count, so
 * appending to a thread can never make its badge go backwards.
 */
const LS_KEY = 'cth.remoteDmsSeen';

type SeenMap = Record<string, string>;

function read(): SeenMap {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LS_KEY) ?? '{}');
    return parsed && typeof parsed === 'object' ? (parsed as SeenMap) : {};
  } catch {
    return {};
  }
}

function write(map: SeenMap): void {
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch {
    /* quota or private mode — the badge is cosmetic, never worth an error */
  }
}

/** Unread messages in one thread. An unknown marker means "never opened", so
 *  everything counts; a marker that has fallen off the front of a capped thread
 *  counts everything too, which errs towards showing mail rather than hiding it. */
export function unreadAfter(thread: RemoteThread): number {
  const seenId = read()[thread.key];
  if (!seenId) return thread.messages.length;
  const i = thread.messages.findIndex((m) => m.id === seenId);
  if (i < 0) return thread.messages.length;
  return thread.messages.length - (i + 1);
}

export function totalUnread(threads: RemoteThread[]): number {
  return threads.reduce((n, th) => n + unreadAfter(th), 0);
}

export function markThreadSeen(thread: RemoteThread): void {
  const last = thread.messages[thread.messages.length - 1];
  if (!last) return;
  const map = read();
  if (map[thread.key] === last.id) return;
  map[thread.key] = last.id;
  write(map);
}
