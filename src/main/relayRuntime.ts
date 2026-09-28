/**
 * Boot-time wiring for the relay (Track B, step 3).
 *
 * Owns exactly one {@link RelayClient} and the two callbacks that tie it to the
 * hive:
 *
 *   - **outbound** — `hive.setRelayMirror` routes mail this machine cannot
 *     deliver locally (see the seam in `hive.ts`) into the client's outbox.
 *   - **inbound** — anything the relay pushes goes to `hive.receiveRemote`,
 *     which marks it foreign-origin so it is never echoed back out.
 *
 * Every dependency that touches Electron is injected (paths, credentials,
 * status fan-out), so the state machine below — the part that can actually be
 * wrong — is loadable by `test/load-ts.cjs` with no display, no keychain and no
 * network. The interesting rules:
 *
 *   - **Reconcile, don't react.** `sync(config)` compares what IS running with
 *     what the config asks for and changes only the difference. Settings saves
 *     fire often; tearing down a healthy socket on each one would drop queued
 *     mail mid-flight and re-handshake for nothing.
 *   - **Off is a real state.** Disabled, missing URL, or missing token all
 *     converge on "not running" — including a token revoked while connected,
 *     which is how `seat revoke` on the other machine takes effect here.
 *   - **Rejected does not retry.** A seat the relay refused needs an operator;
 *     `sync()` leaves it parked rather than silently reconnecting into the same
 *     refusal.
 */
import type { HarnessConfig } from './config';
import type { HiveManager, HiveMessage } from './hive';
import { RelayClient, envelopeKindForAct, type RelayEnvelope, type RelayStatus } from './relayClient';

export interface RelayStatusView extends RelayStatus {
  /** From config: has the operator switched the relay on at all. */
  enabled: boolean;
  /** Whether a seat token is stored. Never the token itself. */
  hasSeatToken: boolean;
}

export interface RelayRuntimeDeps {
  /** Where the un-acked outbox is persisted across restarts. Resolved lazily:
   *  Electron's userData path is only reliable once the app is ready, and the
   *  runtime object is built at module scope. */
  outboxPath(): string;
  /** Current seat token, or undefined when none is stored. */
  getToken(): string | undefined;
  /** Stable mailbox address for this machine. */
  nodeId(): string;
  /** Human label shown by the relay's `node list`. */
  nodeName(): string;
  /** Push a status snapshot to the UI. Never throws into the caller. */
  broadcast(status: RelayStatusView): void;
  log?(line: string): void;
}

export interface RelayRuntime {
  /** Reconcile the running client with the latest config. */
  sync(cfg: HarnessConfig): void;
  /** Force a fresh connection (operator retry after a refusal or a fix). */
  restart(cfg: HarnessConfig): void;
  /** Disconnect permanently (quit, reset). */
  stop(): void;
  status(): RelayStatusView;
}

interface Wanted {
  url: string;
  token: string;
}

export function createRelayRuntime(hive: Pick<HiveManager, 'setRelayMirror' | 'receiveRemote'>, deps: RelayRuntimeDeps): RelayRuntime {
  const log = deps.log ?? ((line: string) => { /* default: stay quiet */ });

  let client: RelayClient | null = null;
  let wanted: Wanted | null = null;

  function desired(cfg: HarnessConfig): Wanted | null {
    if (cfg.relay?.enabled !== true) return null;
    const url = (cfg.relay.url ?? '').trim();
    const token = deps.getToken();
    if (!url || !token) return null;
    return { url, token };
  }

  function status(): RelayStatusView {
    const cfg = client?.getStatus();
    return {
      enabled: wanted !== null,
      hasSeatToken: deps.getToken() !== undefined,
      state: cfg?.state ?? 'idle',
      url: cfg?.url ?? '',
      nodeId: cfg?.nodeId ?? '',
      seatLabel: cfg?.seatLabel ?? null,
      outboxDepth: cfg?.outboxDepth ?? 0,
      inflight: cfg?.inflight ?? 0,
      attempt: cfg?.attempt ?? 0,
      lastError: cfg?.lastError ?? null
    };
  }

  function broadcast(): void {
    try { deps.broadcast(status()); } catch { /* status is advisory */ }
  }

  function teardown(): void {
    if (!client) return;
    // Detach BEFORE stopping: `stop()` closes the socket, and a message
    // arriving in that window would otherwise hit a client nobody owns.
    hive.setRelayMirror(null);
    const dying = client;
    client = null;
    dying.stop();
  }

  function launch(want: Wanted): void {
    const identity = { nodeId: deps.nodeId(), nodeName: deps.nodeName() };
    const created = new RelayClient({
      url: want.url,
      token: want.token,
      nodeId: identity.nodeId,
      nodeName: identity.nodeName,
      outboxPath: deps.outboxPath(),
      onDeliver: (envelope: RelayEnvelope) => receive(envelope),
      onStatus: () => broadcast(),
      log
    });
    client = created;
    hive.setRelayMirror((msg: HiveMessage, toAgent: string | null) => {
      const result = created.enqueue({
        fromAgent: msg.from,
        toAgent,
        kind: envelopeKindForAct(msg.act),
        payload: msg
      });
      if (!result.ok) {
        // Mirrors the hive's own rule: a message nobody took is logged, never
        // silently dropped. The caller still reports "not taken", so the local
        // drop + bounce fires as if the relay were off.
        log(`[relay] not queued ${msg.id}: ${result.error}`);
      }
      return result.ok;
    });
    created.start();
    broadcast();
  }

  function receive(envelope: RelayEnvelope): void {
    const payload = envelope.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      log(`[relay] dropped ${String(envelope.id)}: payload is not a hive message`);
      return;
    }
    try {
      hive.receiveRemote(payload as Partial<HiveMessage>, envelope.fromNode);
    } catch (e) {
      // One malformed envelope must not stop the socket — the next one may be
      // the message somebody is waiting on.
      log(`[relay] inbound ${String(envelope.id)} rejected: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  function sync(cfg: HarnessConfig): void {
    const want = desired(cfg);
    if (!want) {
      if (client) { teardown(); wanted = null; broadcast(); }
      else wanted = null;
      return;
    }
    if (client && wanted && wanted.url === want.url && wanted.token === want.token) {
      // Same relay, same credential: leave the connection alone, whatever
      // state it is in. Settings saves fire on every unrelated change, so
      // restarting here would tear down a healthy socket (or re-handshake into
      // a refusal the operator has not fixed yet) on a whim. `restart()` is
      // the explicit way out of `rejected`.
      return;
    }
    teardown();
    wanted = want;
    launch(want);
  }

  return {
    sync,
    restart(cfg: HarnessConfig): void {
      teardown();
      wanted = null;
      const want = desired(cfg);
      if (!want) { broadcast(); return; }
      wanted = want;
      launch(want);
    },
    stop(): void {
      teardown();
      wanted = null;
    },
    status
  };
}
