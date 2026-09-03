import { app, BrowserWindow, crashReporter, ipcMain, session, shell } from 'electron';
import type { IpcMainEvent, IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { Telemetry } from './main/telemetry';
import { TmuxClient } from './main/tmux';

crashReporter.start({ uploadToServer: false });

let telemetry: Telemetry;
let tmux: TmuxClient;
let mainWindow: BrowserWindow | null = null;

const assertTrustedSender = (event: IpcMainEvent | IpcMainInvokeEvent) => {
  if (!mainWindow || event.sender !== mainWindow.webContents || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('Untrusted IPC sender');
  }
};

const createWindow = () => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: 'llmux Desktop',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#11120f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event) => event.preventDefault());
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    telemetry.record('error', 'renderer.gone', { reason: details.reason, exitCode: details.exitCode });
  });
  mainWindow.on('closed', () => { mainWindow = null; });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    void mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    void mainWindow.loadFile(path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }

  if (process.env.LLMUX_DESKTOP_DEVTOOLS === '1') mainWindow.webContents.openDevTools({ mode: 'detach' });
};

app.whenReady().then(async () => {
  app.setAppLogsPath();
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  telemetry = new Telemetry();
  tmux = new TmuxClient(telemetry);
  await tmux.initialize();
  tmux.onTerminalOutput((output) => mainWindow?.webContents.send('llmux:terminal-output', output));
  tmux.onTerminalStreamState((state) => mainWindow?.webContents.send('llmux:terminal-stream-state', state));

  ipcMain.handle('llmux:snapshot', (event) => { assertTrustedSender(event); return tmux.snapshot(); });
  ipcMain.handle('llmux:terminal-frame', (event, paneId: string) => { assertTrustedSender(event); return tmux.terminalFrame(paneId); });
  ipcMain.handle('llmux:terminal-input', (event, paneId: string, data: string) => { assertTrustedSender(event); return tmux.sendInput(paneId, data); });
  ipcMain.handle('llmux:terminal-key', (event, paneId: string, key: string) => { assertTrustedSender(event); return tmux.sendKey(paneId, key); });
  ipcMain.handle('llmux:terminal-paste', (event, paneId: string, data: string) => { assertTrustedSender(event); return tmux.sendPaste(paneId, data); });
  ipcMain.handle('llmux:diagnostics', (event) => { assertTrustedSender(event); return telemetry.diagnostics(tmux.getVersion()); });
  ipcMain.handle('llmux:reveal-logs', (event) => { assertTrustedSender(event); return shell.showItemInFolder(telemetry.logPath); });
  ipcMain.on('llmux:renderer-event', (ipcEvent, event: string, details?: Record<string, unknown>) => {
    try { assertTrustedSender(ipcEvent); } catch { return; }
    if (typeof event !== 'string' || event.length > 120 || !/^[a-z0-9.-]+$/i.test(event)) return;
    try {
      if (details && JSON.stringify(details).length > 4_096) return;
      telemetry.record('info', `renderer.${event}`, details);
    } catch {
      // Ignore non-serializable renderer diagnostics rather than trusting them in the main process.
    }
  });

  process.on('uncaughtException', (error) => telemetry.recordFailure('main.uncaught-exception', error));
  process.on('unhandledRejection', (error) => telemetry.recordFailure('main.unhandled-rejection', error));
  telemetry.record('info', 'app.ready', { session: tmux.session });
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => tmux?.dispose());

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
