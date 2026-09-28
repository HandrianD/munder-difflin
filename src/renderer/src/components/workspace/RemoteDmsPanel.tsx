import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore } from '@/store/store';
import { Icon } from '@/components/Icon';
import { PixelButton } from '@/components/PixelButton';
import { PixelPanel } from '@/components/PixelPanel';
import { markThreadSeen, unreadAfter } from '@/components/workspace/remoteDmSeen';
import type { RemoteThread } from '@shared/remoteDm';

const POLL_MS = 5000;

const NOTE: CSSProperties = {
  fontSize: 11, lineHeight: '16px', color: 'var(--cth-ink-500)'
};

const INPUT: CSSProperties = {
  flex: '1 1 160px', minWidth: 0, padding: '6px 8px',
  background: 'var(--cth-paper-100)', border: 'none',
  fontFamily: 'var(--cth-font-ui)', fontSize: 12, color: 'var(--cth-ink-900)',
  outline: 'none'
};

const timeOf = (iso: string): number => {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * Cross-machine conversations, shown at the top of the Inbox screen.
 *
 * These are deliberately NOT read from `hiveInbox`: local mail drains to
 * `.done` the moment an agent handles it, so the inbox is a queue of what is
 * still owed. A conversation with another machine is a record, and this panel
 * reads the archive that outlives the queue.
 *
 * Replying goes through the ordinary `hiveSend` path — there is no "remote
 * send": a message with no local recipient is exactly what the relay seam
 * already picks up. What matters is the SENDING id: it must be a real local
 * agent id, because the other machine resolves `human`/`god` to ITS own
 * orchestrator and the reply would never come back over the wire.
 */
export function RemoteDmsPanel() {
  const { t } = useTranslation();
  const godId = useStore((s) => s.agents.find((a) => a.isGod)?.id);

  const [threads, setThreads] = useState<RemoteThread[]>([]);
  const [activeKey, setActiveKey] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const next = await window.cth.hiveRemoteDms();
        if (!alive) return;
        setThreads(next);
      } catch { /* main not ready — keep the last listing */ }
    };
    void tick();
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const active = useMemo(
    () => threads.find((th) => th.key === activeKey) ?? threads[0] ?? null,
    [threads, activeKey]
  );

  // Marking read is driven by the listing, not by a click, so a thread that
  // arrives while the panel is open still clears its badge on the next tick.
  useEffect(() => {
    if (open && active) markThreadSeen(active);
  }, [open, active]);

  /**
   * The id to send AS. The newest inbound message names the local agent the
   * peer is actually talking to, and a reply from that id is routable straight
   * back to us. Broadcast (which has no single local recipient) and the
   * `human`/`god` aliases fall back to the orchestrator's real id — the aliases
   * would be re-resolved to the OTHER machine's orchestrator and the
   * conversation would end there.
   */
  function sendingAs(): string | null {
    if (!active) return null;
    const inbound = [...active.messages].reverse().find((m) => m.direction === 'in');
    const to = inbound?.to;
    if (to && to !== 'broadcast' && to !== 'human' && to !== 'god') return to;
    return godId ?? null;
  }

  async function reply() {
    const body = draft.trim();
    if (!active || !body) return;
    const from = sendingAs();
    if (!from) { setError('remoteDms.sendFailed'); return; }
    setBusy(true);
    setError(null);
    const last = active.messages[active.messages.length - 1];
    try {
      const r = await window.cth.hiveSend({
        to: active.peer,
        conversation: last?.conversation,
        in_reply_to: last?.id ?? null,
        act: 'inform',
        subject: last?.subject ? `Re: ${last.subject}` : '',
        body
      }, from);
      if (r?.ok === false) setError('remoteDms.sendFailed');
      else setDraft('');
    } catch {
      setError('remoteDms.sendFailed');
    } finally {
      setBusy(false);
    }
  }

  const unread = threads.reduce((n, th) => n + unreadAfter(th), 0);

  if (threads.length === 0) {
    return (
      <PixelPanel variant="inset" style={{ margin: 12, padding: 12, flexShrink: 0 }}>
        <div style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px',
          color: 'var(--cth-ink-500)', marginBottom: 4
        }}>{t('remoteDms.title')}</div>
        <div style={{ fontSize: 12, color: 'var(--cth-ink-700)' }}>{t('remoteDms.empty')}</div>
        <div style={{ ...NOTE, marginTop: 2 }}>{t('remoteDms.emptySub')}</div>
      </PixelPanel>
    );
  }

  return (
    <PixelPanel variant="inset" noPadding style={{ margin: 12, flexShrink: 0, overflow: 'hidden' }}>
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px',
        background: 'var(--cth-cream-200)',
        borderBottom: open ? '1px solid var(--cth-ink-100)' : 'none'
      }}>
        <span style={{
          fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '12px',
          color: 'var(--cth-ink-500)'
        }}>{t('remoteDms.title')}</span>
        {unread > 0 && (
          <span style={{
            minWidth: 18, padding: '0 4px', background: 'var(--cth-coral)',
            boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
            fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '16px',
            textAlign: 'center', color: 'var(--cth-ink-900)'
          }} aria-label={t('remoteDms.unread', { count: unread })}>{unread}</span>
        )}
        <span style={{ flex: 1 }} />
        <PixelButton variant="ghost" size="sm" onClick={() => setOpen((v) => !v)}>
          {open ? t('remoteDms.hide') : t('remoteDms.show')}
        </PixelButton>
      </div>

      {open && (
        <div style={{ display: 'flex', minHeight: 0, maxHeight: 320 }}>
          {/* Thread list */}
          <div className="cth-scroll-hidden" style={{
            width: 168, flexShrink: 0, overflowY: 'auto',
            borderRight: '1px solid var(--cth-ink-100)'
          }}>
            {threads.map((th) => {
              const on = active?.key === th.key;
              const n = unreadAfter(th);
              return (
                <button
                  key={th.key}
                  onClick={() => setActiveKey(th.key)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'start',
                    padding: '6px 8px', border: 'none', cursor: 'pointer',
                    background: on ? 'var(--cth-paper-100)' : 'transparent',
                    boxShadow: on ? 'inset 0 0 0 1px var(--cth-ink-300)' : 'inset 0 0 0 1px transparent'
                  }}
                >
                  <span style={{
                    display: 'block', fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                    color: 'var(--cth-ink-900)', overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  }}>{th.peer}</span>
                  <span style={{
                    display: 'block', fontFamily: 'var(--cth-font-mono)', fontSize: 10,
                    color: n > 0 ? 'var(--cth-ink-900)' : 'var(--cth-ink-500)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  }}>{th.node}</span>
                  {n > 0 && (
                    <span style={{
                      display: 'inline-block', marginTop: 2, padding: '0 4px',
                      background: 'var(--cth-coral)',
                      fontFamily: 'var(--cth-font-display)', fontSize: 9, lineHeight: '14px',
                      color: 'var(--cth-ink-900)'
                    }}>{n}</span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Thread */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div className="cth-scroll-hidden" style={{
              flex: 1, minHeight: 0, maxHeight: 240, overflowY: 'auto', padding: 8
            }}>
              {active && active.messages.map((m) => (
                <div key={m.id} style={{ marginBottom: 8 }}>
                  <div style={{
                    ...NOTE, fontFamily: 'var(--cth-font-mono)', fontSize: 10
                  }}>
                    {t(m.direction === 'in' ? 'remoteDms.directionIn' : 'remoteDms.directionOut')}
                    {' · '}
                    {new Date(timeOf(m.created_at)).toLocaleString()}
                  </div>
                  {m.subject ? (
                    <div style={{
                      fontFamily: 'var(--cth-font-ui)', fontSize: 12, fontWeight: 600,
                      color: 'var(--cth-ink-900)'
                    }}>{m.subject}</div>
                  ) : null}
                  <div style={{
                    whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 12,
                    color: 'var(--cth-ink-700)'
                  }}>{m.body}</div>
                </div>
              ))}
            </div>

            <div style={{
              display: 'flex', gap: 6, alignItems: 'center', padding: 6,
              borderTop: '1px solid var(--cth-ink-100)', background: 'var(--cth-cream-100)'
            }}>
              <input
                className="cth-input"
                style={INPUT}
                value={draft}
                placeholder={t('remoteDms.replyPlaceholder', { peer: active?.peer ?? '' })}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void reply(); }}
              />
              <PixelButton
                variant="primary"
                size="sm"
                disabled={busy || !draft.trim()}
                onClick={() => void reply()}
              >
                <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                  <Icon name="arrow-right" />
                  {busy ? t('remoteDms.sending') : t('remoteDms.send')}
                </span>
              </PixelButton>
            </div>

            {error && (
              <div style={{ ...NOTE, padding: '4px 8px', color: 'var(--cth-coral)' }}>
                {t(error)}
              </div>
            )}
          </div>
        </div>
      )}
    </PixelPanel>
  );
}
