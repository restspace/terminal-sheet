import { useEffect, useEffectEvent, useRef } from 'react';

import { Terminal } from '@xterm/xterm';

interface TerminalFocusSurfaceProps {
  sessionId: string;
  scrollback: string;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
}

const TERMINAL_FONT_FAMILY = '"IBM Plex Mono", "Cascadia Code", monospace';
const TERMINAL_FONT_SIZE = 10.5;
const TERMINAL_LINE_HEIGHT = 1.1;
const TERMINAL_HORIZONTAL_PADDING = 20;
const TERMINAL_VERTICAL_PADDING = 14;
const DEFAULT_CELL_WIDTH = 6.4;
const DEFAULT_CELL_HEIGHT = TERMINAL_FONT_SIZE * TERMINAL_LINE_HEIGHT;
const PROBE_TEXT = 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW';
const MIN_TERMINAL_COLS = 12;
const MIN_TERMINAL_ROWS = 1;

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
  const cellSizeRef = useRef({
    width: DEFAULT_CELL_WIDTH,
    height: DEFAULT_CELL_HEIGHT,
  });
  const forwardInput = useEffectEvent((data: string) => {
    onInput(sessionId, data);
  });
  const syncBackendSize = useEffectEvent((cols: number, rows: number) => {
    onResize(sessionId, cols, rows);
  });
  const focusTerminal = useEffectEvent(() => {
    focusTerminalInput(terminalRef.current);
  });

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: true,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: TERMINAL_LINE_HEIGHT,
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
    markTerminalDomAsCanvasSafe(terminal);
    focusTerminalInput(terminal);

    lastRenderedScrollbackRef.current = '';
    terminalRef.current = terminal;

    const dataDisposable = terminal.onData((data) => {
      forwardInput(data);
    });

    cellSizeRef.current = measureCellSize(container);

    const resizeObserver = new ResizeObserver(() => {
      const size = measureTerminal(container, cellSizeRef.current);
      const sizeKey = `${size.cols}x${size.rows}`;

      if (sizeKey === lastSizeRef.current) {
        return;
      }

      lastSizeRef.current = sizeKey;
      terminal.resize(size.cols, size.rows);
      syncBackendSize(size.cols, size.rows);
    });

    resizeObserver.observe(container);

    const initialSize = measureTerminal(container, cellSizeRef.current);
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
  }, [scrollback]);

  return (
    <div
      ref={containerRef}
      className="terminal-focus-surface nodrag nopan nowheel"
      onClick={focusTerminalSurface}
      onWheel={stopCanvasInteractionPropagation}
    />
  );

  function focusTerminalSurface(
    event:
      | React.MouseEvent<HTMLDivElement>,
  ): void {
    focusTerminal();
    event.stopPropagation();
  }
}

function measureTerminal(
  container: HTMLDivElement,
  cellSize: { width: number; height: number },
): {
  cols: number;
  rows: number;
} {
  const width = Math.max(container.clientWidth - TERMINAL_HORIZONTAL_PADDING, 0);
  const height = Math.max(container.clientHeight - TERMINAL_VERTICAL_PADDING, 0);

  return {
    cols: clamp(Math.floor(width / cellSize.width), MIN_TERMINAL_COLS, 240),
    rows: clamp(Math.floor(height / cellSize.height), MIN_TERMINAL_ROWS, 120),
  };
}

function measureCellSize(container: HTMLDivElement): {
  width: number;
  height: number;
} {
  const probe = document.createElement('span');
  probe.textContent = PROBE_TEXT;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.whiteSpace = 'pre';
  probe.style.fontFamily = TERMINAL_FONT_FAMILY;
  probe.style.fontSize = `${TERMINAL_FONT_SIZE}px`;
  probe.style.lineHeight = String(TERMINAL_LINE_HEIGHT);

  container.appendChild(probe);

  const width = probe.getBoundingClientRect().width / PROBE_TEXT.length;
  const measuredLineHeight = Number.parseFloat(
    window.getComputedStyle(probe).lineHeight,
  );

  probe.remove();

  return {
    width:
      Number.isFinite(width) && width > 0 ? width : DEFAULT_CELL_WIDTH,
    height:
      Number.isFinite(measuredLineHeight) && measuredLineHeight > 0
        ? measuredLineHeight
        : DEFAULT_CELL_HEIGHT,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function focusTerminalInput(terminal: Terminal | null): void {
  if (!terminal) {
    return;
  }

  const textarea = terminal.textarea;

  if (textarea instanceof HTMLTextAreaElement) {
    try {
      textarea.focus({ preventScroll: true });
      return;
    } catch {
      textarea.focus();
      return;
    }
  }

  terminal.focus();
}

function markTerminalDomAsCanvasSafe(terminal: Terminal): void {
  const classes = ['nodrag', 'nopan', 'nowheel'];
  const elements = [
    terminal.element,
    terminal.textarea,
    terminal.element?.querySelector('.xterm-viewport'),
    terminal.element?.querySelector('.xterm-screen'),
    terminal.element?.querySelector('.xterm-helpers'),
    terminal.element?.querySelector('.xterm-helper-textarea'),
    terminal.element?.querySelector('.xterm-accessibility'),
  ];

  for (const element of elements) {
    if (element instanceof HTMLElement) {
      element.classList.add(...classes);
    }
  }
}

function stopCanvasInteractionPropagation(
  event:
    | React.PointerEvent<HTMLDivElement>
    | React.MouseEvent<HTMLDivElement>
    | React.WheelEvent<HTMLDivElement>,
): void {
  event.stopPropagation();
}
