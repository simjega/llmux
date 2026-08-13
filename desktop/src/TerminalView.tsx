import { useEffect, useRef, useState } from 'react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { ThreadSnapshot } from './shared/types';

interface TerminalViewProps {
  thread: ThreadSnapshot;
}

export function TerminalView({ thread }: TerminalViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [lastLatency, setLastLatency] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const blockPaste = (event: React.ClipboardEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    setNotice('Paste is disabled in this preview; use the attached tmux client for safe bracketed paste.');
  };

  useEffect(() => {
    if (!hostRef.current) return undefined;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      cursorStyle: 'bar',
      disableStdin: false,
      fontFamily: '"SFMono-Regular", "Cascadia Code", Menlo, monospace',
      fontSize: 13,
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
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(hostRef.current);
    fit.fit();
    terminal.focus();
    terminalRef.current = terminal;

    const inputSubscription = terminal.onData((data) => {
      void window.llmux.sendTerminalInput(thread.paneId, data).catch((inputError: unknown) => {
        setError(inputError instanceof Error ? inputError.message : String(inputError));
      });
    });
    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(hostRef.current);
    return () => {
      inputSubscription.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [thread.paneId]);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    let lastFrame = '';
    const refresh = async () => {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const frame = await window.llmux.getTerminalFrame(thread.paneId);
        const frameKey = `${frame.content}\0${frame.cursorX}:${frame.cursorY}`;
        if (!disposed && frameKey !== lastFrame && terminalRef.current) {
          lastFrame = frameKey;
          const cursor = `\u001b[${frame.cursorY + 1};${frame.cursorX + 1}H`;
          terminalRef.current.write(`\u001b[?25l\u001b[2J\u001b[H${frame.content}${cursor}\u001b[?25h`);
        }
        if (!disposed) {
          setLastLatency(frame.latencyMs);
          setError(null);
        }
      } catch (frameError) {
        if (!disposed) setError(frameError instanceof Error ? frameError.message : String(frameError));
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(refresh, 350);
    return () => {
      disposed = true;
      window.clearInterval(timer);
    };
  }, [thread.paneId]);

  return (
    <section className="terminal-shell" data-testid="terminal-view">
      <div className="terminal-toolbar">
        <span className="terminal-dot red" /><span className="terminal-dot amber" /><span className="terminal-dot green" />
        <span className="terminal-label">{thread.tool} · {thread.paneId}</span>
        <span className="terminal-latency">{error ? 'capture unavailable' : `${lastLatency} ms capture`}</span>
      </div>
      {error && <div className="terminal-error">{error}</div>}
      {!error && notice && <div className="terminal-error">{notice}</div>}
      <div className="terminal-host" ref={hostRef} onPasteCapture={blockPaste} onClick={() => terminalRef.current?.focus()} />
    </section>
  );
}
