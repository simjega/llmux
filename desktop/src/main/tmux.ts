import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import type { AppSnapshot, ProjectSnapshot, TerminalFrame, TerminalOutputEvent, TerminalStreamState, ThreadSnapshot, ThreadStatus } from '../shared/types';
import { isControlLayoutChange, parseControlOutput } from './control-protocol';
import type { Telemetry } from './telemetry';

const execFileAsync = promisify(execFile);
const FIELD_SEPARATOR = '\t';
const PANE_ID_PATTERN = /^%\d+$/;
const TERMINAL_KEYS = new Set([
  'Up', 'Down', 'Left', 'Right', 'Home', 'End', 'PageUp', 'PageDown',
  'IC', 'DC', 'Enter', 'Tab', 'BTab', 'BSpace', 'Escape',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
]);
const FRAME_MARKER = '__LLMUX_DESKTOP_FRAME_METADATA__';
const SNAPSHOT_FORMAT = [
  '#{pane_id}', '#{@llmux_name}', '#{@llmux_tool}', '#{@llmux_project}',
  '#{pane_current_path}', '#{@llmux_status}', '#{@llmux_status_src}',
  '#{@llmux_worktree}', '#{@llmux_slot}', '#{@llmux_pinned}',
  '#{@llmux_terminal}', '#{@llmux_done_at}', '#{@llmux_order}',
  '#{pane_active}', '#{window_active}', '#{@llmux_sidebar}', '#{@llmux_parked_anchor}',
].join(FIELD_SEPARATOR);

export const runCommandWithInput = (executable: string, args: string[], input: string): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(executable, args, { env: process.env, stdio: ['pipe', 'ignore', 'ignore'] });
  let processError: Error | null = null;
  let stdinError: Error | null = null;
  let timedOut = false;
  let forceKillTimer: NodeJS.Timeout | null = null;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    forceKillTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL');
    }, 250);
  }, 3_000);
  child.on('error', (error) => {
    processError = error;
  });
  child.stdin.on('error', (error) => {
    stdinError = error;
    child.kill('SIGTERM');
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    if (timedOut) reject(new Error('tmux input command timed out'));
    else if (processError) reject(processError);
    else if (stdinError) reject(stdinError);
    else if (code === 0) resolve();
    else reject(new Error('tmux input command failed'));
  });
  try {
    child.stdin.end(input);
  } catch (error) {
    stdinError = error instanceof Error ? error : new Error('tmux stdin failed');
    child.kill('SIGTERM');
  }
});

const normalizeStatus = (status: string): ThreadStatus => {
  if (status === 'waiting') return 'idle';
  if (['blocked', 'perm', 'busy', 'idle', 'working'].includes(status)) return status as ThreadStatus;
  return status ? 'unknown' : 'working';
};

const parseInteger = (value: string, fallback: number): number => {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
};

export const parseThreads = (raw: string): ThreadSnapshot[] => raw
  .split('\n')
  .filter(Boolean)
  .map((line): ThreadSnapshot | null => {
    const [
      paneId, name, tool, project, cwd, status, statusSource, worktree, slot,
      pinned, terminal, doneAtRaw, orderRaw, paneActive, windowActive, sidebar, parkedAnchor,
    ] = line.split(FIELD_SEPARATOR);
    if (!PANE_ID_PATTERN.test(paneId) || !name || sidebar === '1' || parkedAnchor === '1') return null;
    const doneAt = parseInteger(doneAtRaw, 0);
    return {
      paneId,
      name,
      tool: tool || (terminal === '1' ? 'term' : 'unknown'),
      project: project || 'SCRATCH',
      cwd,
      status: normalizeStatus(status),
      statusSource,
      worktree,
      slot,
      pinned: pinned === '1',
      terminal: terminal === '1',
      active: paneActive === '1' && windowActive === '1',
      doneAt: doneAt > 0 ? doneAt : null,
      unread: doneAt > 0,
      order: parseInteger(orderRaw, 50),
    };
  })
  .filter((thread): thread is ThreadSnapshot => thread !== null)
  .sort((a, b) => a.order - b.order || Number(b.pinned) - Number(a.pinned) || a.name.localeCompare(b.name));

const groupProjects = (threads: ThreadSnapshot[]): ProjectSnapshot[] => {
  const groups = new Map<string, ThreadSnapshot[]>();
  for (const thread of threads) groups.set(thread.project, [...(groups.get(thread.project) ?? []), thread]);
  return [...groups.entries()]
    .sort(([left], [right]) => left === 'SCRATCH' ? -1 : right === 'SCRATCH' ? 1 : left.localeCompare(right))
    .map(([name, projectThreads]) => ({
      name,
      threads: projectThreads,
      attentionCount: projectThreads.filter((thread) => thread.status === 'blocked' || thread.status === 'perm').length,
      unreadCount: projectThreads.filter((thread) => thread.unread).length,
    }));
};

export class TmuxClient {
  readonly session: string;
  private tmuxVersion = 'unavailable';
  private tmuxExecutable = 'tmux';
  private inputQueues = new Map<string, Promise<void>>();
  private pasteSequence = 0;
  private knownPaneIds = new Set<string>();
  private controlProcess: ChildProcessWithoutNullStreams | null = null;
  private controlBuffer = '';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private streamConnected = false;
  private outputListeners = new Set<(event: TerminalOutputEvent) => void>();
  private streamStateListeners = new Set<(state: TerminalStreamState) => void>();

  constructor(private readonly telemetry: Telemetry) {
    this.session = process.env.LLMUX_DESKTOP_SESSION || process.env.LLMUX_SESSION || 'llmux';
  }

  private async tmux(args: string[]): Promise<string> {
    const { stdout } = await execFileAsync(this.tmuxExecutable, args, {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 4 * 1024 * 1024,
      env: process.env,
    });
    return stdout;
  }

  private tmuxWithInput(args: string[], input: string): Promise<void> {
    return runCommandWithInput(this.tmuxExecutable, args, input);
  }

  async initialize() {
    try {
      for (const candidate of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux']) {
        try {
          await access(candidate, constants.X_OK);
          this.tmuxExecutable = candidate;
          break;
        } catch {
          // Fall back to PATH when tmux is not in a standard macOS package-manager location.
        }
      }
      this.tmuxVersion = (await this.tmux(['-V'])).trim();
      this.telemetry.record('info', 'tmux.connected', { session: this.session, version: this.tmuxVersion });
      this.startControlStream();
    } catch (error) {
      this.telemetry.recordFailure('tmux.initialize.failed', error, { session: this.session });
    }
  }

  getVersion() {
    return this.tmuxVersion;
  }

  onTerminalOutput(listener: (event: TerminalOutputEvent) => void) {
    this.outputListeners.add(listener);
    return () => this.outputListeners.delete(listener);
  }

  onTerminalStreamState(listener: (state: TerminalStreamState) => void) {
    this.streamStateListeners.add(listener);
    listener({ connected: this.streamConnected });
    return () => this.streamStateListeners.delete(listener);
  }

  private setStreamConnected(connected: boolean) {
    if (this.streamConnected === connected) return;
    this.streamConnected = connected;
    this.telemetry.recordTerminalStreamState(connected);
    for (const listener of this.streamStateListeners) listener({ connected });
  }

  private startControlStream() {
    if (this.disposed || this.controlProcess) return;
    this.controlBuffer = '';
    const controlProcess = spawn(
      this.tmuxExecutable,
      ['-C', 'attach-session', '-E', '-r', '-f', 'ignore-size', '-t', this.session],
      { env: process.env, stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.controlProcess = controlProcess;
    controlProcess.stderr.resume();
    controlProcess.stdout.setEncoding('utf8');
    controlProcess.stdout.on('data', (chunk: string) => {
      this.controlBuffer += chunk;
      const lines = this.controlBuffer.split('\n');
      this.controlBuffer = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('%session-changed ')) this.setStreamConnected(true);
        if (isControlLayoutChange(line)) {
          const receivedAt = Date.now();
          for (const paneId of this.knownPaneIds) {
            this.telemetry.recordTerminalOutput(0);
            for (const listener of this.outputListeners) listener({ paneId, receivedAt });
          }
          continue;
        }
        const output = parseControlOutput(line);
        if (!output || !this.knownPaneIds.has(output.paneId)) continue;
        const event = { paneId: output.paneId, receivedAt: Date.now() };
        this.telemetry.recordTerminalOutput(Buffer.byteLength(output.data, 'utf8'));
        for (const listener of this.outputListeners) listener(event);
      }
    });
    controlProcess.on('error', () => {
      this.telemetry.recordFailure('tmux.stream.failed', new Error('Unable to start tmux control stream'));
    });
    controlProcess.on('close', () => {
      if (this.controlProcess === controlProcess) this.controlProcess = null;
      this.setStreamConnected(false);
      if (!this.disposed && !this.reconnectTimer) {
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          this.startControlStream();
        }, 1_000);
      }
    });
  }

  dispose() {
    this.disposed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.controlProcess?.kill();
    this.controlProcess = null;
  }

  private assertKnownPane(paneId: unknown): asserts paneId is string {
    if (typeof paneId !== 'string' || !PANE_ID_PATTERN.test(paneId) || !this.knownPaneIds.has(paneId)) {
      throw new Error('Pane is not part of the current llmux snapshot');
    }
  }

  async snapshot(): Promise<AppSnapshot> {
    const startedAt = performance.now();
    try {
      const raw = await this.tmux(['list-panes', '-s', '-t', this.session, '-F', SNAPSHOT_FORMAT]);
      const threads = parseThreads(raw);
      this.knownPaneIds = new Set(threads.map((thread) => thread.paneId));
      const projects = groupProjects(threads);
      const latencyMs = performance.now() - startedAt;
      this.telemetry.recordSnapshot(latencyMs);
      return {
        session: this.session,
        connected: true,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(latencyMs),
        projects,
        threadCount: threads.length,
        attentionCount: projects.reduce((sum, project) => sum + project.attentionCount, 0),
        unreadCount: projects.reduce((sum, project) => sum + project.unreadCount, 0),
      };
    } catch (error) {
      this.knownPaneIds.clear();
      const latencyMs = performance.now() - startedAt;
      this.telemetry.recordSnapshot(latencyMs);
      this.telemetry.recordFailure('tmux.snapshot.failed', error, { session: this.session });
      return {
        session: this.session,
        connected: false,
        observedAt: new Date().toISOString(),
        latencyMs: Math.round(latencyMs),
        projects: [],
        threadCount: 0,
        attentionCount: 0,
        unreadCount: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async terminalFrame(paneId: string): Promise<TerminalFrame> {
    this.assertKnownPane(paneId);
    const startedAt = performance.now();
    try {
      const output = await this.tmux([
        'capture-pane', '-p', '-e', '-t', paneId,
        ';', 'display-message', '-p', '-t', paneId,
        `${FRAME_MARKER}\t#{cursor_x}\t#{cursor_y}\t#{pane_width}\t#{pane_height}`,
      ]);
      const markerIndex = output.lastIndexOf(`\n${FRAME_MARKER}\t`);
      if (markerIndex < 0) throw new Error('tmux frame metadata missing');
      const content = output.slice(0, markerIndex);
      const metadata = output.slice(markerIndex + 1).trim();
      const [, cursorXRaw, cursorYRaw, widthRaw, heightRaw] = metadata.split(FIELD_SEPARATOR);
      const [cursorX, cursorY, width, height] = [cursorXRaw, cursorYRaw, widthRaw, heightRaw].map((value) => parseInteger(value, 0));
      const latencyMs = performance.now() - startedAt;
      this.telemetry.recordTerminal(latencyMs);
      return {
        paneId,
        content,
        cursorX,
        cursorY,
        width,
        height,
        latencyMs: Math.round(latencyMs),
        observedAt: new Date().toISOString(),
      };
    } catch (error) {
      this.telemetry.recordFailure('tmux.terminal.failed', error, { paneId });
      throw error;
    }
  }

  async sendInput(paneId: string, data: string): Promise<void> {
    this.assertKnownPane(paneId);
    if (typeof data !== 'string' || !data || Buffer.byteLength(data, 'utf8') > 16_384) {
      throw new Error('Invalid terminal input');
    }
    const previous = this.inputQueues.get(paneId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      try {
        await this.tmux(['send-keys', '-l', '-t', paneId, '--', data]);
      } catch {
        this.telemetry.recordFailure('tmux.input.failed', new Error('tmux send-keys failed'), { paneId });
        throw new Error('Unable to send terminal input');
      }
    });
    this.inputQueues.set(paneId, next);
    try {
      await next;
    } finally {
      if (this.inputQueues.get(paneId) === next) this.inputQueues.delete(paneId);
    }
  }

  async sendKey(paneId: string, key: string): Promise<void> {
    this.assertKnownPane(paneId);
    if (typeof key !== 'string' || !TERMINAL_KEYS.has(key)) throw new Error('Invalid terminal key');
    const previous = this.inputQueues.get(paneId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      try {
        await this.tmux(['send-keys', '-t', paneId, key]);
      } catch {
        this.telemetry.recordFailure('tmux.key.failed', new Error('tmux send-keys failed'), { paneId, key });
        throw new Error('Unable to send terminal key');
      }
    });
    this.inputQueues.set(paneId, next);
    try {
      await next;
    } finally {
      if (this.inputQueues.get(paneId) === next) this.inputQueues.delete(paneId);
    }
  }


  async sendPaste(paneId: string, data: string): Promise<void> {
    this.assertKnownPane(paneId);
    if (typeof data !== 'string' || !data || Buffer.byteLength(data, 'utf8') > 1024 * 1024) {
      throw new Error('Invalid terminal paste');
    }
    const terminalData = data.replace(/\r?\n/g, '\r');
    const bufferName = `llmux-desktop-${process.pid}-${++this.pasteSequence}`;
    const previous = this.inputQueues.get(paneId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      try {
        await this.tmuxWithInput(['load-buffer', '-b', bufferName, '-'], terminalData);
        await this.tmux(['paste-buffer', '-p', '-r', '-d', '-b', bufferName, '-t', paneId]);
      } catch {
        await this.tmux(['delete-buffer', '-b', bufferName]).catch(() => undefined);
        this.telemetry.recordFailure('tmux.paste.failed', new Error('tmux paste-buffer failed'), { paneId });
        throw new Error('Unable to paste terminal input');
      }
    });
    this.inputQueues.set(paneId, next);
    try {
      await next;
    } finally {
      if (this.inputQueues.get(paneId) === next) this.inputQueues.delete(paneId);
    }
  }
}
