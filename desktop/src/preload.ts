import { contextBridge, ipcRenderer } from 'electron';
import type { LlmuxDesktopApi } from './shared/types';

const api: LlmuxDesktopApi = {
  getSnapshot: () => ipcRenderer.invoke('llmux:snapshot'),
  getTerminalFrame: (paneId) => ipcRenderer.invoke('llmux:terminal-frame', paneId),
  sendTerminalInput: (paneId, data) => ipcRenderer.invoke('llmux:terminal-input', paneId, data),
  getDiagnostics: () => ipcRenderer.invoke('llmux:diagnostics'),
  revealLogs: () => ipcRenderer.invoke('llmux:reveal-logs'),
  reportRendererEvent: (event, details) => ipcRenderer.send('llmux:renderer-event', event, details),
};

contextBridge.exposeInMainWorld('llmux', api);
