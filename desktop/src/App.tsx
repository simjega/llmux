import { useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, Bell, CheckCircle2, ChevronDown, CircleDot, Gauge, LockKeyhole, Search, TerminalSquare } from 'lucide-react';
import { TerminalView } from './TerminalView';
import type { AppSnapshot, DiagnosticsSnapshot, ThreadSnapshot, ThreadStatus } from './shared/types';

type View = 'workspace' | 'activity' | 'diagnostics';

const toolGlyph: Record<string, string> = { claude: '✳', codex: '◇', opencode: '▣', amp: '◆', aider: '◈', term: '❯' };

const statusMeta: Record<ThreadStatus, { label: string; icon: typeof CircleDot }> = {
  blocked: { label: 'Needs input', icon: AlertCircle },
  perm: { label: 'Permission', icon: LockKeyhole },
  busy: { label: 'Running', icon: Activity },
  idle: { label: 'Ready', icon: CheckCircle2 },
  working: { label: 'Working', icon: CircleDot },
  unknown: { label: 'Unknown', icon: CircleDot },
};

const flattenThreads = (snapshot: AppSnapshot | null) => snapshot?.projects.flatMap((project) => project.threads) ?? [];

function StatusMark({ status, compact = false }: { status: ThreadStatus; compact?: boolean }) {
  const meta = statusMeta[status];
  const Icon = meta.icon;
  return <span className={`status-mark status-${status}`} title={meta.label}><Icon size={compact ? 12 : 14} />{compact ? null : meta.label}</span>;
}

function ThreadRow({ thread, selected, onSelect }: { thread: ThreadSnapshot; selected: boolean; onSelect: () => void }) {
  return (
    <button className={`thread-row ${selected ? 'selected' : ''}`} onClick={onSelect} data-testid={`thread-${thread.name}`}>
      <span className={`tool-glyph tool-${thread.tool}`}>{toolGlyph[thread.tool] ?? '●'}</span>
      <span className="thread-copy"><span className="thread-name">{thread.name}</span><span className="thread-detail">{thread.worktree || thread.cwd.split('/').filter(Boolean).at(-1)}</span></span>
      {(thread.status === 'blocked' || thread.status === 'perm' || thread.status === 'busy') && <StatusMark status={thread.status} compact />}
      {thread.unread && !['blocked', 'perm', 'busy'].includes(thread.status) && <span className="unread-dot" />}
    </button>
  );
}

function Diagnostics({ diagnostics }: { diagnostics: DiagnosticsSnapshot | null }) {
  if (!diagnostics) return <div className="empty-state"><Gauge size={28} /><h2>Loading diagnostics</h2></div>;
  const metrics = [
    ['Snapshot p50 / p95', `${diagnostics.snapshotP50Ms} / ${diagnostics.snapshotP95Ms} ms`],
    ['Terminal frame p50 / p95', `${diagnostics.terminalP50Ms} / ${diagnostics.terminalP95Ms} ms`],
    ['Snapshot polls', diagnostics.snapshotPolls.toLocaleString()],
    ['Terminal frames', diagnostics.terminalPolls.toLocaleString()],
    ['Stream events / bytes', `${diagnostics.terminalStreamEvents.toLocaleString()} / ${diagnostics.terminalStreamBytes.toLocaleString()}`],
    ['Command failures', diagnostics.commandFailures.toLocaleString()],
    ['Runtime', `${Math.round(diagnostics.uptimeMs / 1000)} sec`],
  ];
  return (
    <div className="inspector" data-testid="diagnostics-view">
      <div className="inspector-heading"><div><p className="eyebrow">OBSERVABILITY</p><h2>Runtime diagnostics</h2><p>Local, structured signals from the Electron main process and tmux adapter.</p></div><button className="secondary-button" onClick={() => void window.llmux.revealLogs()}>Reveal logs</button></div>
      <div className="metric-grid">{metrics.map(([label, value]) => <div className="metric-card" key={label}><span>{label}</span><strong>{value}</strong></div>)}</div>
      <div className="runtime-strip"><span><i className={`health-light ${diagnostics.commandFailures || !diagnostics.terminalStreamConnected ? 'warning' : ''}`} />{diagnostics.commandFailures || !diagnostics.terminalStreamConnected ? 'Degraded' : 'Healthy'}</span><span>{diagnostics.tmuxVersion}</span><span>{diagnostics.terminalStreamConnected ? 'Stream connected' : 'Stream reconnecting'}</span><span>Electron {diagnostics.electronVersion}</span><span>App {diagnostics.appVersion}</span></div>
      {diagnostics.lastError && <div className="last-error"><strong>Last error</strong><code>{diagnostics.lastError}</code></div>}
      <div className="event-list"><div className="section-title">Recent events</div>{diagnostics.recentEvents.map((event, index) => <div className="event-row" key={`${event.at}-${index}`}><time>{new Date(event.at).toLocaleTimeString()}</time><span className={`event-level ${event.level}`}>{event.level}</span><code>{event.event}</code>{event.durationMs !== undefined && <span>{event.durationMs} ms</span>}</div>)}</div>
      <p className="log-path">{diagnostics.logPath}</p>
    </div>
  );
}

export function App() {
  const [snapshot, setSnapshot] = useState<AppSnapshot | null>(null);
  const [selectedPaneId, setSelectedPaneId] = useState<string | null>(null);
  const [view, setView] = useState<View>('workspace');
  const [query, setQuery] = useState('');
  const [diagnostics, setDiagnostics] = useState<DiagnosticsSnapshot | null>(null);

  useEffect(() => {
    let disposed = false;
    const refresh = async () => {
      const next = await window.llmux.getSnapshot();
      if (disposed) return;
      setSnapshot(next);
      setSelectedPaneId((current) => {
        const threads = flattenThreads(next);
        return threads.some((thread) => thread.paneId === current) ? current : (threads.find((thread) => thread.active) ?? threads[0])?.paneId ?? null;
      });
    };
    void refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (view !== 'diagnostics') return undefined;
    let disposed = false;
    const refresh = async () => { const next = await window.llmux.getDiagnostics(); if (!disposed) setDiagnostics(next); };
    void refresh();
    const timer = window.setInterval(refresh, 1_000);
    return () => { disposed = true; window.clearInterval(timer); };
  }, [view]);

  const allThreads = flattenThreads(snapshot);
  const selectedThread = allThreads.find((thread) => thread.paneId === selectedPaneId) ?? null;
  const filteredProjects = useMemo(() => snapshot?.projects.map((project) => ({ ...project, threads: project.threads.filter((thread) => `${thread.name} ${thread.project} ${thread.cwd}`.toLowerCase().includes(query.toLowerCase())) })).filter((project) => project.threads.length) ?? [], [snapshot, query]);
  const activityThreads = allThreads.filter((thread) => ['blocked', 'perm', 'busy'].includes(thread.status) || thread.unread);

  const selectThread = (thread: ThreadSnapshot) => {
    setSelectedPaneId(thread.paneId);
    setView('workspace');
    window.llmux.reportRendererEvent('thread.selected', { paneId: thread.paneId, tool: thread.tool, project: thread.project });
  };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="drag-region" />
        <div className="brand-row"><div className="brand-mark">ll</div><div><strong>llmux</strong><span>desktop preview</span></div><span className={`connection-dot ${snapshot?.connected ? 'online' : ''}`} title={snapshot?.connected ? 'Connected' : 'Disconnected'} /></div>
        <button className={`activity-button ${view === 'activity' ? 'active' : ''}`} onClick={() => setView('activity')} data-testid="activity-button"><Bell size={15} /><span>Activity</span><span className="activity-count">{(snapshot?.attentionCount ?? 0) + (snapshot?.unreadCount ?? 0)}</span></button>
        <label className="search-box"><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a thread" aria-label="Find a thread" /></label>
        <div className="project-list">
          {filteredProjects.map((project) => <section className="project-group" key={project.name} data-testid={`project-${project.name}`}><header><ChevronDown size={12} /><span>{project.name}</span><small>{project.threads.length}</small></header>{project.threads.map((thread) => <ThreadRow key={thread.paneId} thread={thread} selected={selectedPaneId === thread.paneId} onSelect={() => selectThread(thread)} />)}</section>)}
        </div>
        <button className={`diagnostics-button ${view === 'diagnostics' ? 'active' : ''}`} onClick={() => setView('diagnostics')}><Gauge size={15} /><span>Diagnostics</span><span className="shortcut">⌘D</span></button>
      </aside>

      <section className="workspace">
        <div className="workspace-drag-region" />
        {view === 'workspace' && selectedThread && <><header className="workspace-header"><div><div className="header-title"><span className={`tool-glyph tool-${selectedThread.tool}`}>{toolGlyph[selectedThread.tool] ?? '●'}</span><h1>{selectedThread.name}</h1><StatusMark status={selectedThread.status} /></div><div className="breadcrumbs"><span>{selectedThread.project}</span><b>/</b><span>{selectedThread.worktree || selectedThread.cwd}</span>{selectedThread.slot && <><b>/</b><span>{selectedThread.slot}</span></>}</div></div><div className="header-actions"><span className="session-pill">{snapshot?.session}</span><button className="icon-button" onClick={() => setView('diagnostics')} title="Open diagnostics"><Gauge size={16} /></button></div></header><div className="workspace-body"><div className="surface-label"><TerminalSquare size={14} />Live pane</div><TerminalView thread={selectedThread} /></div></>}
        {view === 'workspace' && !selectedThread && <div className="empty-state"><TerminalSquare size={32} /><h2>No llmux threads found</h2><p>{snapshot?.error || `Start or connect to the “${snapshot?.session ?? 'llmux'}” tmux session.`}</p></div>}
        {view === 'activity' && <div className="activity-view" data-testid="activity-view"><div className="activity-heading"><p className="eyebrow">ATTENTION QUEUE</p><h1>Activity</h1><p>Running work, unread completions, and threads that need you—separate from project navigation.</p></div><div className="activity-list">{activityThreads.length === 0 ? <div className="empty-activity"><CheckCircle2 size={26} /><strong>Nothing needs attention</strong></div> : activityThreads.map((thread) => <button key={thread.paneId} onClick={() => selectThread(thread)}><span className={`tool-glyph tool-${thread.tool}`}>{toolGlyph[thread.tool] ?? '●'}</span><span><strong>{thread.name}</strong><small>{thread.project} · {thread.cwd}</small></span><StatusMark status={thread.status} />{thread.unread && <span className="ready-chip">Unread</span>}</button>)}</div></div>}
        {view === 'diagnostics' && <Diagnostics diagnostics={diagnostics} />}
      </section>
    </main>
  );
}
