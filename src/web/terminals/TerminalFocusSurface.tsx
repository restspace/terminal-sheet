import { useEffect, useEffectEvent, useRef } from 'react';

import { Terminal } from '@xterm/xterm';

import {
  DEFAULT_TERMINAL_CELL_SIZE,
  measureCellSize,
  type TerminalCellSize,
} from './terminalSizing';

interface TerminalSurfaceProps {
  sessionId: string;
  scrollback: string;
  className?: string;
  readOnly?: boolean;
  autoFocusAtMs?: number | null;
  onInput?: (sessionId: string, data: string) => void;
  onResize?: (sessionId: string, cols: number, rows: number) => void;
}

const TERMINAL_FONT_FAMILY = '"IBM Plex Mono", "Cascadia Code", monospace';
const TERMINAL_FONT_SIZE = 10.5;
const TERMINAL_LINE_HEIGHT = 1.1;
const MIN_TERMINAL_COLS = 12;
const MIN_TERMINAL_ROWS = 1;

export function TerminalSurface({
  sessionId,
  scrollback,
  className,
  readOnly = false,
  autoFocusAtMs,
  onInput,
  onResize,
}: TerminalSurfaceProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const lastRenderedScrollbackRef = useRef('');
  const lastSizeRef = useRef('');
  const focusTimerRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const cellSizeRef = useRef<TerminalCellSize>(DEFAULT_TERMINAL_CELL_SIZE);
  const forwardInput = useEffectEvent((data: string) => {
    if (!readOnly) {
      onInput?.(sessionId, data);
    }
  });
  const syncBackendSize = useEffectEvent((cols: number, rows: number) => {
    if (!readOnly) {
      onResize?.(sessionId, cols, rows);
    }
  });

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    const terminal = new Terminal({
      convertEol: true,
      cursorBlink: !readOnly,
      disableStdin: readOnly,
      fontFamily: TERMINAL_FONT_FAMILY,
      fontSize: TERMINAL_FONT_SIZE,
      lineHeight: TERMINAL_LINE_HEIGHT,
      scrollback: 5_000,
      theme: {
        background: '#07111a',
        foreground: '#d7e4ee',
        cursor: readOnly ? 'transparent' : '#8ab4d8',
        selectionBackground: 'rgba(138, 180, 216, 0.25)',
        black: '#0b1722',
        brightBlack: '#395161',
      },
    });

    terminal.open(container);
    markTerminalDomAsCanvasSafe(terminal);

    if (readOnly && terminal.textarea instanceof HTMLTextAreaElement) {
      terminal.textarea.tabIndex = -1;
      terminal.textarea.setAttribute('aria-hidden', 'true');
    }

    lastRenderedScrollbackRef.current = '';
    terminalRef.current = terminal;

    const dataDisposable = readOnly
      ? null
      : terminal.onData((data) => {
          forwardInput(data);
        });

    let disposed = false;
    const fitTerminal = () => {
      cellSizeRef.current = getTerminalCellSize(
        terminal,
        container,
        cellSizeRef.current,
      );
      const size = measureTerminal(container, cellSizeRef.current);
      const sizeKey = `${size.cols}x${size.rows}`;

      if (sizeKey === lastSizeRef.current) {
        return;
      }

      lastSizeRef.current = sizeKey;
      terminal.resize(size.cols, size.rows);

      if (readOnly) {
        syncReadOnlyViewport(terminal);
      }

      if (!readOnly) {
        syncBackendSize(size.cols, size.rows);
      }
    };
    const scheduleFit = () => {
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
      }

      resizeFrameRef.current = window.requestAnimationFrame(() => {
        resizeFrameRef.current = null;
        fitTerminal();
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      scheduleFit();
    });

    resizeObserver.observe(container);

    fitTerminal();
    scheduleFit();

    const fontSet = document.fonts;
    const handleFontMetricsChange = () => {
      scheduleFit();
    };

    if (typeof fontSet?.addEventListener === 'function') {
      fontSet.addEventListener('loadingdone', handleFontMetricsChange);
    }

    if (fontSet?.ready) {
      void fontSet.ready.then(() => {
        if (!disposed) {
          scheduleFit();
        }
      });
    }

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      if (typeof fontSet?.removeEventListener === 'function') {
        fontSet.removeEventListener('loadingdone', handleFontMetricsChange);
      }
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      dataDisposable?.dispose();
      terminal.dispose();
      terminalRef.current = null;
      lastRenderedScrollbackRef.current = '';
      lastSizeRef.current = '';
    };
  }, [readOnly, sessionId]);

  useEffect(() => {
    if (readOnly) {
      return;
    }

    const focusTerminal = () => {
      focusTimerRef.current = null;
      focusTerminalInput(terminalRef.current);
    };
    const focusDelayMs = Math.max(
      0,
      (autoFocusAtMs ?? performance.now()) - performance.now(),
    );

    if (focusDelayMs === 0) {
      focusTerminal();
      return;
    }

    focusTimerRef.current = window.setTimeout(focusTerminal, focusDelayMs);

    return () => {
      if (focusTimerRef.current !== null) {
        window.clearTimeout(focusTimerRef.current);
        focusTimerRef.current = null;
      }
    };
  }, [autoFocusAtMs, readOnly, sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;

    if (!terminal || scrollback === lastRenderedScrollbackRef.current) {
      return;
    }

    if (scrollback.startsWith(lastRenderedScrollbackRef.current)) {
      terminal.write(scrollback.slice(lastRenderedScrollbackRef.current.length), () => {
        if (readOnly) {
          syncReadOnlyViewport(terminal);
        }
      });
    } else {
      terminal.reset();
      terminal.write(scrollback, () => {
        if (readOnly) {
          syncReadOnlyViewport(terminal);
        }
      });
    }

    lastRenderedScrollbackRef.current = scrollback;
  }, [readOnly, scrollback]);

  return (
    <div
      ref={containerRef}
      className={buildSurfaceClassName(className, readOnly)}
      aria-hidden={readOnly}
      onClick={readOnly ? undefined : focusTerminalSurface}
      onWheel={stopCanvasInteractionPropagation}
    />
  );

  function focusTerminalSurface(event: React.MouseEvent<HTMLDivElement>): void {
    focusTerminalInput(terminalRef.current);
    event.stopPropagation();
  }
}

export function TerminalFocusSurface(props: {
  autoFocusAtMs?: number | null;
  sessionId: string;
  scrollback: string;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
}) {
  return <TerminalSurface {...props} className="terminal-focus-surface" />;
}

function measureTerminal(
  container: HTMLDivElement,
  cellSize: TerminalCellSize,
): {
  cols: number;
  rows: number;
} {
  const width = Math.max(container.clientWidth, 0);
  const height = Math.max(container.clientHeight, 0);

  return {
    cols: clamp(Math.floor(width / cellSize.width), MIN_TERMINAL_COLS, 240),
    rows: clamp(Math.floor(height / cellSize.height), MIN_TERMINAL_ROWS, 120),
  };
}

function getTerminalCellSize(
  terminal: Terminal,
  container: HTMLDivElement,
  fallback: TerminalCellSize,
): TerminalCellSize {
  const measuredCellSize = getMeasuredRendererCellSize(terminal);

  if (measuredCellSize) {
    return measuredCellSize;
  }

  return measureCellSize(container, fallback);
}

function getMeasuredRendererCellSize(
  terminal: Terminal,
): TerminalCellSize | null {
  const core = (terminal as Terminal & {
    _core?: {
      _renderService?: {
        dimensions?: {
          css?: {
            cell?: {
              width?: number;
              height?: number;
            };
          };
        };
      };
    };
  })._core;
  const cell = core?._renderService?.dimensions?.css?.cell;
  const width = cell?.width ?? 0;
  const height = cell?.height ?? 0;

  if (!Number.isFinite(width) || width <= 0) {
    return null;
  }

  if (!Number.isFinite(height) || height <= 0) {
    return null;
  }

  return { width, height };
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

function markTerminalDomAsCanvasSafe(
  terminal: Terminal,
): void {
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

function buildSurfaceClassName(
  className: string | undefined,
  readOnly: boolean,
): string {
  const classes = ['terminal-surface', 'nodrag', 'nopan', 'nowheel'];

  if (className) {
    classes.push(className);
  }

  if (readOnly) {
    classes.push('is-read-only');
  }

  return classes.join(' ');
}

function stopCanvasInteractionPropagation(
  event:
    | React.PointerEvent<HTMLDivElement>
    | React.MouseEvent<HTMLDivElement>
    | React.WheelEvent<HTMLDivElement>,
): void {
  event.stopPropagation();
}

function syncReadOnlyViewport(terminal: Terminal): void {
  terminal.scrollToBottom();
  terminal.refresh(0, Math.max(terminal.rows - 1, 0));
}
