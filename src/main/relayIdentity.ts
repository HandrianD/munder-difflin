/**
 * This machine's identity at the relay (Track B).
 *
 * Two pieces of state, with very different sensitivity:
 *
 *   1. **Seat token** — bearer credential. Whoever holds it speaks for the seat
 *      until an operator revokes it, so it is treated exactly like the
 *      integration secrets: encrypted with Electron `safeStorage` (OS keychain
 *      backed) in a file SEPARATE from config.json, decrypted only here, only in
 *      main, never logged, never sent to the renderer.
 *
 *      config.json is plain JSON that people paste into chats, diff, and copy
 *      between machines as a starting point — which is precisely what the join
 *      code flow invites them to do. Storing the token there would turn every
 *      config share into a credential leak. Fail closed: if OS encryption is
 *      unavailable we refuse to store rather than fall back to plaintext, and
 *      without a token the relay client simply never connects, which is the
 *      safe direction.
 *
 *   2. **Node id** — not a secret. It is the mailbox address this machine
 *      claims at the relay (`node-…`), stable across restarts so peers keep
 *      finding us and so the relay's `node list` stays readable. Stored in
 *      plain JSON beside it.
 *
 * Neither lives in `HarnessConfig`: the config only carries
 * `relay: { enabled, url }` (see src/main/config.ts).
 */
import { app, safeStorage } from 'electron';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';

const TOKEN_REF = 'relay-seat-token';

function tokenPath(): string {
  return join(app.getPath('userData'), 'relay-seat-token.json');
}

function identityPath(): string {
  return join(app.getPath('userData'), 'relay-node.json');
}

function readBlob(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** Temp + rename: `rename` is atomic within a filesystem, so a crash leaves
 *  either the old file or the new one, never a half-written cipher blob. The
 *  mode is best-effort on top — Windows ignores 0600 on create, the encryption
 *  is what actually carries the protection. */
function writeBlob(path: string, blob: Record<string, string>): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(blob, null, 2), { encoding: 'utf8', mode: 0o600 });
  renameSync(tmp, path);
}

/** Store the seat token ENCRYPTED. Never persists plaintext. */
export function setRelaySeatToken(token: string): { ok: boolean; error?: string } {
  if (typeof token !== 'string' || token.trim() === '') {
    return { ok: false, error: 'seat token required' };
  }
  try {
    if (!safeStorage.isEncryptionAvailable()) {
      return { ok: false, error: 'OS secret encryption is unavailable; refusing to store the seat token in plaintext' };
    }
    const cipher = safeStorage.encryptString(token.trim()).toString('base64');
    const blob = readBlob(tokenPath());
    blob[TOKEN_REF] = cipher;
    writeBlob(tokenPath(), blob);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/** Decrypt the seat token. MAIN-INTERNAL ONLY — never expose over IPC. */
export function getRelaySeatToken(): string | undefined {
  const cipher = readBlob(tokenPath())[TOKEN_REF];
  if (!cipher) return undefined;
  try {
    if (!safeStorage.isEncryptionAvailable()) return undefined;
    const token = safeStorage.decryptString(Buffer.from(cipher, 'base64'));
    return token === '' ? undefined : token;
  } catch {
    // Wrong-keyring, migrated profile, or corrupt file. Report "no token"
    // rather than a half-decryptable one — the client must not retry a
    // credential we cannot actually produce.
    return undefined;
  }
}

/** Whether a seat token is stored (no decryption — safe to show in the UI). */
export function hasRelaySeatToken(): boolean {
  return !!readBlob(tokenPath())[TOKEN_REF];
}

/** Forget the seat token. Idempotent. */
export function clearRelaySeatToken(): void {
  const p = tokenPath();
  const blob = readBlob(p);
  if (TOKEN_REF in blob) {
    delete blob[TOKEN_REF];
    if (Object.keys(blob).length === 0) {
      try { rmSync(p, { force: true }); } catch { /* best-effort */ }
    } else {
      writeBlob(p, blob);
    }
  }
}

export interface RelayNodeIdentity {
  /** Stable mailbox address at the relay, e.g. `node-6f2c1a9b0d4e`. */
  nodeId: string;
  /** Human-readable label for `node list`. */
  nodeName: string;
}

/**
 * Read (or mint) this machine's node identity.
 *
 * MINTED ONCE AND KEPT: the relay keys queued mail by node id, and peers may
 * address us by it. A fresh id every launch would orphan everything queued for
 * the old one and re-register a different mailbox under our seat.
 *
 * A file that exists but parses as garbage is NOT silently replaced — that
 * would look like a working identity while actually dropping the old mailbox.
 * It is deleted and re-minted only when the file is unreadable, because at
 * that point there is no id left to preserve.
 */
export function getRelayNodeIdentity(): RelayNodeIdentity {
  const p = identityPath();
  if (existsSync(p)) {
    try {
      const parsed: unknown = JSON.parse(readFileSync(p, 'utf8'));
      const rec = parsed as Partial<RelayNodeIdentity> | null;
      if (rec && typeof rec.nodeId === 'string' && /^node-[a-f0-9]{8,64}$/.test(rec.nodeId)) {
        return {
          nodeId: rec.nodeId,
          nodeName: typeof rec.nodeName === 'string' && rec.nodeName !== '' ? rec.nodeName : hostname()
        };
      }
    } catch { /* unreadable — fall through and re-mint below */ }
  }
  const identity: RelayNodeIdentity = {
    nodeId: `node-${randomBytes(8).toString('hex')}`,
    nodeName: hostname()
  };
  writeBlob(p, { nodeId: identity.nodeId, nodeName: identity.nodeName });
  return identity;
}
