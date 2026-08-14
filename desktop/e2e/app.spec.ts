import { expect, test, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const SESSION = 'llmux-desktop-e2e';
const ARTIFACTS = path.resolve('artifacts');

const tmux = (...args: string[]) => execFileSync('tmux', args, { encoding: 'utf8' }).trim();

const setPane = (paneId: string, values: Record<string, string>) => {
  for (const [key, value] of Object.entries(values)) tmux('set-option', '-p', '-t', paneId, `@llmux_${key}`, value);
};

const addPane = (windowName: string, values: Record<string, string>) => {
  const paneId = tmux('new-window', '-d', '-P', '-F', '#{pane_id}', '-t', SESSION, '-n', windowName);
  setPane(paneId, values);
  return paneId;
};

const paintPane = (paneId: string, title: string, detail: string) => {
  const command = `clear; printf '\\n  LLMUX DESKTOP PREVIEW\\n\\n  ${title}\\n  ${detail}\\n\\n';`;
  tmux('send-keys', '-l', '-t', paneId, command);
  tmux('send-keys', '-t', paneId, 'Enter');
};

const createFixture = () => {
  try { tmux('kill-session', '-t', SESSION); } catch { /* no prior fixture */ }
  tmux('new-session', '-d', '-s', SESSION, '-x', '142', '-y', '40', '-n', 'desktop', "env PS1='preview % ' zsh -f");
  const firstPane = tmux('display-message', '-p', '-t', `${SESSION}:0.0`, '#{pane_id}');
  setPane(firstPane, { name: 'port-to-desktop-app', tool: 'codex', project: 'llmux', status: 'busy', status_src: 'watch', worktree: 'feature/desktop-app', order: '10' });
  const contextPane = addPane('context', { name: 'llmux-context-builder', tool: 'claude', project: 'llmux', status: 'idle', status_src: 'watch', done_at: String(Math.floor(Date.now() / 1000) - 180), order: '20' });
  const blockedPane = addPane('attention', { name: 'skill-updates', tool: 'claude', project: 'llmux', status: 'blocked', status_src: 'ask', order: '30' });
  const ownerPane = addPane('owner', { name: 'campaign-parity', tool: 'opencode', project: 'custom-campaigns-me2', status: 'perm', status_src: 'watch', slot: 'slot-6', order: '10' });

  // Wait for each login shell to finish initializing before sending fixture commands.
  execFileSync('sleep', ['1']);
  paintPane(firstPane, 'port-to-desktop-app', 'Electron bridge connected · screenshot verification active');
  paintPane(contextPane, 'llmux-context-builder', 'Ready · project memory refreshed');
  paintPane(blockedPane, 'skill-updates', 'Needs input · waiting for a review decision');
  paintPane(ownerPane, 'campaign-parity', 'Permission required · command held safely');
  execFileSync('sleep', ['1']);
};

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  createFixture();
  mkdirSync(ARTIFACTS, { recursive: true });
  const executable = path.resolve('out/llmux Desktop-darwin-arm64/llmux Desktop.app/Contents/MacOS/llmux Desktop');
  if (!existsSync(executable)) throw new Error(`Packaged app missing: ${executable}`);
  app = await electron.launch({
    executablePath: executable,
    env: { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LLMUX_DESKTOP_SESSION: SESSION },
  });
  page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
});

test.afterAll(async () => {
  await app?.close();
  try { tmux('kill-session', '-t', SESSION); } catch { /* fixture already gone */ }
});

test('renders project threads and a live terminal', async () => {
  await expect(page.getByTestId('project-llmux')).toBeVisible();
  await expect(page.getByTestId('thread-port-to-desktop-app')).toBeVisible();
  await expect(page.getByTestId('terminal-view')).toBeVisible();
  const controlClient = tmux('list-clients', '-F', '#{client_control_mode}\t#{client_flags}\t#{session_name}')
    .split('\n')
    .map((line) => line.split('\t'))
    .find(([controlMode, , sessionName]) => controlMode === '1' && sessionName === SESSION);
  expect(controlClient?.[1]).toContain('ignore-size');
  expect(controlClient?.[1]).toContain('read-only');
  expect(tmux('display-message', '-p', '-t', `${SESSION}:0.0`, '#{pane_width}x#{pane_height}')).toBe('142x40');
  const paneId = await page.evaluate(async () => {
    const snapshot = await window.llmux.getSnapshot();
    return snapshot.projects.flatMap((project) => project.threads).find((thread) => thread.name === 'port-to-desktop-app')?.paneId;
  });
  expect(paneId).toBeTruthy();
  await page.evaluate(async (targetPaneId) => {
    await window.llmux.sendTerminalInput(targetPaneId as string, '-X -t -- -N');
  }, paneId);
  await expect.poll(() => page.evaluate(async (targetPaneId) => {
    return (await window.llmux.getTerminalFrame(targetPaneId as string)).content;
  }, paneId)).toContain('preview -X -t -- -N');
  await page.evaluate(async (targetPaneId) => {
    await window.llmux.sendTerminalInput(targetPaneId as string, '\u0015');
  }, paneId);
  await page.locator('.terminal-host').click();
  await page.keyboard.type("printf 'DESKTOP_INPUT_OK\\n'");
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(async (targetPaneId) => {
    const content = (await window.llmux.getTerminalFrame(targetPaneId as string)).content;
    return content.match(/DESKTOP_INPUT_OK/g)?.length ?? 0;
  }, paneId)).toBeGreaterThanOrEqual(2);
  paintPane(paneId as string, 'port-to-desktop-app', 'Electron bridge connected · terminal input verified');
  await expect.poll(() => page.evaluate(async (targetPaneId) => {
    return (await window.llmux.getTerminalFrame(targetPaneId as string)).content;
  }, paneId)).toContain('terminal input verified');
  await page.screenshot({ path: path.join(ARTIFACTS, 'llmux-desktop-overview.png') });
});

test('blocks clipboard paste that cannot preserve the pane terminal mode', async () => {
  await page.getByTestId('thread-port-to-desktop-app').click();
  await page.locator('.terminal-host').dispatchEvent('paste');
  await expect(page.getByText('Paste is disabled in this preview', { exact: false })).toBeVisible();
});

test('delegates mode-sensitive keys to the real tmux pane', async () => {
  await page.getByTestId('thread-port-to-desktop-app').click();
  const paneId = await page.evaluate(async () => {
    const snapshot = await window.llmux.getSnapshot();
    return snapshot.projects.flatMap((project) => project.threads).find((thread) => thread.name === 'port-to-desktop-app')?.paneId;
  });
  const probe = `python3 -c 'import sys,termios,tty; fd=sys.stdin.fileno(); old=termios.tcgetattr(fd); tty.setraw(fd); print("\\033[?1hKEY_"+"READY",end="",flush=True); data=sys.stdin.buffer.read(3); termios.tcsetattr(fd,termios.TCSADRAIN,old); print("\\033[?1lKEY_"+"HEX="+data.hex())'`;
  tmux('send-keys', '-l', '-t', paneId as string, '--', probe);
  tmux('send-keys', '-t', paneId as string, 'Enter');
  await expect.poll(() => tmux('display-message', '-p', '-t', paneId as string, '#{pane_current_command}')).toMatch(/python/i);
  await expect.poll(() => page.evaluate(async (targetPaneId) => {
    return (await window.llmux.getTerminalFrame(targetPaneId as string)).content;
  }, paneId), { timeout: 2_000, intervals: [10] }).toContain('KEY_READY');
  await page.locator('.terminal-host').click();
  await page.keyboard.press('ArrowUp');
  await expect.poll(() => page.evaluate(async (targetPaneId) => {
    return (await window.llmux.getTerminalFrame(targetPaneId as string)).content;
  }, paneId), { timeout: 2_000, intervals: [10] }).toContain('KEY_HEX=1b4f41');
});

test('redraws an idle pane after an external layout change', async () => {
  await page.getByTestId('thread-port-to-desktop-app').click();
  const paneId = await page.evaluate(async () => {
    const snapshot = await window.llmux.getSnapshot();
    return snapshot.projects.flatMap((project) => project.threads).find((thread) => thread.name === 'port-to-desktop-app')?.paneId;
  });
  tmux('resize-window', '-t', paneId as string, '-x', '120', '-y', '33');
  await expect.poll(() => page.locator('.terminal-host').getAttribute('data-cols'), { intervals: [10] }).toBe('120');
  await expect.poll(() => page.locator('.terminal-host').getAttribute('data-rows'), { intervals: [10] }).toBe('33');
  tmux('resize-window', '-t', paneId as string, '-x', '142', '-y', '40');
  await expect.poll(() => page.locator('.terminal-host').getAttribute('data-cols'), { intervals: [10] }).toBe('142');
  await expect.poll(() => page.locator('.terminal-host').getAttribute('data-rows'), { intervals: [10] }).toBe('40');
});

test('renders pane output without a polling delay', async () => {
  await page.getByTestId('thread-port-to-desktop-app').click();
  const paneId = await page.evaluate(async () => {
    const snapshot = await window.llmux.getSnapshot();
    return snapshot.projects.flatMap((project) => project.threads).find((thread) => thread.name === 'port-to-desktop-app')?.paneId;
  });
  expect(paneId).toBeTruthy();
  const latencies: number[] = [];
  for (let index = 0; index < 8; index += 1) {
    const marker = `STREAM_LATENCY_${index}_${Date.now()}`;
    const startedAt = performance.now();
    tmux('send-keys', '-l', '-t', paneId as string, '--', `printf '${marker}\\n'`);
    tmux('send-keys', '-t', paneId as string, 'Enter');
    await expect.poll(() => page.locator('.xterm-rows').textContent(), { timeout: 2_000, intervals: [10] }).toContain(marker);
    latencies.push(performance.now() - startedAt);
  }
  latencies.sort((left, right) => left - right);
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  test.info().annotations.push({ type: 'terminal-output-p95', description: `${Math.round(p95)} ms` });
  expect(p95).toBeLessThan(100);
});

test('reconnects and resynchronizes after the tmux control client exits', async () => {
  await page.getByTestId('thread-port-to-desktop-app').click();
  const controlClient = tmux('list-clients', '-F', '#{client_pid}\t#{client_control_mode}\t#{session_name}')
    .split('\n')
    .map((line) => line.split('\t'))
    .find(([, controlMode, sessionName]) => controlMode === '1' && sessionName === SESSION);
  expect(controlClient).toBeTruthy();
  process.kill(Number(controlClient?.[0]), 'SIGTERM');
  await expect.poll(() => page.evaluate(async () => (await window.llmux.getDiagnostics()).terminalStreamConnected)).toBe(false);
  await expect.poll(() => page.evaluate(async () => (await window.llmux.getDiagnostics()).terminalStreamConnected), { timeout: 3_000 }).toBe(true);

  const paneId = await page.evaluate(async () => {
    const snapshot = await window.llmux.getSnapshot();
    return snapshot.projects.flatMap((project) => project.threads).find((thread) => thread.name === 'port-to-desktop-app')?.paneId;
  });
  const marker = `STREAM_RECONNECTED_${Date.now()}`;
  tmux('send-keys', '-l', '-t', paneId as string, '--', `printf '${marker}\\n'`);
  tmux('send-keys', '-t', paneId as string, 'Enter');
  await expect.poll(() => page.locator('.xterm-rows').textContent(), { timeout: 2_000, intervals: [10] }).toContain(marker);
});

test('separates attention activity from project navigation', async () => {
  await page.getByTestId('activity-button').click();
  const activityView = page.getByTestId('activity-view');
  await expect(activityView).toBeVisible();
  await expect(activityView.getByText('skill-updates')).toBeVisible();
  await expect(activityView.getByText('Permission')).toBeVisible();
  await page.screenshot({ path: path.join(ARTIFACTS, 'llmux-desktop-activity.png') });
});

test('exposes runtime diagnostics and structured telemetry', async () => {
  await page.getByText('Diagnostics', { exact: true }).click();
  await expect(page.getByTestId('diagnostics-view')).toBeVisible();
  await expect(page.getByText('Healthy')).toBeVisible();
  await expect(page.getByText('tmux', { exact: false }).first()).toBeVisible();
  await page.screenshot({ path: path.join(ARTIFACTS, 'llmux-desktop-diagnostics.png') });
});
