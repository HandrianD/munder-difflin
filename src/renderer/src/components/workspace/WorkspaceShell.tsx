import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useStore, selectedAgent, triggerHistoryVisible } from '@/store/store';
import { Icon, type IconName } from '@/components/Icon';
import { PixelButton } from '@/components/PixelButton';
import { PixelPanel } from '@/components/PixelPanel';
import { SpritePortrait } from '@/components/SpritePortrait';
import { AgentDetailPanel } from '@/components/AgentDetailPanel';
import { TasksKanban, parseTasks, waitsOnHuman } from '@/components/TasksKanban';
import { AskMeTab } from '@/components/AskMeTab';
import { TriggersTab } from '@/components/triggers/TriggersTab';
import { TriggerHistoryTab } from '@/components/triggers/TriggerHistoryTab';
import { MemoryTab } from '@/components/CommandCenterPanel';
import { MemoryGraphPanel } from '@/components/MemoryGraphPanel';
import { SkillsTab } from '@/components/SkillsTab';
import { WorkersTab } from '@/components/WorkersTab';
import { TeamTab } from '@/components/workspace/TeamTab';
import { useRestoreTeam } from '@/hooks/useRestoreTeam';
import { useRtl } from '@/i18n/useDirection';
import type { HarnessConfig } from '@/store/config';

/** The screens of the workspace shell. Kept as a union rather than a
 *  string so a typo in a `setScreen` call fails the build instead of silently
 *  blanking the content pane. */
export type WorkspaceScreen =
  | 'agents' | 'tasks' | 'inbox' | 'automations' | 'memory' | 'capabilities' | 'temps'
  | 'team';

const LS_SCREEN = 'cth.workspaceScreen';

const NAV: { key: WorkspaceScreen; labelKey: string; icon: IconName }[] = [
  { key: 'agents',       labelKey: 'workspace.nav.agents',       icon: 'mcp' },
  { key: 'tasks',        labelKey: 'workspace.nav.tasks',        icon: 'check' },
  { key: 'inbox',        labelKey: 'workspace.nav.inbox',        icon: 'bell' },
  { key: 'automations',  labelKey: 'workspace.nav.automations',  icon: 'clock' },
  { key: 'memory',       labelKey: 'workspace.nav.memory',       icon: 'sparkle' },
  { key: 'capabilities', labelKey: 'workspace.nav.capabilities', icon: 'code' },
  { key: 'temps',        labelKey: 'workspace.nav.temps',        icon: 'gear' },
  { key: 'team',         labelKey: 'workspace.nav.team',         icon: 'web' }
];

function isScreen(v: string | null): v is WorkspaceScreen {
  return !!v && NAV.some((n) => n.key === v);
}

/** A second row of tabs inside one nav screen (automations, memory). Shares
 *  `.cth-tabbar` with the Command Center so the strip behaves identically:
 *  one row that scrolls rather than wrapping. */
function SubTabs({
  tabs, active, onChange
}: {
  tabs: { key: string; labelKey: string }[];
  active: string;
  onChange: (key: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="cth-tabbar" style={{
      display: 'flex', gap: 4, padding: '6px 8px', flexShrink: 0, overflowX: 'auto',
      background: 'var(--cth-cream-100)', borderBottom: '1px solid var(--cth-ink-700)'
    }}>
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          style={{
            flex: '1 0 auto', padding: '4px 8px 3px', border: 'none', cursor: 'pointer',
            fontFamily: 'var(--cth-font-ui)', fontSize: 13, whiteSpace: 'nowrap',
            background: active === tab.key ? 'var(--cth-mint)' : 'var(--cth-cream-200)',
            color: 'var(--cth-ink-900)',
            boxShadow: active === tab.key
              ? 'inset 0 0 0 1px var(--cth-ink-300)'
              : 'inset 0 0 0 1px var(--cth-ink-100)'
          }}
        >{t(tab.labelKey)}</button>
      ))}
    </div>
  );
}

/** Empty content pane — centred panel, no chrome of its own. */
function EmptyPane({ titleKey, subKey }: { titleKey: string; subKey?: string }) {
  const { t } = useTranslation();
  return (
    <PixelPanel variant="default" noPadding style={{
      padding: 16, height: '100%',
      display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: 12
    }}>
      <div style={{
        fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '14px',
        color: 'var(--cth-ink-500)', textAlign: 'center'
      }}>{t(titleKey)}</div>
      {subKey && (
        <p style={{ margin: 0, fontSize: 13, textAlign: 'center', color: 'var(--cth-ink-700)' }}>
          {t(subKey)}
        </p>
      )}
    </PixelPanel>
  );
}

/**
 * Pro-style workspace shell: a left nav rail with the screens and a
 * right content pane that reuses the existing panels as-is. It is a UI mode,
 * not a tier — no gate, no seat check — and it replaces the office floor
 * entirely while active (App.tsx switches on `config.uiMode`).
 *
 * The right-hand sidebar's own state (`SidebarTab`: terminal/messages/traces/
 * git) is untouched: workspace nav is separate state so that rail keeps working
 * for anyone who switches back to the floor.
 */
export function WorkspaceShell({ config }: { config: HarnessConfig }) {
  const { t } = useTranslation();
  const rtl = useRtl();

  const [screen, setScreen] = useState<WorkspaceScreen>(() => {
    try {
      const saved = window.localStorage.getItem(LS_SCREEN);
      return isScreen(saved) ? saved : 'agents';
    } catch { return 'agents'; }
  });
  useEffect(() => {
    try { window.localStorage.setItem(LS_SCREEN, screen); } catch { /* noop */ }
  }, [screen]);

  // Sub-tabs live here rather than in each screen so switching nav away and
  // back keeps where you were.
  const [autoTab, setAutoTab] = useState<'triggers' | 'history'>('triggers');
  const [memTab, setMemTab] = useState<'memory' | 'graph'>('memory');
  const [memoryWho, setMemoryWho] = useState<string | undefined>(undefined);

  const agents = useStore((s) => s.agents);
  const select = useStore((s) => s.select);
  const setAddAgentOpen = useStore((s) => s.setAddAgentOpen);
  const godStatus = useStore((s) => s.godStatus);
  const selected = useStore(selectedAgent);
  const showHistory = useStore(triggerHistoryVisible);
  const restorable = useStore((s) => s.restorableAgents);
  // Mounted here as well as in AgentStrip: the hook's module-level `autoStarted`
  // latch makes the boot restore fire exactly once no matter how many places ask
  // for it, and the floor strip is NOT rendered while this shell is — without a
  // mount point here, "restore team" would silently stop happening at startup.
  const { restoring, autoRestoring, restoreTeam } = useRestoreTeam(config);
  const restoreBusy = restoring || autoRestoring;

  // Never leave the screen parked on a sub-tab that has just been hidden
  // (mirrors the Command Center's rule for its history tab).
  useEffect(() => {
    if (!showHistory && autoTab === 'history') setAutoTab('triggers');
  }, [showHistory, autoTab]);

  // The nav badge is the one piece of state the shell owns outright: AskMeTab
  // only mounts when its screen is open, but the badge has to be right before
  // you click. Same 5s cadence as every other task reader.
  const [pending, setPending] = useState(0);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const raw = await window.cth.hiveTasks();
        if (!alive) return;
        setPending(parseTasks(raw).filter(waitsOnHuman).length);
      } catch { /* main not ready — keep the last count */ }
    };
    void tick();
    const timer = setInterval(() => void tick(), 5000);
    return () => { alive = false; clearInterval(timer); };
  }, []);

  const god = agents.find((a) => a.isGod);
  const railBorder = rtl
    ? 'inset 1px 0 0 var(--cth-ink-300)'
    : 'inset -1px 0 0 var(--cth-ink-300)';

  const autoTabs = [
    { key: 'triggers', labelKey: 'commandCenter.tabs.triggers' },
    ...(showHistory ? [{ key: 'history', labelKey: 'commandCenter.tabs.history' }] : [])
  ];
  const memTabs = [
    { key: 'memory', labelKey: 'commandCenter.tabs.memory' },
    { key: 'graph',  labelKey: 'commandCenter.tabs.graph' }
  ];

  return (
    <div style={{ flex: 1, minWidth: 0, minHeight: 0, display: 'flex' }}>

      {/* ── Nav rail ─────────────────────────────────────────────────────── */}
      <nav style={{
        width: 176, flexShrink: 0, minHeight: 0,
        display: 'flex', flexDirection: 'column',
        background: 'var(--cth-cream-100)', boxShadow: railBorder
      }}>
        <div style={{
          padding: '8px 10px', fontFamily: 'var(--cth-font-display)', fontSize: 9,
          lineHeight: '12px', color: 'var(--cth-ink-500)', flexShrink: 0
        }}>{t('workspace.title')}</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, padding: '0 6px 6px' }}>
          {NAV.map((item) => {
            const active = screen === item.key;
            const badge = item.key === 'inbox' && pending > 0 ? pending : null;
            return (
              <button
                key={item.key}
                onClick={() => setScreen(item.key)}
                aria-current={active ? 'page' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                  padding: '7px 8px', border: 'none', cursor: 'pointer',
                  fontFamily: 'var(--cth-font-ui)', fontSize: 13,
                  background: active ? 'var(--cth-paper-100)' : 'transparent',
                  color: active ? 'var(--cth-ink-900)' : 'var(--cth-ink-700)',
                  boxShadow: active
                    ? 'inset 0 0 0 1px var(--cth-ink-300)'
                    : 'inset 0 0 0 1px transparent'
                }}
              >
                <Icon name={item.icon} />
                <span style={{
                  flex: 1, minWidth: 0, textAlign: 'start',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                }}>{t(item.labelKey)}</span>
                {badge !== null && (
                  <span
                    className="cth-tip"
                    data-tip={t('workspace.inboxPending', { count: badge })}
                    aria-label={t('workspace.inboxPending', { count: badge })}
                    style={{
                      minWidth: 18, padding: '0 4px', background: 'var(--cth-coral)',
                      boxShadow: 'inset 0 0 0 1px var(--cth-ink-700)',
                      fontFamily: 'var(--cth-font-display)', fontSize: 10, lineHeight: '16px',
                      textAlign: 'center', color: 'var(--cth-ink-900)'
                    }}
                  >{badge}</span>
                )}
              </button>
            );
          })}
        </div>

        <div style={{ marginTop: 'auto', padding: 8, display: 'flex', flexDirection: 'column', gap: 6, flexShrink: 0 }}>
          {(restorable.length > 0 || restoreBusy) && (
            <PixelButton
              variant="secondary"
              size="sm"
              fullWidth
              disabled={restoreBusy}
              onClick={() => { void restoreTeam(); }}
              title={
                restoreBusy
                  ? t('agentStrip.restoringTeam')
                  : t('agentStrip.restoreTitle', { names: restorable.map((a) => a.name).join(', ') })
              }
            >
              <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
                <Icon name="play" />
                {restoreBusy
                  ? t('agentStrip.restoringTeam')
                  : t('agentStrip.restoreTeam', { count: restorable.length })}
              </span>
            </PixelButton>
          )}
          <PixelButton variant="secondary" size="sm" fullWidth onClick={() => setAddAgentOpen(true)}>
            <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="plus" /> {t('agentStrip.addAgent')}
            </span>
          </PixelButton>
        </div>
      </nav>

      {/* ── Content pane ─────────────────────────────────────────────────── */}
      <div style={{
        flex: 1, minWidth: 0, minHeight: 0,
        display: 'flex', flexDirection: 'column'
      }}>

        {screen === 'agents' && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
            {/* Roster */}
            <div style={{
              width: 208, flexShrink: 0, minHeight: 0,
              display: 'flex', flexDirection: 'column',
              background: 'var(--cth-cream-200)', boxShadow: railBorder
            }}>
              <div style={{
                padding: '8px 10px', fontFamily: 'var(--cth-font-display)', fontSize: 9,
                lineHeight: '12px', color: 'var(--cth-ink-500)', flexShrink: 0
              }}>{t('workspace.roster')}</div>
              <div className="cth-scroll-hidden" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>
                {agents.length === 0 ? (
                  <div style={{ padding: 10, fontSize: 12, color: 'var(--cth-ink-500)' }}>
                    {godStatus === 'booting' ? t('workspace.booting') : t('workspace.emptyRoster')}
                    <div style={{ marginTop: 6, fontSize: 11, color: 'var(--cth-ink-300)' }}>
                      {t('workspace.emptyRosterSub')}
                    </div>
                  </div>
                ) : agents.map((a) => {
                  const on = selected?.id === a.id;
                  return (
                    <button
                      key={a.id}
                      onClick={() => select(a.id)}
                      style={{
                        width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                        padding: '6px 8px', border: 'none', cursor: 'pointer', textAlign: 'start',
                        background: on ? 'var(--cth-paper-100)' : 'transparent',
                        boxShadow: on
                          ? 'inset 0 0 0 1px var(--cth-ink-300)'
                          : 'inset 0 0 0 1px transparent'
                      }}
                    >
                      <SpritePortrait character={a.character} scale={1} />
                      <span style={{
                        flex: 1, minWidth: 0, fontFamily: 'var(--cth-font-ui)', fontSize: 12,
                        color: 'var(--cth-ink-900)',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                      }}>{a.name}</span>
                      {a.isGod && (
                        <span style={{
                          fontFamily: 'var(--cth-font-display)', fontSize: 8,
                          color: 'var(--cth-ink-500)', flexShrink: 0
                        }}>{t('commandCenter.godTag')}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Detail — AgentDetailPanel is height:100%, so it needs the same
                definite-height column App.tsx gives it in the sidebar. */}
            <div style={{
              flex: 1, minWidth: 0, minHeight: 0,
              display: 'flex', flexDirection: 'column'
            }}>
              {selected ? (
                <AgentDetailPanel agent={selected} />
              ) : (
                <EmptyPane
                  titleKey="workspace.noAgentSelected"
                  subKey="workspace.noAgentSelectedSub"
                />
              )}
            </div>
          </div>
        )}

        {screen === 'tasks' && <TasksKanban />}

        {screen === 'inbox' && <AskMeTab />}

        {screen === 'automations' && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {autoTabs.length > 1 && (
              <SubTabs tabs={autoTabs} active={autoTab} onChange={(k) => setAutoTab(k as 'triggers' | 'history')} />
            )}
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {autoTab === 'history' && showHistory
                ? <TriggerHistoryTab />
                : <TriggersTab />}
            </div>
          </div>
        )}

        {screen === 'memory' && (god ? (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <SubTabs tabs={memTabs} active={memTab} onChange={(k) => setMemTab(k as 'memory' | 'graph')} />
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
              {memTab === 'graph' ? (
                <MemoryGraphPanel
                  godId={god.id}
                  onJumpToMemory={(id) => { setMemoryWho(id); setMemTab('memory'); }}
                />
              ) : (
                <MemoryTab godId={god.id} who={memoryWho} onWho={setMemoryWho} />
              )}
            </div>
          </div>
        ) : (
          <EmptyPane titleKey="workspace.noGodMemory" />
        ))}

        {screen === 'capabilities' && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <SkillsTab agentCwd={selected?.cwd ?? god?.cwd} />
          </div>
        )}

        {screen === 'temps' && (
          <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <WorkersTab />
          </div>
        )}

        {screen === 'team' && (
          <div className="cth-scroll-hidden" style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
            <TeamTab config={config} />
          </div>
        )}

      </div>
    </div>
  );
}
