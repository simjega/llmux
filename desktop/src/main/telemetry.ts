import { app } from 'electron';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import type { DiagnosticsSnapshot, TelemetryEvent } from '../shared/types';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const MAX_RECENT_EVENTS = 60;

const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]);
};

export class Telemetry {
  readonly startedAt = Date.now();
  readonly logPath: string;
  private recentEvents: TelemetryEvent[] = [];
  private snapshotDurations: number[] = [];
  private terminalDurations: number[] = [];
  private snapshotPolls = 0;
  private terminalPolls = 0;
  private terminalStreamEvents = 0;
  private terminalStreamBytes = 0;
  private terminalStreamConnected = false;
  private commandFailures = 0;
  private lastError: string | null = null;

  constructor() {
    const logDirectory = app.getPath('logs');
    mkdirSync(logDirectory, { recursive: true });
    this.logPath = path.join(logDirectory, 'llmux-desktop.jsonl');
    if (existsSync(this.logPath) && statSync(this.logPath).size > MAX_LOG_BYTES) {
      renameSync(this.logPath, `${this.logPath}.1`);
    }
  }

  record(level: TelemetryEvent['level'], event: string, details?: Record<string, unknown>, durationMs?: number) {
    const entry: TelemetryEvent = {
      at: new Date().toISOString(),
      level,
      event,
      ...(durationMs === undefined ? {} : { durationMs: Math.round(durationMs) }),
      ...(details ? { details } : {}),
    };
    this.recentEvents = [...this.recentEvents.slice(-(MAX_RECENT_EVENTS - 1)), entry];
    try {
      appendFileSync(this.logPath, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o600 });
    } catch (error) {
      console.error('Unable to write telemetry', error);
    }
  }

  recordSnapshot(durationMs: number) {
    this.snapshotPolls += 1;
    this.snapshotDurations = [...this.snapshotDurations.slice(-199), durationMs];
  }

  recordTerminal(durationMs: number) {
    this.terminalPolls += 1;
    this.terminalDurations = [...this.terminalDurations.slice(-199), durationMs];
  }

  recordTerminalOutput(bytes: number) {
    this.terminalStreamEvents += 1;
    this.terminalStreamBytes += bytes;
  }

  recordTerminalStreamState(connected: boolean) {
    this.terminalStreamConnected = connected;
    this.record(connected ? 'info' : 'warn', connected ? 'tmux.stream.connected' : 'tmux.stream.disconnected');
  }

  recordFailure(event: string, error: unknown, details?: Record<string, unknown>) {
    this.commandFailures += 1;
    this.lastError = error instanceof Error ? error.message : String(error);
    this.record('error', event, { ...details, message: this.lastError });
  }

  diagnostics(tmuxVersion: string): DiagnosticsSnapshot {
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron,
      tmuxVersion,
      logPath: this.logPath,
      uptimeMs: Date.now() - this.startedAt,
      snapshotPolls: this.snapshotPolls,
      terminalPolls: this.terminalPolls,
      terminalStreamEvents: this.terminalStreamEvents,
      terminalStreamBytes: this.terminalStreamBytes,
      terminalStreamConnected: this.terminalStreamConnected,
      commandFailures: this.commandFailures,
      snapshotP50Ms: percentile(this.snapshotDurations, 0.5),
      snapshotP95Ms: percentile(this.snapshotDurations, 0.95),
      terminalP50Ms: percentile(this.terminalDurations, 0.5),
      terminalP95Ms: percentile(this.terminalDurations, 0.95),
      lastError: this.lastError,
      recentEvents: [...this.recentEvents].reverse(),
    };
  }
}
