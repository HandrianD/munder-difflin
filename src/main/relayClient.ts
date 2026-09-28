/**
 * The outbound half of Track B: this machine's live connection to the relay.
 *
 * The relay (`relay/`, plain Node + `ws`) is a postbox on the tailnet. This
 * client owns exactly one socket to it and three guarantees:
 *
 *   1. **At-least-once outbound.** An envelope goes into a persisted outbox
 *      BEFORE it is ever written to the socket, and leaves only when the relay
 *      acks it. A socket that dies between send and ack leaves it queued for
 *      the next connection. Duplicate delivery is expected and harmless: the
 *      receiver is idempotent on HiveMessage id (hive's inbox filename).
 *
 *   2. **Survives the relay going away.** Reconnect with capped backoff and
 *      jitter — a tailnet host rebooting must not require an app restart, and
 *      jitter keeps a whole fleet from thundering back at once.
 *
 *   3. **Stops cleanly when retrying cannot help.** A rejected seat (4003
 *      unknown, 4004 node id owned by someone else, 4005 revoked) or a
 *      malformed hello (4002) will never succeed on retry. Backing off forever
 *      would look like a flaky network while actually needing an operator, so
 *      those close codes move to `rejected` and stay there until start() is
 *      called again after the operator fixes the credential.
 *
 * Deliberately Electron-free: every ambient dependency (url, token, node id,
 * outbox path, callbacks) is injected, so `test/relay-client.test.cjs` can load
 * it through `test/load-ts.cjs` and run it against the real relay with no
 * display, no keychain and no network.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';
import WebSocket from 'ws';

/** The ONLY kinds allowed to cross machines — mirrors `relay/envelope.js`.
 *  Kept in sync by test/relay-client.test.cjs asserting both sets match. */
export const RELAY_ENVELOPE_KINDS = ['ask', 'reply', 'result', 'board.update'] as const;
export type RelayEnvelopeKind = (typeof RELAY_ENVELOPE_KINDS)[number];

export interface RelayEnvelope {
  id: string;
  fromNode: string;
  fromAgent: string;
  toAgent: string | null;
  kind: RelayEnvelopeKind;
  payload: unknown;
  ts: number;
}

/** What the caller hands us. `fromNode`/`ts`/`id` are stamped by the client —
 *  it is the only party that can honestly attest its own node id. */
export interface RelayEnvelopeInput {
  id?: string;
  fromAgent: string;
  toAgent: string | null;
  kind: RelayEnvelopeKind;
  payload: unknown;
  ts?: number;
}

export type RelayState =
  /** Not running (never started, or stopped). */
  | 'idle'
  /** TCP/WebSocket opening. */
  | 'connecting'
  /** Socket open, hello sent, waiting for welcome. */
  | 'authenticating'
  /** Welcome received; outbox is flushing. */
  | 'online'
  /** Connection lost; waiting out the backoff before retrying. */
  | 'backoff'
  /** The relay refused this seat/node id. Retrying cannot help. */
  | 'rejected';

export interface RelayStatus {
  state: RelayState;
  url: string;
  nodeId: string;
  seatLabel: string | null;
  outboxDepth: number;
  /** Envelopes written to the socket and not yet acked. */
  inflight: number;
  /** Consecutive failed connection attempts; resets on a successful welcome. */
  attempt: number;
  lastError: string | null;
}

export type RelayResult = { ok: true; id: string } | { ok: false; error: string };

export interface RelayClientOptions {
  /** Relay base URL, e.g. `ws://machine.tailnet.ts.net`. */
  url: string;
  /** Seat token, already decrypted. Never logged, never persisted by us. */
  token: string;
  /** This machine's mailbox address (`getRelayNodeIdentity().nodeId`). */
  nodeId: string;
  /** Human label for the relay's `node list`. */
  nodeName?: string;
  /** Durable outbox path. Omit for a memory-only client (tests). */
  outboxPath?: string;
  /** Inbound envelope sink. Throwing here must never kill the socket. */
  onDeliver(envelope: RelayEnvelope): void;
  /** Fired on every observable state change (UI, logs). */
  onStatus?(status: RelayStatus): void;
  /** Backoff schedule in ms; the last entry repeats. */
  reconnectDelaysMs?: number[];
  heartbeatIntervalMs?: number;
  helloTimeoutMs?: number;
  log?(line: string): void;
}

/** Close codes the relay sends when retrying is pointless. See relay/server.js. */
const FATAL_CLOSE_CODES = new Set([4002, 4003, 4004, 4005]);

/** Envelope errors that will never succeed on a retry — the payload itself is
 *  wrong. Anything else (a transient blip) stays queued. Mirrors the codes
 *  returned by `validateEnvelope` in relay/envelope.js. */
const PERMANENT_ENVELOPE_ERRORS = new Set(['bad-envelope', 'not-your-node', 'unknown-kind', 'payload-too-large']);

const MAX_ID_LENGTH = 128;
const MAX_AGENT_LENGTH = 256;
/** Matches the relay's own cap; the relay refuses anything larger, so matching
 *  it here means we fail before wasting a round trip. */
const MAX_PAYLOAD_BYTES = 1024 * 1024;
/** Matches relay DEFAULTS.maxPayload — a flood is refused by the socket, not
 *  by JSON.parse on a 400 MB string. */
const MAX_SOCKET_BYTES = 2 * 1024 * 1024;

const DEFAULT_RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 20_000, 30_000];
const DEFAULT_HEARTBEAT_MS = 25_000;
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;

/** Cap the outbox so a relay that is offline for a week cannot grow the file
 *  without bound. Dropping the OLDEST is deliberate: it is the mail most likely
 *  to be stale, and it keeps the failure legible (a gap) instead of an OOM. */
const MAX_OUTBOX = 5_000;

function isRelayKind(v: unknown): v is RelayEnvelopeKind {
  return typeof v === 'string' && (RELAY_ENVELOPE_KINDS as readonly string[]).includes(v);
}

/**
 * Map a hive `MessageAct` onto the closed set of kinds the relay will carry.
 *
 * The envelope kind is a CAPABILITY class — it says which messages are allowed
 * to leave this machine at all — not a restatement of the message. The
 * authoritative `act` rides untouched inside `payload`, so the receiving floor
 * reads exactly what the sender wrote.
 *
 *   request/query/propose  → ask          (these are the acts that require a reply)
 *   agree/refuse           → reply        (the answer to one)
 *   done                   → result       (work reported complete)
 *   inform / anything new  → board.update (a notice; `inform` is what
 *                                          normalize() defaults to, so it is
 *                                          by far the common case)
 */
export function envelopeKindForAct(act: string): RelayEnvelopeKind {
  switch (act) {
    case 'request':
    case 'query':
    case 'propose':
      return 'ask';
    case 'agree':
    case 'refuse':
      return 'reply';
    case 'done':
      return 'result';
    default:
      return 'board.update';
  }
}

function checkPayload(payload: unknown): { ok: true; bytes: number } | { ok: false; error: string } {
  let json: string;
  try {
    json = JSON.stringify(payload === undefined ? null : payload);
  } catch {
    return { ok: false, error: 'payload is not JSON-serializable' };
  }
  return { ok: true, bytes: Buffer.byteLength(json, 'utf8') };
}

export class RelayClient {
  private readonly opts: Required<Pick<RelayClientOptions, 'url' | 'token' | 'nodeId' | 'nodeName' | 'outboxPath' | 'reconnectDelaysMs' | 'heartbeatIntervalMs' | 'helloTimeoutMs'>>;
  private readonly onDeliver: (env: RelayEnvelope) => void;
  private readonly onStatus: ((s: RelayStatus) => void) | undefined;
  private readonly log: (line: string) => void;

  private ws: WebSocket | null = null;
  private running = false;
  private state: RelayState = 'idle';
  private attempt = 0;
  private seatLabel: string | null = null;
  private lastError: string | null = null;
  private lastInboundAt = 0;

  private outbox: RelayEnvelope[] = [];
  private readonly inflight = new Set<string>();

  private reconnectTimer: NodeJS.Timeout | null = null;
  private helloTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  constructor(options: RelayClientOptions) {
    this.opts = {
      url: options.url,
      token: options.token,
      nodeId: options.nodeId,
      nodeName: options.nodeName ?? options.nodeId,
      outboxPath: options.outboxPath ?? '',
      reconnectDelaysMs: options.reconnectDelaysMs?.length ? options.reconnectDelaysMs : DEFAULT_RECONNECT_DELAYS_MS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_MS,
      helloTimeoutMs: options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS
    };
    this.onDeliver = options.onDeliver;
    this.onStatus = options.onStatus;
    this.log = options.log ?? (() => {});
    this.outbox = this.loadOutbox();
  }

  // ── lifecycle ───────────────────────────────────────────────────────────

  /** Connect. Idempotent: a client already running (or waiting out a backoff)
   *  is left alone rather than being duplicated onto a second socket. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.lastError = null;
    this.clearTimer('reconnect');
    this.connect();
  }

  /** Disconnect and stop retrying. Idempotent. */
  stop(): void {
    this.running = false;
    this.clearTimer('reconnect');
    this.clearTimer('hello');
    this.stopHeartbeat();
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      try { ws.close(1000, 'client stop'); } catch { /* already closing */ }
    }
    // Nothing is in flight on a socket we just closed; every queued envelope
    // must be eligible to send again when start() is called later.
    this.inflight.clear();
    this.setState('idle');
  }

  getStatus(): RelayStatus {
    return {
      state: this.state,
      url: this.opts.url,
      nodeId: this.opts.nodeId,
      seatLabel: this.seatLabel,
      outboxDepth: this.outbox.length,
      inflight: this.inflight.size,
      attempt: this.attempt,
      lastError: this.lastError
    };
  }

  outboxDepth(): number {
    return this.outbox.length;
  }

  // ── outbound ────────────────────────────────────────────────────────────

  /** Queue an envelope. Returns `{ok:false}` (and enqueues nothing) when the
   *  envelope could not be accepted — the caller is expected to log the drop
   *  the same way `HiveManager.deliver` reports an undeliverable message,
   *  rather than let the mail vanish silently. */
  enqueue(input: RelayEnvelopeInput): RelayResult {
    const id = typeof input.id === 'string' && input.id !== '' && input.id.length <= MAX_ID_LENGTH
      ? input.id
      : `env-${randomBytes(12).toString('hex')}`;
    if (typeof input.fromAgent !== 'string' || input.fromAgent === '' || input.fromAgent.length > MAX_AGENT_LENGTH) {
      return { ok: false, error: 'fromAgent must be a non-empty string' };
    }
    if (!(input.toAgent === null || (typeof input.toAgent === 'string' && input.toAgent !== '' && input.toAgent.length <= MAX_AGENT_LENGTH))) {
      return { ok: false, error: 'toAgent must be a string or null' };
    }
    if (!isRelayKind(input.kind)) {
      return { ok: false, error: `kind must be one of ${RELAY_ENVELOPE_KINDS.join(', ')}` };
    }
    const checked = checkPayload(input.payload);
    if (!checked.ok) return { ok: false, error: checked.error };
    if (checked.bytes > MAX_PAYLOAD_BYTES) return { ok: false, error: 'payload exceeds 1 MiB' };
    const ts = typeof input.ts === 'number' && Number.isFinite(input.ts) && input.ts > 0 ? input.ts : Date.now();

    const envelope: RelayEnvelope = {
      id,
      // Stamped here, never taken from the caller: the relay refuses any
      // envelope whose fromNode differs from the authenticated socket.
      fromNode: this.opts.nodeId,
      fromAgent: input.fromAgent,
      toAgent: input.toAgent,
      kind: input.kind,
      payload: input.payload === undefined ? null : input.payload,
      ts
    };

    this.outbox.push(envelope);
    if (this.outbox.length > MAX_OUTBOX) {
      const dropped = this.outbox.splice(0, this.outbox.length - MAX_OUTBOX);
      // An envelope evicted from the outbox can never be acked, so its
      // inflight slot would otherwise leak and suppress any resend.
      for (const gone of dropped) this.inflight.delete(gone.id);
    }
    this.persistOutbox();
    this.flush();
    this.emitStatus();
    return { ok: true, id: envelope.id };
  }

  /** Write every un-acked, not-yet-inflight envelope to the socket. */
  private flush(): void {
    const ws = this.ws;
    if (!ws || this.state !== 'online') return;
    for (const env of this.outbox) {
      if (this.inflight.has(env.id)) continue;
      try {
        ws.send(JSON.stringify({ type: 'send', envelope: env }));
        this.inflight.add(env.id);
      } catch (e) {
        // A failed write means the socket is going away; the close handler
        // clears `inflight` and the outbox stays put for the next attempt.
        this.note(e);
        return;
      }
    }
  }

  // ── connection ──────────────────────────────────────────────────────────

  private connect(): void {
    this.setState('connecting');
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.opts.url, { maxPayload: MAX_SOCKET_BYTES });
    } catch (e) {
      this.note(e);
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.on('open', () => {
      if (this.ws !== ws) { try { ws.close(); } catch { /* stale */ } return; }
      this.setState('authenticating');
      try {
        ws.send(JSON.stringify({
          type: 'hello',
          token: this.opts.token,
          nodeId: this.opts.nodeId,
          nodeName: this.opts.nodeName
        }));
      } catch (e) {
        this.note(e);
        this.forceClose(ws);
        return;
      }
      this.clearTimer('hello');
      this.helloTimer = setTimeout(() => {
        if (this.ws !== ws) return;
        // The relay's own AUTH_TIMEOUT is 5s; if we saw nothing at all the
        // socket is half-open (common on flaky Wi-Fi) — drop it and retry.
        this.note('no welcome within the hello timeout');
        this.forceClose(ws);
      }, this.opts.helloTimeoutMs);
    });

    ws.on('message', (data) => this.onMessage(ws, data));

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return;
      this.onClose(code, reason?.toString() ?? '');
    });

    ws.on('error', (err) => {
      // `close` always follows `error`; recording it here just makes the
      // eventual close reason legible instead of a bare 1006.
      this.note(err);
      this.onClose(1006, err instanceof Error ? err.message : String(err));
    });
  }

  private onMessage(ws: WebSocket, data: WebSocket.RawData): void {
    if (this.ws !== ws) return;
    this.lastInboundAt = Date.now();
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      this.note('relay sent non-JSON');
      this.forceClose(ws);
      return;
    }

    const type = typeof msg.type === 'string' ? msg.type : '';
    switch (type) {
      case 'welcome': {
        this.clearTimer('hello');
        this.seatLabel = typeof msg.seatLabel === 'string' ? msg.seatLabel : null;
        this.attempt = 0;
        this.lastError = null;
        this.setState('online');
        this.log(`[relay] online as ${this.opts.nodeId} (${this.seatLabel ?? 'seat'})`);
        this.startHeartbeat(ws);
        this.flush();
        this.emitStatus();
        return;
      }
      case 'ack': {
        const id = typeof msg.id === 'string' ? msg.id : null;
        if (!id) return;
        const before = this.outbox.length;
        this.outbox = this.outbox.filter((e) => e.id !== id);
        this.inflight.delete(id);
        if (this.outbox.length !== before) this.persistOutbox();
        this.emitStatus();
        return;
      }
      case 'deliver': {
        const env = msg.envelope;
        if (!env || typeof env !== 'object') return;
        try {
          this.onDeliver(env as RelayEnvelope);
        } catch (e) {
          // A bad inbound envelope must not take down the socket, or one
          // malformed message would silently stop all future mail.
          this.note(e);
        }
        return;
      }
      case 'error': {
        const code = typeof msg.code === 'string' ? msg.code : '';
        const text = typeof msg.message === 'string' ? msg.message : '';
        const id = typeof msg.id === 'string' ? msg.id : null;
        this.note(`relay error ${code}: ${text}`);
        if (id && PERMANENT_ENVELOPE_ERRORS.has(code)) {
          // Drop the poison envelope: retrying a too-large or malformed
          // payload forever would block everything queued behind it.
          const before = this.outbox.length;
          this.outbox = this.outbox.filter((e) => e.id !== id);
          this.inflight.delete(id);
          if (this.outbox.length !== before) this.persistOutbox();
        }
        this.emitStatus();
        return;
      }
      case 'pong':
        return; // liveness is already recorded by lastInboundAt
      default:
        this.note(`relay sent unknown frame ${String(msg.type)}`);
        return;
    }
  }

  private onClose(code: number, reason: string): void {
    this.clearTimer('hello');
    this.stopHeartbeat();
    this.ws = null;
    // Nothing can be in flight once the socket is gone; every entry is
    // eligible to be written again on the next connection.
    this.inflight.clear();

    if (!this.running) {
      this.setState('idle');
      return;
    }
    if (FATAL_CLOSE_CODES.has(code)) {
      this.lastError = reason || `relay refused the connection (close ${code})`;
      this.running = false;
      this.setState('rejected');
      this.log(`[relay] refused: ${this.lastError}`);
      this.emitStatus();
      return;
    }
    this.setState('backoff');
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (!this.running || this.reconnectTimer) return;
    const schedule = this.opts.reconnectDelaysMs;
    const base = schedule[Math.min(this.attempt, schedule.length - 1)];
    this.attempt += 1;
    // ±25% jitter: when a tailnet host reboots, every machine that was
    // connected would otherwise retry on the same tick.
    const delay = Math.max(0, Math.round(base * (0.75 + Math.random() * 0.5)));
    this.emitStatus();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.running) this.connect();
    }, delay);
  }

  private forceClose(ws: WebSocket): void {
    try { ws.terminate(); } catch { /* already gone */ }
    // `terminate` skips the close handshake; synthesize the handler's work so
    // a socket that never fires `close` still schedules the retry.
    if (this.ws === ws) this.onClose(1006, 'terminated locally');
  }

  // ── heartbeat ───────────────────────────────────────────────────────────

  private startHeartbeat(ws: WebSocket): void {
    this.stopHeartbeat();
    this.lastInboundAt = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (this.ws !== ws || this.state !== 'online') { this.stopHeartbeat(); return; }
      if (Date.now() - this.lastInboundAt > this.opts.heartbeatIntervalMs * 2) {
        // Two intervals of silence after a ping means the peer is gone but
        // TCP has not noticed (laptop lid, silent Wi-Fi drop). Don't wait for
        // the OS to time out — drop it and reconnect now.
        this.note('heartbeat missed; reconnecting');
        this.forceClose(ws);
        return;
      }
      try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* close handler will fire */ }
    }, this.opts.heartbeatIntervalMs);
    // Do not keep the process alive purely for a heartbeat.
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ── helpers ─────────────────────────────────────────────────────────────

  private setState(next: RelayState): void {
    if (this.state === next) return;
    this.state = next;
    this.emitStatus();
  }

  private emitStatus(): void {
    if (!this.onStatus) return;
    try { this.onStatus(this.getStatus()); } catch { /* status is advisory */ }
  }

  private note(e: unknown): void {
    const text = e instanceof Error ? e.message : String(e);
    this.lastError = text;
    this.log(`[relay] ${text}`);
  }

  private clearTimer(which: 'reconnect' | 'hello'): void {
    const t = which === 'reconnect' ? this.reconnectTimer : this.helloTimer;
    if (!t) return;
    if (which === 'reconnect') this.reconnectTimer = null;
    else this.helloTimer = null;
    clearTimeout(t);
  }

  private loadOutbox(): RelayEnvelope[] {
    if (!this.opts.outboxPath || !existsSync(this.opts.outboxPath)) return [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.opts.outboxPath, 'utf8'));
      const list: unknown = parsed;
      if (!Array.isArray(list)) return [];
      return list.filter((e): e is RelayEnvelope => {
        if (!e || typeof e !== 'object') return false;
        const env = e as Partial<RelayEnvelope>;
        return typeof env.id === 'string' && typeof env.fromAgent === 'string' && isRelayKind(env.kind);
      });
    } catch {
      // An unreadable outbox is empty mail, not a crash: the app must still
      // start. The envelopes are already on disk for anyone who repairs it.
      return [];
    }
  }

  /** Temp + rename: `rename` is atomic within a filesystem, so a crash leaves
   *  either the old file or the new one — never a truncated outbox, which
   *  would silently drop every message still waiting for an ack. */
  private persistOutbox(): void {
    if (!this.opts.outboxPath) return;
    try {
      const p = this.opts.outboxPath;
      mkdirSync(dirname(p), { recursive: true });
      const tmp = `${p}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.outbox, null, 2), 'utf8');
      renameSync(tmp, p);
    } catch (e) {
      // Losing durability must not stop delivery while the socket is up.
      this.note(e);
    }
  }
}
