import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { ThreadSnapshot } from './shared/types';

const BASE_FONT_SIZE = 13;
const MIN_FONT_SIZE = 10;
const MAX_FONT_SIZE = 26;

interface TerminalViewProps {
  thread: ThreadSnapshot;
}

const terminalKey = (event: KeyboardEvent): string | null => {
  if (event.key === 'Tab' && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey) return 'BTab';
  if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return null;
  if (event.key === 'Tab') return 'Tab';
  const keys: Record<string, string> = {
    ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown',
    Insert: 'IC', Delete: 'DC', Enter: 'Enter', Backspace: 'BSpace', Escape: 'Escape',
    F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6',
    F7: 'F7', F8: 'F8', F9: 'F9', F10: 'F10', F11: 'F11', F12: 'F12',
  };
  return keys[event.key] ?? null;
};

export function TerminalView({ thread }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [lastLatency, setLastLatency] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const focusTerminal = () => terminalRef.current?.textarea?.focus({ preventScroll: true });

  useEffect(() => {
    if (!hostRef.current) return undefined;
    let disposed = false;
    let frameDirty = false;
    let frameInFlight = false;
    let frameTimer: number | null = null;
    let latestOutputAt: number | null = null;
    let inputBuffer = '';
    let inputTimer: number | null = null;
    let inputQueue = Promise.resolve();
    let fitAnimation: number | null = null;
    let noticeTimer: number | null = null;
    let grid = { cols: 80, rows: 24 };
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: 'bar',
      disableStdin: false,
      fontFamily: '"SFMono-Regular", "Cascadia Code", Menlo, monospace',
      fontSize: BASE_FONT_SIZE,
      lineHeight: 1.26,
      scrollback: 0,
      theme: {
        background: '#11120f',
        foreground: '#e8e7df',
        cursor: '#d3ff75',
        cursorAccent: '#11120f',
        selectionBackground: '#65754780',
        black: '#11120f', red: '#ff7a71', green: '#b8d982', yellow: '#e9ca75',
        blue: '#86b8ff', magenta: '#c89cff', cyan: '#70d7cf', white: '#e8e7df',
        brightBlack: '#6e7168', brightRed: '#ff9a92', brightGreen: '#d3ff75', brightYellow: '#ffe49a',
        brightBlue: '#a8ccff', brightMagenta: '#ddbaff', brightCyan: '#99ece6', brightWhite: '#ffffff',
      },
    });
    terminal.open(hostRef.current);
    terminalRef.current = terminal;
    terminal.textarea?.focus({ preventScroll: true });

    const fitGrid = () => {
      if (disposed || !hostRef.current) return;
      terminal.options.fontSize = BASE_FONT_SIZE;
      terminal.resize(grid.cols, grid.rows);
      const screen = hostRef.current.querySelector<HTMLElement>('.xterm-screen');
      if (!screen) return;
      const availableWidth = Math.max(1, hostRef.current.clientWidth - 20);
      const availableHeight = Math.max(1, hostRef.current.clientHeight - 20);
      const bounds = screen.getBoundingClientRect();
      const scale = Math.min(availableWidth / Math.max(1, bounds.width), availableHeight / Math.max(1, bounds.height));
      const fontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, Math.floor(BASE_FONT_SIZE * scale)));
      terminal.options.fontSize = fontSize;
      terminal.resize(grid.cols, grid.rows);
      hostRef.current.dataset.fontSize = String(fontSize);
    };
    const scheduleFit = () => {
      if (fitAnimation !== null) window.cancelAnimationFrame(fitAnimation);
      fitAnimation = window.requestAnimationFrame(() => {
        fitAnimation = null;
        fitGrid();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleFit);
    resizeObserver.observe(hostRef.current);

    const flushInput = () => {
      if (inputTimer !== null) window.clearTimeout(inputTimer);
      inputTimer = null;
      if (!inputBuffer) return;
      const data = inputBuffer;
      inputBuffer = '';
      inputQueue = inputQueue.then(() => window.llmux.sendTerminalInput(thread.paneId, data)).catch((inputError: unknown) => {
        if (!disposed) setError(inputError instanceof Error ? inputError.message : String(inputError));
      });
    };
    const inputSubscription = terminal.onData((data) => {
      inputBuffer += data;
      if (inputTimer === null) inputTimer = window.setTimeout(flushInput, 8);
    });
    const pasteHandler = (event: ClipboardEvent) => {
      const data = event.clipboardData?.getData('text/plain') ?? '';
      if (!data) return;
      event.preventDefault();
      event.stopPropagation();
      flushInput();
      inputQueue = inputQueue.then(() => window.llmux.sendTerminalPaste(thread.paneId, data)).then(() => {
        if (!disposed) {
          setNotice('Paste sent');
          if (noticeTimer !== null) window.clearTimeout(noticeTimer);
          noticeTimer = window.setTimeout(() => setNotice(null), 2_500);
        }
      }).catch((inputError: unknown) => {
        if (!disposed) setError(inputError instanceof Error ? inputError.message : String(inputError));
      });
    };
    hostRef.current.addEventListener('paste', pasteHandler, true);

    const loadFrame = async () => {
      if (disposed || frameInFlight) return;
      frameInFlight = true;
      frameDirty = false;
      const triggeredAt = latestOutputAt;
      latestOutputAt = null;
      try {
        const frame = await window.llmux.getTerminalFrame(thread.paneId);
        if (disposed) return;
        grid = { cols: frame.width, rows: frame.height };
        fitGrid();
        if (hostRef.current) {
          hostRef.current.dataset.cols = String(frame.width);
          hostRef.current.dataset.rows = String(frame.height);
        }
        const content = frame.content.replace(/\n/g, '\r\n');
        const cursor = `\u001b[${frame.cursorY + 1};${frame.cursorX + 1}H`;
        terminal.write(`\u001b[?25l\u001b[2J\u001b[H${content}${cursor}\u001b[?25h`, () => {
          if (disposed) return;
          frameInFlight = false;
          setLastLatency(triggeredAt === null ? frame.latencyMs : Math.max(0, Date.now() - triggeredAt));
          setError(null);
          if (frameDirty) scheduleFrame();
        });
      } catch (frameError) {
        frameInFlight = false;
        if (!disposed) {
          setError(frameError instanceof Error ? frameError.message : String(frameError));
          if (frameDirty) scheduleFrame(25);
        }
      }
    };
    const scheduleFrame = (delay = 16) => {
      frameDirty = true;
      if (disposed || frameInFlight || frameTimer !== null) return;
      frameTimer = window.setTimeout(() => {
        frameTimer = null;
        void loadFrame();
      }, delay);
    };
    const outputSubscription = window.llmux.onTerminalOutput((event) => {
      if (event.paneId !== thread.paneId || disposed) return;
      latestOutputAt = event.receivedAt;
      scheduleFrame();
    });
    const streamStateSubscription = window.llmux.onTerminalStreamState((state) => {
      if (!state.connected) {
        if (!disposed) setError('Terminal stream reconnecting');
      } else {
        scheduleFrame(0);
      }
    });
    const keydownHandler = (event: KeyboardEvent) => {
      const key = terminalKey(event);
      if (!key) return;
      event.preventDefault();
      event.stopPropagation();
      flushInput();
      inputQueue = inputQueue.then(() => window.llmux.sendTerminalKey(thread.paneId, key)).catch((inputError: unknown) => {
        if (!disposed) setError(inputError instanceof Error ? inputError.message : String(inputError));
      });
    };
    hostRef.current.addEventListener('keydown', keydownHandler, true);
    scheduleFrame(0);

    return () => {
      disposed = true;
      flushInput();
      if (frameTimer !== null) window.clearTimeout(frameTimer);
      if (fitAnimation !== null) window.cancelAnimationFrame(fitAnimation);
      if (noticeTimer !== null) window.clearTimeout(noticeTimer);
      resizeObserver.disconnect();
      hostRef.current?.removeEventListener('keydown', keydownHandler, true);
      hostRef.current?.removeEventListener('paste', pasteHandler, true);
      inputSubscription.dispose();
      outputSubscription();
      streamStateSubscription();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [thread.paneId]);

  return (
    <section className="terminal-shell" data-testid="terminal-view">
      <div className="terminal-toolbar">
        <span className="terminal-dot red" /><span className="terminal-dot amber" /><span className="terminal-dot green" />
        <span className="terminal-label">{thread.tool} · {thread.paneId}</span>
        <span className="terminal-latency">{error ? 'stream unavailable' : `live · ${lastLatency} ms`}</span>
      </div>
      {error && <div className="terminal-error">{error}</div>}
      {!error && notice && <div className="terminal-notice">{notice}</div>}
      <div className="terminal-host" ref={hostRef} onClick={focusTerminal} />
    </section>
  );
}
