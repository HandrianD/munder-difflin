/**
 * Join codes — the single string one machine hands another so it can reach this
 * hive over the relay. It carries exactly two things: the relay URL and a seat
 * token. Nothing else goes in a code (no roster, no message history, no config).
 *
 * A join code is a BEARER CREDENTIAL: whoever holds it joins as a seat. It is
 * therefore generated only in answer to an explicit "show" click, is never
 * written into config.json, and is never logged. It is NOT encrypted — the
 * prefix `mdr1.` is a format marker, not a seal. Encoding a secret in
 * base64url would be misleading, so the docs say plainly what it is: a code you
 * paste to someone you already trust, over a channel you already trust.
 *
 * Pure: no Buffer, no node built-ins, no DOM — the same module runs in main,
 * in the renderer, and in a plain `node --test` process.
 */

/** What a join code resolves to. Both halves are validated on the way out. */
export interface JoinCodePayload {
  /** Relay endpoint, `ws://` or `wss://`. */
  url: string;
  /** Seat token: `mdr_` + 64 lowercase hex (relay/auth.js `newSeatToken`). */
  token: string;
}

export type JoinCodeResult =
  | { ok: true; payload: JoinCodePayload }
  | { ok: false; error: JoinCodeError };

/**
 * Failure modes, as stable strings rather than prose: the renderer maps each
 * one to an i18n key (`team.joinCode.<error>`), and a test asserts the two
 * sets stay in step. No error ever echoes the code back.
 */
export type JoinCodeError =
  | 'empty'
  | 'tooLong'
  | 'unknownPrefix'
  | 'malformed'
  | 'unsupportedVersion'
  | 'badUrl'
  | 'badToken';

/** Format marker. Bumping it invalidates every code ever shown, which is the
 *  point: a code from a build that encoded differently must fail loudly rather
 *  than half-parse into a URL nobody can connect to. */
export const JOIN_CODE_PREFIX = 'mdr1.';

/** A pasted code is bounded before it is decoded — 4 KiB is ~30× a real code. */
export const JOIN_CODE_MAX_CHARS = 4096;

/** Kept in sync with relay/auth.js `TOKEN_PREFIX` + 32 random bytes. */
const TOKEN_RE = /^mdr_[0-9a-f]{64}$/;

/** `ws://` / `wss://` only. An `http(s)://` value would be accepted by a
 *  careless operator and then fail at the WebSocket layer with a message that
 *  explains nothing. */
const RELAY_URL_RE = /^wss?:\/\/\S+$/i;

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

function toBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const has1 = i + 1 < bytes.length;
    const has2 = i + 2 < bytes.length;
    const b1 = has1 ? bytes[i + 1] : 0;
    const b2 = has2 ? bytes[i + 2] : 0;
    out += B64URL[b0 >> 2];
    out += B64URL[((b0 & 3) << 4) | (b1 >> 4)];
    if (has1) out += B64URL[((b1 & 15) << 2) | (b2 >> 6)];
    if (has2) out += B64URL[b2 & 63];
  }
  return out;
}

/** Returns null on any character outside the alphabet, or a payload whose
 *  leftover bits are non-zero (a code that was edited by hand). */
function fromBase64Url(s: string): Uint8Array | null {
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  for (const ch of s) {
    const v = B64URL.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  // Trailing bits must be padding that came from a whole byte; anything else
  // means the tail was tampered with or truncated.
  if (bits > 0 && (acc & ((1 << bits) - 1)) !== 0) return null;
  return Uint8Array.from(out);
}

/** Validate a seat token on its own (used by the UI to grey out the field). */
export function isValidSeatToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_RE.test(token);
}

/** Validate a relay URL on its own. */
export function isValidRelayUrl(url: unknown): url is string {
  return typeof url === 'string' && RELAY_URL_RE.test(url.trim()) && url.trim().length > 0;
}

export function encodeJoinCode(payload: JoinCodePayload): string {
  const json = JSON.stringify({ v: 1, url: payload.url.trim(), token: payload.token });
  return JOIN_CODE_PREFIX + toBase64Url(new TextEncoder().encode(json));
}

export function decodeJoinCode(raw: unknown): JoinCodeResult {
  if (typeof raw !== 'string') return { ok: false, error: 'empty' };
  // People paste codes out of terminals that wrapped them, out of chat clients
  // that added a trailing newline, and out of PDFs that inserted spaces.
  const code = raw.replace(/\s+/g, '');
  if (!code) return { ok: false, error: 'empty' };
  if (code.length > JOIN_CODE_MAX_CHARS) return { ok: false, error: 'tooLong' };
  if (!code.startsWith(JOIN_CODE_PREFIX)) return { ok: false, error: 'unknownPrefix' };

  const bytes = fromBase64Url(code.slice(JOIN_CODE_PREFIX.length));
  if (bytes === null || bytes.length === 0) return { ok: false, error: 'malformed' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return { ok: false, error: 'malformed' };
  }
  if (typeof parsed !== 'object' || parsed === null) return { ok: false, error: 'malformed' };

  const { v, url, token } = parsed as { v?: unknown; url?: unknown; token?: unknown };
  if (v !== 1) return { ok: false, error: 'unsupportedVersion' };
  if (!isValidRelayUrl(url)) return { ok: false, error: 'badUrl' };
  if (!isValidSeatToken(token)) return { ok: false, error: 'badToken' };

  return { ok: true, payload: { url: (url as string).trim(), token: token as string } };
}
