import { useEffect, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '@/components/Icon';
import { PixelButton } from '@/components/PixelButton';
import { PixelPanel } from '@/components/PixelPanel';
import type { HarnessConfig } from '@/store/config';

type RelayStatus = Awaited<ReturnType<typeof window.cth.relayStatus>>;

/** The token is WRITE-ONLY: main never returns it, only whether one exists.
 *  So this field starts empty every time and can never be "restored". */
type Busy = 'relay' | 'token' | 'code' | 'join' | 'retry' | null;

const ROW: CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap'
};

const LABEL: CSSProperties = {
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-700)',
  minWidth: 96
};

const INPUT: CSSProperties = {
  flex: '1 1 200px', minWidth: 0, padding: '6px 8px',
  background: 'var(--cth-paper-100)', border: 'none',
  fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-900)',
  outline: 'none'
};

const NOTE: CSSProperties = {
  fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-500)'
};

const STATE_FILL: Record<RelayStatus['state'], string> = {
  idle: 'var(--cth-cream-300)',
  connecting: 'var(--cth-lemon)',
  authenticating: 'var(--cth-lemon)',
  online: 'var(--cth-mint)',
  backoff: 'var(--cth-lemon)',
  rejected: 'var(--cth-coral)'
};

/**
 * The Teams screen: this machine's relay settings, its invite code, and the
 * field for someone else's. Everything credential-shaped crosses IPC write-only
 * — the seat token can be set here but is never read back into React state.
 */
export function TeamTab({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();

  const [status, setStatus] = useState<RelayStatus | null>(null);
  const [hasToken, setHasToken] = useState(false);
  const [identity, setIdentity] = useState<{ nodeId: string; nodeName: string } | null>(null);
  const [url, setUrl] = useState(config.relay?.url ?? '');
  const [token, setToken] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [joinText, setJoinText] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<{ key: string; err: boolean } | null>(null);
  const [copied, setCopied] = useState(false);

  const enabled = config.relay?.enabled === true;

  // config is the source of truth for the URL: joining a team writes it from
  // main, and a stale local copy here would immediately overwrite that.
  useEffect(() => { setUrl(config.relay?.url ?? ''); }, [config.relay?.url]);

  useEffect(() => {
    let alive = true;
    const keep = <T,>(p: Promise<T>, set: (v: T) => void) => {
      p.then((v) => { if (alive) set(v); }).catch(() => undefined);
    };
    keep(window.cth.relayStatus(), setStatus);
    keep(window.cth.relayHasSeatToken(), setHasToken);
    keep(window.cth.relayNodeIdentity(), setIdentity);
    const off = window.cth.onRelayStatus((s) => { if (alive) setStatus(s); });
    return () => { alive = false; off(); };
  }, []);

  // A code only reflects the credential at the moment it was minted, so it is
  // dropped as soon as the URL or the token changes.
  useEffect(() => { setCode(null); setCopied(false); }, [url, hasToken]);

  const say = (key: string, err = false) => setNotice({ key, err });

  async function saveRelay(connect: boolean) {
    setBusy('relay');
    setNotice(null);
    try {
      const next = url.trim();
      if (connect && !next) { say('team.urlRequired', true); return; }
      if (connect && !hasToken) { say('team.tokenRequired', true); return; }
      await window.cth.updateConfig({ relay: { enabled: connect, url: next } });
      say('team.saved');
    } catch {
      say('team.saveFailed', true);
    } finally {
      setBusy(null);
    }
  }

  async function saveToken() {
    setBusy('token');
    setNotice(null);
    try {
      const r = await window.cth.relaySetSeatToken(token.trim());
      if (r.ok) {
        setToken('');
        setHasToken(true);
        say('team.tokenSaved');
      } else {
        say('team.tokenFailed', true);
      }
    } finally {
      setBusy(null);
    }
  }

  async function forgetToken() {
    setBusy('token');
    setNotice(null);
    try {
      await window.cth.relayClearSeatToken();
      setHasToken(false);
      say('team.tokenForgotten');
    } finally {
      setBusy(null);
    }
  }

  async function showCode() {
    setBusy('code');
    setNotice(null);
    try {
      const r = await window.cth.relayJoinCode();
      if (r.ok) { setCode(r.code); setCopied(false); }
      else say(`team.joinCode.${r.error}`, true);
    } finally {
      setBusy(null);
    }
  }

  async function copyCode() {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
    } catch {
      say('team.copyFailed', true);
    }
  }

  async function join() {
    setBusy('join');
    setNotice(null);
    try {
      const r = await window.cth.relayApplyJoinCode(joinText);
      if (r.ok) {
        setJoinText('');
        setHasToken(true);
        say('team.joinOk');
      } else {
        say(`team.joinCode.${r.error}`, true);
      }
    } finally {
      setBusy(null);
    }
  }

  async function retry() {
    setBusy('retry');
    setNotice(null);
    try {
      await window.cth.relayRestart();
    } finally {
      setBusy(null);
    }
  }

  const state = status?.state ?? 'idle';

  return (
    <div style={{
      padding: 16, display: 'flex', flexDirection: 'column', gap: 12,
      maxWidth: 720
    }}>
      <div>
        <div style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 12, lineHeight: '16px',
          color: 'var(--cth-ink-900)'
        }}>{t('team.title')}</div>
        <div style={{ ...NOTE, marginTop: 2 }}>{t('team.sub')}</div>
      </div>

      {notice && (
        <div style={{
          padding: '6px 8px',
          background: notice.err ? 'var(--cth-coral)' : 'var(--cth-mint)',
          boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
          fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)'
        }} role="status">{t(notice.key)}</div>
      )}

      {/* ── Status ───────────────────────────────────────────────────────── */}
      <PixelPanel variant="default" title={t('team.status')} style={{ padding: 12 }}>
        <div style={ROW}>
          <span style={{
            padding: '2px 8px', background: STATE_FILL[state],
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
            fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '16px',
            color: 'var(--cth-ink-900)'
          }}>{t(`team.state.${state}`)}</span>
          {status && status.outboxDepth > 0 && (
            <span style={NOTE}>{t('team.outbox', { count: status.outboxDepth })}</span>
          )}
          {state === 'rejected' && (
            <PixelButton variant="secondary" size="sm" disabled={busy === 'retry'} onClick={() => void retry()}>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <Icon name="play" /> {t('team.retry')}
              </span>
            </PixelButton>
          )}
        </div>
        {state === 'rejected' && (
          <p style={{ ...NOTE, marginTop: 8, marginBottom: 0 }}>{t('team.rejectedHint')}</p>
        )}
        {status?.lastError && (
          <div style={{
            ...NOTE, marginTop: 6, fontFamily: 'var(--cth-font-mono)',
            wordBreak: 'break-word'
          }}>{status.lastError}</div>
        )}

        <div style={{ marginTop: 10, ...ROW }}>
          <span style={LABEL}>{t('team.identity')}</span>
          <span style={{
            fontFamily: 'var(--cth-font-mono)', fontSize: 12, color: 'var(--cth-ink-900)'
          }}>{identity ? `${identity.nodeName} · ${identity.nodeId}` : '—'}</span>
        </div>
        <div style={NOTE}>{t('team.identitySub')}</div>
      </PixelPanel>

      {/* ── Relay ────────────────────────────────────────────────────────── */}
      <PixelPanel variant="default" title={t('team.relay')} style={{ padding: 12 }}>
        <div style={{ ...NOTE, marginBottom: 10 }}>{t('team.relaySub')}</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={ROW}>
            <label style={LABEL} htmlFor="cth-relay-url">{t('team.url')}</label>
            <input
              id="cth-relay-url"
              className="cth-input"
              style={INPUT}
              value={url}
              spellCheck={false}
              autoComplete="off"
              placeholder={t('team.urlPlaceholder')}
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>

          <div style={ROW}>
            <label style={LABEL} htmlFor="cth-relay-token">{t('team.token')}</label>
            <input
              id="cth-relay-token"
              className="cth-input"
              style={INPUT}
              type="password"
              value={token}
              spellCheck={false}
              autoComplete="off"
              placeholder={hasToken ? '••••••••' : t('team.tokenPlaceholder')}
              onChange={(e) => setToken(e.target.value)}
            />
            <PixelButton
              variant="secondary"
              size="sm"
              disabled={busy === 'token' || !token.trim()}
              onClick={() => void saveToken()}
            >{t('team.saveToken')}</PixelButton>
            {hasToken && (
              <PixelButton
                variant="ghost"
                size="sm"
                disabled={busy === 'token'}
                onClick={() => void forgetToken()}
              >{t('team.forgetToken')}</PixelButton>
            )}
          </div>
          <div style={NOTE}>
            {hasToken ? t('team.tokenStored') : t('team.tokenMissing')}
          </div>

          <div style={{ ...ROW, marginTop: 4 }}>
            {enabled ? (
              <PixelButton
                variant="destructive"
                size="md"
                disabled={busy === 'relay'}
                onClick={() => void saveRelay(false)}
              >{t('team.disconnect')}</PixelButton>
            ) : (
              <PixelButton
                variant="primary"
                size="md"
                disabled={busy === 'relay'}
                onClick={() => void saveRelay(true)}
              >{t('team.connect')}</PixelButton>
            )}
          </div>
        </div>
      </PixelPanel>

      {/* ── Invite ───────────────────────────────────────────────────────── */}
      <PixelPanel variant="default" title={t('team.invite')} style={{ padding: 12 }}>
        <div style={NOTE}>{t('team.inviteSub')}</div>
        <div style={{ ...ROW, marginTop: 8 }}>
          <PixelButton
            variant="secondary"
            size="sm"
            disabled={busy === 'code'}
            onClick={() => {
              if (code) { setCode(null); setCopied(false); }
              else void showCode();
            }}
          >{code ? t('team.hideCode') : t('team.showCode')}</PixelButton>
          {code && (
            <PixelButton variant="secondary" size="sm" onClick={() => void copyCode()}>
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                <Icon name={copied ? 'check' : 'edit'} /> {copied ? t('team.copied') : t('team.copy')}
              </span>
            </PixelButton>
          )}
        </div>
        {code && (
          <div style={{
            marginTop: 8, padding: '8px', background: 'var(--cth-paper-100)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-300)',
            fontFamily: 'var(--cth-font-mono)', fontSize: 11, lineHeight: '16px',
            color: 'var(--cth-ink-900)',
            direction: 'ltr', unicodeBidi: 'isolate',
            wordBreak: 'break-all', userSelect: 'all'
          }}>{code}</div>
        )}
      </PixelPanel>

      {/* ── Join ─────────────────────────────────────────────────────────── */}
      <PixelPanel variant="default" title={t('team.join')} style={{ padding: 12 }}>
        <div style={NOTE}>{t('team.joinSub')}</div>
        <div style={{ ...ROW, marginTop: 8 }}>
          <input
            className="cth-input"
            style={INPUT}
            value={joinText}
            spellCheck={false}
            autoComplete="off"
            placeholder={t('team.joinPlaceholder')}
            onChange={(e) => setJoinText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void join(); }}
          />
          <PixelButton
            variant="primary"
            size="sm"
            disabled={busy === 'join' || !joinText.trim()}
            onClick={() => void join()}
          >{busy === 'join' ? t('team.joining') : t('team.joinButton')}</PixelButton>
        </div>
      </PixelPanel>
    </div>
  );
}
