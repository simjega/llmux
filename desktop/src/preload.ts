import { contextBridge, ipcRenderer } from 'electron';
import type { LlmuxDesktopApi, TerminalOutputEvent, TerminalStreamState } from './shared/types';

const api: LlmuxDesktopApi = {
  getSnapshot: () => ipcRenderer.invoke('llmux:snapshot'),
  getTerminalFrame: (paneId) => ipcRenderer.invoke('llmux:terminal-frame', paneId),
  sendTerminalInput: (paneId, data) => ipcRenderer.invoke('llmux:terminal-input', paneId, data),
  sendTerminalKey: (paneId, key) => ipcRenderer.invoke('llmux:terminal-key', paneId, key),
  sendTerminalPaste: (paneId, data) => ipcRenderer.invoke('llmux:terminal-paste', paneId, data),
  onTerminalOutput: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, output: TerminalOutputEvent) => listener(output);
    ipcRenderer.on('llmux:terminal-output', handler);
    return () => ipcRenderer.removeListener('llmux:terminal-output', handler);
  },
  onTerminalStreamState: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, state: TerminalStreamState) => listener(state);
    ipcRenderer.on('llmux:terminal-stream-state', handler);
    return () => ipcRenderer.removeListener('llmux:terminal-stream-state', handler);
  },
  getDiagnostics: () => ipcRenderer.invoke('llmux:diagnostics'),
  revealLogs: () => ipcRenderer.invoke('llmux:reveal-logs'),
  reportRendererEvent: (event, details) => ipcRenderer.send('llmux:renderer-event', event, details),
};

contextBridge.exposeInMainWorld('llmux', api);
