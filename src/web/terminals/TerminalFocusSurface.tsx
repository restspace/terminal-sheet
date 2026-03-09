import { useEffect, useEffectEvent, useRef } from 'react';

import { Terminal } from '@xterm/xterm';

interface TerminalFocusSurfaceProps {
  sessionId: string;
  scrollback: string;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
}

const CHARACTER_WIDTH = 8.4;
const CHARACTER_HEIGHT = 18.5;

export function TerminalFocusSurface({
  sessionId,
  scrollback,
  onInput,
  onResize,
}: TerminalFocusSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const lastRenderedScrollbackRef = useRef('');
  const lastSizeRef = useRef('');
  const forwardInput = useEffectEvent((data: string) => {
    onInput(sessionId, data);
  });
  const syncBackendSize = useEffectEvent((cols: number, rows: number) => {
    onResize(sessionId, cols, rows);
  });

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: '"IBM Plex Mono", "Cascadia Code", monospace',
      fontSize: 14,
      scrollback: 5_000,
      theme: {
        background: '#07111a',
        foreground: '#d7e4ee',
        cursor: '#8ab4d8',
        selectionBackground: 'rgba(138, 180, 216, 0.25)',
        black: '#0b1722',
        brightBlack: '#395161',
      },
    });

    terminal.open(container);
    terminal.focus();

    lastRenderedScrollbackRef.current = '';
    terminalRef.current = terminal;

    const dataDisposable = terminal.onData((data) => {
      forwardInput(data);
    });

    const resizeObserver = new ResizeObserver(() => {
      const size = measureTerminal(container);
      const sizeKey = `${size.cols}x${size.rows}`;

      if (sizeKey === lastSizeRef.current) {
        return;
      }

      lastSizeRef.current = sizeKey;
      terminal.resize(size.cols, size.rows);
      syncBackendSize(size.cols, size.rows);
    });

    resizeObserver.observe(container);

    const initialSize = measureTerminal(container);
    lastSizeRef.current = `${initialSize.cols}x${initialSize.rows}`;
    terminal.resize(initialSize.cols, initialSize.rows);
    syncBackendSize(initialSize.cols, initialSize.rows);

    return () => {
      resizeObserver.disconnect();
      dataDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      lastRenderedScrollbackRef.current = '';
      lastSizeRef.current = '';
    };
  }, [sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;

    if (!terminal || scrollback === lastRenderedScrollbackRef.current) {
      return;
    }

    if (scrollback.startsWith(lastRenderedScrollbackRef.current)) {
      terminal.write(scrollback.slice(lastRenderedScrollbackRef.current.length));
    } else {
      terminal.reset();
      terminal.write(scrollback);
    }

    lastRenderedScrollbackRef.current = scrollback;
    terminal.focus();
  }, [scrollback]);

  return (
    <div
      ref={containerRef}
      className="terminal-focus-surface nodrag nopan"
    />
  );
}

function measureTerminal(container: HTMLDivElement): {
  cols: number;
  rows: number;
} {
  const width = Math.max(container.clientWidth - 24, 0);
  const height = Math.max(container.clientHeight - 18, 0);

  return {
    cols: clamp(Math.floor(width / CHARACTER_WIDTH), 20, 240),
    rows: clamp(Math.floor(height / CHARACTER_HEIGHT), 8, 120),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
