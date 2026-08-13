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
  const paneId = await page.evaluate(async () => {
    const snapshot = await window.llmux.getSnapshot();
    return snapshot.projects.flatMap((project) => project.threads).find((thread) => thread.name === 'port-to-desktop-app')?.paneId;
  });
  expect(paneId).toBeTruthy();
  await page.locator('.terminal-host').dispatchEvent('paste');
  await expect(page.getByText('Paste is disabled in this preview', { exact: false })).toBeVisible();
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
