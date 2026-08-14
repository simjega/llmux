export type ThreadStatus = 'blocked' | 'perm' | 'busy' | 'idle' | 'working' | 'unknown';

export interface ThreadSnapshot {
  paneId: string;
  name: string;
  tool: string;
  project: string;
  cwd: string;
  status: ThreadStatus;
  statusSource: string;
  worktree: string;
  slot: string;
  pinned: boolean;
  terminal: boolean;
  active: boolean;
  doneAt: number | null;
  unread: boolean;
  order: number;
}

export interface ProjectSnapshot {
  name: string;
  threads: ThreadSnapshot[];
  attentionCount: number;
  unreadCount: number;
}

export interface AppSnapshot {
  session: string;
  connected: boolean;
  observedAt: string;
  latencyMs: number;
  projects: ProjectSnapshot[];
  threadCount: number;
  attentionCount: number;
  unreadCount: number;
  error?: string;
}

export interface TerminalFrame {
  paneId: string;
  content: string;
  cursorX: number;
  cursorY: number;
  width: number;
  height: number;
  latencyMs: number;
  observedAt: string;
}

export interface TerminalOutputEvent {
  paneId: string;
  receivedAt: number;
}

export interface TerminalStreamState {
  connected: boolean;
}

export interface TelemetryEvent {
  at: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  event: string;
  durationMs?: number;
  details?: Record<string, unknown>;
}

export interface DiagnosticsSnapshot {
  appVersion: string;
  electronVersion: string;
  tmuxVersion: string;
  logPath: string;
  uptimeMs: number;
  snapshotPolls: number;
  terminalPolls: number;
  terminalStreamEvents: number;
  terminalStreamBytes: number;
  terminalStreamConnected: boolean;
  commandFailures: number;
  snapshotP50Ms: number;
  snapshotP95Ms: number;
  terminalP50Ms: number;
  terminalP95Ms: number;
  lastError: string | null;
  recentEvents: TelemetryEvent[];
}

export interface LlmuxDesktopApi {
  getSnapshot(): Promise<AppSnapshot>;
  getTerminalFrame(paneId: string): Promise<TerminalFrame>;
  sendTerminalInput(paneId: string, data: string): Promise<void>;
  sendTerminalKey(paneId: string, key: string): Promise<void>;
  onTerminalOutput(listener: (event: TerminalOutputEvent) => void): () => void;
  onTerminalStreamState(listener: (state: TerminalStreamState) => void): () => void;
  getDiagnostics(): Promise<DiagnosticsSnapshot>;
  revealLogs(): Promise<void>;
  reportRendererEvent(event: string, details?: Record<string, unknown>): void;
}
