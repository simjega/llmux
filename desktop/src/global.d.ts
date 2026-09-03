import type { LlmuxDesktopApi } from './shared/types';

declare global {
  interface Window {
    llmux: LlmuxDesktopApi;
  }
}

export {};
