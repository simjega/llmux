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
  tmux('send-keys', '-t', paneId as string, 'C-u');
  await page.locator('.terminal-host').click();
  await page.keyboard.type("printf 'DESKTOP_INPUT_OK\\n'");
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(async (targetPaneId) => {
    const content = (await window.llmux.getTerminalFrame(targetPaneId as string)).content;
    return content.match(/DESKTOP_INPUT_OK/g)?.length ?? 0;
  }, paneId)).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(25);
  await page.screenshot({ path: path.join(ARTIFACTS, 'llmux-desktop-overview.png') });
});

test('keeps terminal focus from scrolling the workspace out of view', async () => {
  await page.getByTestId('thread-port-to-desktop-app').click();
  await page.locator('.terminal-host').click();
  await expect.poll(() => page.evaluate(() => document.getElementById('root')?.scrollTop)).toBe(0);
  const geometry = await page.evaluate(() => ({
    headerTop: document.querySelector('.workspace-header')?.getBoundingClientRect().top,
    shellBottom: document.querySelector('.terminal-shell')?.getBoundingClientRect().bottom,
    viewportHeight: window.innerHeight,
  }));
  expect(geometry.headerTop).toBeGreaterThanOrEqual(0);
  expect(geometry.shellBottom).toBeLessThanOrEqual(geometry.viewportHeight);
});

test('preserves ordered control and text input under repeated typing', async () => {
  await page.getByTestId('thread-port-to-desktop-app').click();
  const paneId = await page.evaluate(async () => {
    const snapshot = await window.llmux.getSnapshot();
    return snapshot.projects.flatMap((project) => project.threads).find((thread) => thread.name === 'port-to-desktop-app')?.paneId;
  });
  await page.locator('.terminal-host').click();
  for (let index = 0; index < 20; index += 1) {
    const marker = `INPUT_ORDER_${index}_${Date.now()}`;
    await page.keyboard.type(`discard-${index}`);
    await page.keyboard.press('Control+u');
    await page.keyboard.type(`printf '${marker}\\n'`);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(async (targetPaneId) => {
      return (await window.llmux.getTerminalFrame(targetPaneId as string)).content;
    }, paneId), { timeout: 2_000, intervals: [10] }).toContain(marker);
  }
});

test('scales a compact tmux grid to use the desktop workspace', async () => {
  await page.getByTestId('thread-port-to-desktop-app').click();
  const paneId = await page.evaluate(async () => {
    const snapshot = await window.llmux.getSnapshot();
    return snapshot.projects.flatMap((project) => project.threads).find((thread) => thread.name === 'port-to-desktop-app')?.paneId;
  });
  tmux('send-keys', '-t', paneId as string, 'C-u');
  tmux('send-keys', '-l', '-t', paneId as string, '--', "clear; printf 'LLMUX DESKTOP — COMPACT PANE\\n\\n67×15 tmux grid · adaptive exact-grid rendering\\nFull-width workspace · native terminal input\\n'");
  tmux('send-keys', '-t', paneId as string, 'Enter');
  tmux('resize-window', '-t', paneId as string, '-x', '67', '-y', '15');
  await expect.poll(() => page.locator('.terminal-host').getAttribute('data-cols'), { intervals: [10] }).toBe('67');
  await expect.poll(() => page.locator('.xterm-rows').textContent(), { intervals: [10] }).toContain('COMPACT PANE');
  const coverage = await page.evaluate(() => {
    const host = document.querySelector('.terminal-host')?.getBoundingClientRect();
    const screen = document.querySelector('.xterm-screen')?.getBoundingClientRect();
    return { width: (screen?.width ?? 0) / (host?.width ?? 1), height: (screen?.height ?? 0) / (host?.height ?? 1) };
  });
  expect(coverage.width).toBeGreaterThan(0.75);
  expect(coverage.height).toBeGreaterThan(0.45);
  expect(tmux('display-message', '-p', '-t', paneId as string, '#{pane_width}x#{pane_height}')).toBe('67x15');
  await page.screenshot({ path: path.join(ARTIFACTS, 'llmux-desktop-compact-pane.png') });
  tmux('resize-window', '-t', paneId as string, '-x', '142', '-y', '40');
});

test('pastes multiline text through tmux bracketed paste', async () => {
  await page.getByTestId('thread-port-to-desktop-app').click();
  const paneId = await page.evaluate(async () => {
    const snapshot = await window.llmux.getSnapshot();
    return snapshot.projects.flatMap((project) => project.threads).find((thread) => thread.name === 'port-to-desktop-app')?.paneId;
  });
  const pasted = 'first line\nsecond line';
  const expected = Buffer.from(`\u001b[200~${pasted.replace(/\r?\n/g, '\r')}\u001b[201~`).toString('hex');
  const byteLength = Buffer.byteLength(pasted) + 12;
  const probe = `python3 -c 'import sys,termios,tty; fd=sys.stdin.fileno(); old=termios.tcgetattr(fd); tty.setraw(fd); print("\\033[?2004hPASTE_"+"READY",end="",flush=True); data=sys.stdin.buffer.read(${byteLength}); termios.tcsetattr(fd,termios.TCSADRAIN,old); print("\\033[?2004lPASTE_"+"HEX="+data.hex())'`;
  tmux('send-keys', '-t', paneId as string, 'C-u');
  tmux('send-keys', '-l', '-t', paneId as string, '--', probe);
  tmux('send-keys', '-t', paneId as string, 'Enter');
  await expect.poll(() => page.evaluate(async (targetPaneId) => {
    return (await window.llmux.getTerminalFrame(targetPaneId as string)).content;
  }, paneId), { timeout: 2_000, intervals: [10] }).toContain('PASTE_READY');
  await page.locator('.terminal-host').evaluate((element, text) => {
    const clipboardData = new DataTransfer();
    clipboardData.setData('text/plain', text);
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }));
  }, pasted);
  await expect.poll(() => page.evaluate(async (targetPaneId) => {
    return (await window.llmux.getTerminalFrame(targetPaneId as string)).content;
  }, paneId), { timeout: 2_000, intervals: [10] }).toContain(`PASTE_HEX=${expected}`);
});

test('supports workspace keyboard shortcuts', async () => {
  await page.bringToFront();
  await page.getByTestId('thread-port-to-desktop-app').click();
  await page.getByTestId('project-toggle-llmux').click();
  await expect(page.getByTestId('thread-skill-updates')).toBeHidden();
  await page.keyboard.press('Meta+k');
  await expect(page.getByLabel('Find a thread')).toBeFocused();
  await page.getByLabel('Find a thread').fill('skill');
  await expect(page.getByTestId('thread-skill-updates')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByLabel('Find a thread')).toHaveValue('');
  await expect(page.getByTestId('thread-skill-updates')).toBeHidden();
  await page.getByTestId('project-toggle-llmux').click();
  await page.keyboard.press('Meta+d');
  await expect(page.getByTestId('diagnostics-view')).toBeVisible();
  await page.keyboard.press('Meta+d');
  await expect(page.getByTestId('terminal-view')).toBeVisible();
});

test('collapses projects and keeps a dense sidebar scoped to its own scroll area', async () => {
  await page.getByTestId('project-toggle-llmux').click();
  await expect(page.getByTestId('thread-port-to-desktop-app')).toBeHidden();
  await page.getByTestId('project-toggle-llmux').click();
  await expect(page.getByTestId('thread-port-to-desktop-app')).toBeVisible();

  const extraPanes = Array.from({ length: 14 }, (_, index) => addPane(`overflow-${index}`, {
    name: `qa-overflow-${index}`,
    tool: index % 2 === 0 ? 'codex' : 'claude',
    project: 'qa-overflow',
    status: 'working',
    order: String(index),
  }));
  const lastThread = page.getByTestId('thread-qa-overflow-13');
  await expect(lastThread).toBeAttached({ timeout: 3_000 });
  await page.locator('.project-list').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect(lastThread).toBeInViewport();
  await lastThread.click();
  await expect(page.locator('.workspace-header h1')).toHaveText('qa-overflow-13');
  expect(await page.evaluate(() => document.getElementById('root')?.scrollTop)).toBe(0);
  const sidebar = await page.locator('.project-list').evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
    rootTop: document.getElementById('root')?.getBoundingClientRect().top,
  }));
  expect(sidebar.scrollHeight).toBeGreaterThan(sidebar.clientHeight);
  expect(sidebar.rootTop).toBe(0);
  for (const paneId of extraPanes) tmux('kill-pane', '-t', paneId);
  await expect(page.getByTestId('thread-qa-overflow-13')).toHaveCount(0, { timeout: 3_000 });
  await page.locator('.project-list').evaluate((element) => { element.scrollTop = 0; });
  await expect(page.getByTestId('thread-port-to-desktop-app')).toBeInViewport();
  await page.getByTestId('thread-port-to-desktop-app').click();
});

test('remains usable at the minimum supported window size', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(980, 680));
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([980, 680]);
  await expect(page.getByLabel('Find a thread')).toBeVisible();
  await expect(page.getByText('Diagnostics', { exact: true })).toBeVisible();
  await expect(page.getByTestId('terminal-view')).toBeVisible();
  const geometry = await page.evaluate(() => {
    const root = document.getElementById('root');
    const host = document.querySelector<HTMLElement>('.terminal-host');
    const screen = document.querySelector<HTMLElement>('.xterm-screen');
    return {
      root: root?.getBoundingClientRect().toJSON(),
      host: host?.getBoundingClientRect().toJSON(),
      screenWidth: screen?.getBoundingClientRect().width,
      scrollWidth: host?.scrollWidth,
      overflow: host ? getComputedStyle(host).overflow : '',
    };
  });
  expect(geometry.root?.top).toBe(0);
  expect(geometry.root?.bottom).toBe(680);
  expect(geometry.host?.bottom).toBeLessThanOrEqual(680);
  expect(geometry.overflow).toBe('auto');
  expect(geometry.scrollWidth ?? 0).toBeGreaterThanOrEqual(geometry.screenWidth ?? 0);
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 920));
  await expect.poll(() => page.evaluate(() => [window.innerWidth, window.innerHeight])).toEqual([1440, 920]);
});

test('delegates mode-sensitive keys to the real tmux pane', async () => {
  await page.getByTestId('thread-port-to-desktop-app').click();
  const paneId = await page.evaluate(async () => {
    const snapshot = await window.llmux.getSnapshot();
    return snapshot.projects.flatMap((project) => project.threads).find((thread) => thread.name === 'port-to-desktop-app')?.paneId;
  });
  const probe = `python3 -c 'import sys,termios,tty; fd=sys.stdin.fileno(); old=termios.tcgetattr(fd); tty.setraw(fd); print("\\033[?1hKEY_"+"READY",end="",flush=True); data=sys.stdin.buffer.read(3); termios.tcsetattr(fd,termios.TCSADRAIN,old); print("\\033[?1lKEY_"+"HEX="+data.hex())'`;
  tmux('send-keys', '-t', paneId as string, 'C-u');
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

test('survives an early tmux exit while streaming a large paste', async () => {
  const pasteFailureBaseline = await page.evaluate(async () => (await window.llmux.getDiagnostics()).recentEvents
    .filter((event) => event.event === 'tmux.paste.failed').length);
  const paneId = await page.evaluate(async () => {
    const snapshot = await window.llmux.getSnapshot();
    return snapshot.projects.flatMap((project) => project.threads).find((thread) => thread.name === 'port-to-desktop-app')?.paneId;
  });
  tmux('kill-session', '-t', SESSION);
  await expect(page.evaluate(async ({ targetPaneId, data }) => {
    try {
      await window.llmux.sendTerminalPaste(targetPaneId as string, data);
      return 'resolved';
    } catch {
      return 'rejected';
    }
  }, { targetPaneId: paneId, data: 'x'.repeat(512 * 1024) })).resolves.toBe('rejected');
  await expect.poll(() => page.evaluate(async () => (await window.llmux.getDiagnostics()).recentEvents
    .filter((event) => event.event === 'tmux.paste.failed').length)).toBeGreaterThan(pasteFailureBaseline);
  expect(await app.windows()).toHaveLength(1);
});
