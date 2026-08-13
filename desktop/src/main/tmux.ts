import { execFile } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { promisify } from 'node:util';
import type { AppSnapshot, ProjectSnapshot, TerminalFrame, ThreadSnapshot, ThreadStatus } from '../shared/types';
import type { Telemetry } from './telemetry';

const execFileAsync = promisify(execFile);
const FIELD_SEPARATOR = '\t';
const PANE_ID_PATTERN = /^%\d+$/;
const SNAPSHOT_FORMAT = [
  '#{pane_id}', '#{@llmux_name}', '#{@llmux_tool}', '#{@llmux_project}',
  '#{pane_current_path}', '#{@llmux_status}', '#{@llmux_status_src}',
  '#{@llmux_worktree}', '#{@llmux_slot}', '#{@llmux_pinned}',
  '#{@llmux_terminal}', '#{@llmux_done_at}', '#{@llmux_order}',
  '#{pane_active}', '#{window_active}', '#{@llmux_sidebar}', '#{@llmux_parked_anchor}',
].join(FIELD_SEPARATOR);

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
  private knownPaneIds = new Set<string>();

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
    } catch (error) {
      this.telemetry.recordFailure('tmux.initialize.failed', error, { session: this.session });
    }
  }

  getVersion() {
    return this.tmuxVersion;
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
      const [content, metadata] = await Promise.all([
        this.tmux(['capture-pane', '-p', '-e', '-t', paneId]),
        this.tmux(['display-message', '-p', '-t', paneId, '#{cursor_x}\t#{cursor_y}\t#{pane_width}\t#{pane_height}']),
      ]);
      const [cursorX, cursorY, width, height] = metadata.trim().split(FIELD_SEPARATOR).map((value) => parseInteger(value, 0));
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
}
