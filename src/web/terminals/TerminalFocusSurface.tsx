import { useEffect, useEffectEvent, useRef } from 'react';

import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';

import { MAX_SCROLLBACK_CHARS } from '../../shared/scrollback';
import {
  DEFAULT_TERMINAL_CELL_SIZE,
  measureCellSize,
  type TerminalCellSize,
} from './terminalSizing';
import { getIncrementalWrite } from './incrementalWrite';
import { logStateDebug } from '../debug/stateDebug';

interface TerminalSurfaceProps {
  sessionId: string;
  scrollback: string;
  className?: string;
  readOnly?: boolean;
  visualScale?: number;
  // For read-only surfaces: the col count the PTY was sized to when it
  // generated the scrollback content. Using the PTY's own col count ensures
  // in-place \r rewrites land at the correct cursor column regardless of the
  // container's CSS pixel width. If omitted, the terminal measures from the
  // container as usual (same behaviour as the focused terminal).
  ptyCols?: number;
  scrollResetKey?: string | number | boolean;
  autoFocusAtMs?: number | null;
  onInput?: (sessionId: string, data: string) => void;
  onResize?: (sessionId: string, cols: number, rows: number) => void;
}

const TERMINAL_FONT_FAMILY = '"IBM Plex Mono", "Cascadia Code", monospace';
const TERMINAL_FONT_SIZE = 10.5;
const TERMINAL_LINE_HEIGHT = 1.1;
// Keep xterm's internal line buffer aligned with the app's 120k-char
// scrollback cap so mounted surfaces do not retain substantially more history.
const TERMINAL_SCROLLBACK_LINES = Math.ceil(MAX_SCROLLBACK_CHARS / 48);
const MIN_TERMINAL_COLS = 12;
const MIN_TERMINAL_ROWS = 1;
const WEBGL_PRESERVE_DRAWING_BUFFER = false;
const TERMINAL_THEME = {
  background: '#07111a',
  foreground: '#d7e4ee',
  cursor: '#8ab4d8',
  selectionBackground: 'rgba(138, 180, 216, 0.25)',
  black: '#0b1722',
  red: '#ff7b72',
  green: '#5ec48b',
  yellow: '#f2cc60',
  blue: '#8ab4d8',
  magenta: '#d6a5ff',
  cyan: '#56d4dd',
  white: '#d7e4ee',
  brightBlack: '#395161',
  brightRed: '#ff938f',
  brightGreen: '#7ad7a2',
  brightYellow: '#f6d77d',
  brightBlue: '#9dc7f5',
  brightMagenta: '#e2bbff',
  brightCyan: '#7ce7ef',
  brightWhite: '#f4fbff',
} as const;

type RendererMode = 'default' | 'canvas' | 'webgl';

interface RendererController {
  mode: RendererMode;
  dispose: () => void;
}

export function TerminalSurface({
  sessionId,
  scrollback,
  className,
  readOnly = false,
  visualScale = 1,
  ptyCols,
  scrollResetKey,
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
  const shouldStickToBottomRef = useRef(true);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  // Mutable ref so fitTerminal always sees the latest ptyCols without being
  // recreated.  Updated synchronously on every render (not via an effect).
  const ptyColsRef = useRef<number | undefined>(ptyCols);
  ptyColsRef.current = ptyCols;
  const visualScaleRef = useRef(visualScale);
  visualScaleRef.current = visualScale;
  // Stable ref to scheduleFit so the ptyCols-change effect below can request
  // a re-fit without needing access to the mount-effect's closure.
  const scheduleFitRef = useRef<(() => void) | null>(null);
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

    const terminal = new Terminal(createTerminalOptions(visualScaleRef.current));

    terminal.open(container);
    const rendererController = initializeTerminalRenderer(terminal);
    applyTerminalInteractivity(terminal, readOnlyRef.current);
    markTerminalDomAsCanvasSafe(terminal);

    lastRenderedScrollbackRef.current = '';
    shouldStickToBottomRef.current = true;
    terminalRef.current = terminal;
    logStateDebug('terminalSurface', 'mount', {
      sessionId,
      readOnly,
      scrollbackLength: scrollback.length,
      ptyCols: ptyColsRef.current ?? null,
      visualScale: visualScaleRef.current,
    });

    const dataDisposable = terminal.onData((data) => {
      forwardInput(data);
    });

    // Track whether user has scrolled away from the bottom.
    // wheel listener rather than terminal.onScroll() because onScroll fires
    // on internal buffer growth (new lines added during writes), not just on
    // user-initiated scrolling. Using onScroll caused shouldStickToBottomRef
    // to be prematurely set to false during rapid output, breaking auto-scroll.
    const handleUserScroll = () => {
      window.requestAnimationFrame(() => {
        if (terminalRef.current === terminal) {
          shouldStickToBottomRef.current = isViewportNearBottom(terminal);
        }
      });
    };

    container.addEventListener('wheel', handleUserScroll, { passive: true });

    let disposed = false;
    const fitTerminal = () => {
      const isReadOnly = readOnlyRef.current;
      cellSizeRef.current = getTerminalCellSize(
        terminal,
        container,
        cellSizeRef.current,
      );
      const size = measureTerminal(container, cellSizeRef.current);
      // For read-only terminals, use the PTY's authoritative col count so that
      // \r-based in-place rewrites land at the same cursor column as they did
      // when the PTY generated the output.  The focused terminal sends its own
      // col count to the PTY via onResize; the PTY stores it in session.cols,
      // which callers pass as ptyCols here.  When ptyCols is absent (focused
      // terminal path), fall back to the measured col count as before.
      const effectiveCols = isReadOnly && ptyColsRef.current
        ? ptyColsRef.current
        : size.cols;
      const sizeKey = `${effectiveCols}x${size.rows}`;

      if (sizeKey === lastSizeRef.current) {
        return;
      }

      lastSizeRef.current = sizeKey;
      logStateDebug('terminalSurface', 'fit', {
        sessionId,
        readOnly: isReadOnly,
        effectiveCols,
        rows: size.rows,
        measuredCols: size.cols,
        ptyCols: ptyColsRef.current ?? null,
        containerWidth: container.clientWidth,
        containerHeight: container.clientHeight,
      });

      if (isReadOnly) {
        // Queue the resize through xterm's write pipeline so it executes
        // AFTER any pending terminal.write() calls. A synchronous resize
        // between queued writes can reflow the buffer and displace the
        // cursor, causing \r-based ticker updates to land on the wrong
        // line (the "frozen ticker" artifact).
        const cols = effectiveCols;
        const rows = size.rows;
        const stickToBottom =
          terminalRef.current === terminal && shouldStickToBottomRef.current;
        terminal.write('', () => {
          terminal.resize(cols, rows);
          syncReadOnlyViewport(terminal, stickToBottom);
        });
      } else {
        const shouldRestoreFocus = shouldRestoreTerminalFocus(terminal, isReadOnly);
        terminal.resize(effectiveCols, size.rows);
        logStateDebug('terminalSurface', 'resizeSentToBackend', {
          sessionId,
          cols: effectiveCols,
          rows: size.rows,
        });
        syncBackendSize(effectiveCols, size.rows);
        restoreInteractiveFocusIfNeeded(terminal, shouldRestoreFocus);
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

    scheduleFitRef.current = scheduleFit;

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
      scheduleFitRef.current = null;
      resizeObserver.disconnect();
      if (typeof fontSet?.removeEventListener === 'function') {
        fontSet.removeEventListener('loadingdone', handleFontMetricsChange);
      }
      if (resizeFrameRef.current !== null) {
        window.cancelAnimationFrame(resizeFrameRef.current);
        resizeFrameRef.current = null;
      }
      dataDisposable?.dispose();
      container.removeEventListener('wheel', handleUserScroll);
      rendererController.dispose();
      terminal.dispose();
      terminalRef.current = null;
      lastRenderedScrollbackRef.current = '';
      lastSizeRef.current = '';
      logStateDebug('terminalSurface', 'unmount', {
        sessionId,
        readOnly: readOnlyRef.current,
      });
    };
  }, [sessionId]);

  useEffect(() => {
    const terminal = terminalRef.current;

    if (!terminal) {
      return;
    }

    if (
      terminal.options.disableStdin === readOnly &&
      terminal.options.cursorBlink === !readOnly
    ) {
      return;
    }

    applyTerminalInteractivity(terminal, readOnly);
    lastSizeRef.current = '';
    scheduleFitRef.current?.();
  }, [readOnly]);

  useEffect(() => {
    const terminal = terminalRef.current;

    if (!terminal) {
      return;
    }

    const nextFontSize = getTerminalFontSize(visualScale);

    if (almostEqualOption(terminal.options.fontSize, nextFontSize)) {
      return;
    }

    terminal.options.fontSize = nextFontSize;
    terminal.options.lineHeight = TERMINAL_LINE_HEIGHT;
    lastSizeRef.current = '';
    scheduleFitRef.current?.();
  }, [visualScale]);

  // When the PTY's col count changes (e.g. the focused terminal node was resized),
  // invalidate the cached size so the next fit uses the new ptyCols value.
  useEffect(() => {
    if (!readOnly || !ptyCols) {
      return;
    }

    lastSizeRef.current = '';
    scheduleFitRef.current?.();
  }, [readOnly, ptyCols]);

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
    const previousScrollback = lastRenderedScrollbackRef.current;

    if (!terminal || scrollback === previousScrollback) {
      return;
    }

    const incrementalWrite = getIncrementalWrite(previousScrollback, scrollback);
    const shouldRestoreFocus = shouldRestoreTerminalFocus(terminal, readOnly);

    if (incrementalWrite !== null) {
      // No scrollToBottom() call here. xterm's buffer service auto-scrolls
      // when the viewport was already at the bottom (ydisp === ybase), so
      // both new-line output and in-place \r updates render correctly without
      // any manual intervention. Calling scrollToBottom() from a write
      // callback fires xterm's internal scroll event mid-render, disrupting
      // dirty-row tracking and causing visual corruption.
      terminal.write(incrementalWrite, () => {
        restoreInteractiveFocusIfNeeded(terminal, shouldRestoreFocus);
      });
    } else {
      // Write the VT full-reset sequence (RIS) in-band rather than calling
      // terminal.reset() synchronously. terminal.reset() clears terminal state
      // immediately but does NOT flush xterm's internal write queue, so any
      // writes queued before the reset still execute afterwards, re-introducing
      // stale content. Serialising the reset through the write queue ensures
      // the slate is wiped only after all previously queued data has processed.
      terminal.write('\x1bc' + scrollback, () => {
        restoreInteractiveFocusIfNeeded(terminal, shouldRestoreFocus);
      });
      logStateDebug('terminalSurface', 'fullResetWrite', {
        sessionId,
        readOnly,
        scrollbackLength: scrollback.length,
        previousScrollbackLength: previousScrollback.length,
      });
    }

    lastRenderedScrollbackRef.current = scrollback;
  }, [readOnly, scrollback]);

  useEffect(() => {
    if (!readOnly) {
      return;
    }

    shouldStickToBottomRef.current = true;
    syncReadOnlyViewport(terminalRef.current, true);
    logStateDebug('terminalSurface', 'scrollReset', {
      sessionId,
      readOnly,
      scrollResetKey: scrollResetKey ?? null,
    });
  }, [readOnly, scrollResetKey]);

  return (
    <div
      ref={containerRef}
      className={buildSurfaceClassName(className, readOnly)}
      aria-hidden={readOnly}
      onPointerDown={readOnly ? undefined : stopCanvasInteractionPropagation}
      onClick={focusTerminalSurface}
      onWheel={stopCanvasInteractionPropagation}
    />
  );

  function focusTerminalSurface(event: React.MouseEvent<HTMLDivElement>): void {
    focusTerminalInput(terminalRef.current);
    // For the interactive surface stop propagation so terminal clicks stay
    // inside the node instead of reaching the canvas selection/pan layer.
    // For the read-only card we let the click bubble so the node still gets
    // selected normally.
    if (!readOnly) {
      event.stopPropagation();
    }
  }
}

export function TerminalFocusSurface(props: {
  autoFocusAtMs?: number | null;
  sessionId: string;
  scrollback: string;
  visualScale?: number;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
}) {
  return <TerminalSurface {...props} className="terminal-focus-surface" />;
}

export function ReadOnlyTerminalSurface(props: {
  sessionId: string;
  scrollback: string;
  className?: string;
  ptyCols?: number;
  scrollResetKey?: string | number | boolean;
}) {
  return <TerminalSurface {...props} readOnly />;
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

function shouldRestoreTerminalFocus(
  terminal: Terminal,
  readOnly: boolean,
): boolean {
  if (readOnly || typeof document === 'undefined') {
    return false;
  }

  const activeElement = document.activeElement;
  const terminalElement = terminal.element;
  const textarea = terminal.textarea;

  if (textarea instanceof HTMLElement && activeElement === textarea) {
    return true;
  }

  return terminalElement instanceof HTMLElement
    ? terminalElement.contains(activeElement)
    : false;
}

function restoreInteractiveFocusIfNeeded(
  terminal: Terminal,
  shouldRestoreFocus: boolean,
): void {
  if (!shouldRestoreFocus) {
    return;
  }

  window.requestAnimationFrame(() => {
    const terminalElement = terminal.element;
    const textarea = terminal.textarea;
    const activeElement = document.activeElement;

    if (
      textarea instanceof HTMLElement &&
      activeElement === textarea
    ) {
      return;
    }

    if (
      terminalElement instanceof HTMLElement &&
      terminalElement.contains(activeElement)
    ) {
      return;
    }

    focusTerminalInput(terminal);
  });
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

function syncReadOnlyViewport(
  terminal: Terminal | null,
  isActive = true,
): void {
  if (!terminal || !isActive) {
    return;
  }

  try {
    terminal.scrollToBottom();
    // Do not call terminal.refresh() here. xterm schedules its own render
    // after scrollToBottom(); explicitly calling refresh() inside a write
    // callback forces renders at intermediate buffer states during rapid
    // output, causing visual corruption (missing chars, duplicated rows).
  } catch {
    // Ignore viewport-sync races during terminal disposal/remount.
  }
}

function isViewportNearBottom(terminal: Terminal): boolean {
  const activeBuffer = terminal.buffer.active;

  return activeBuffer.baseY - activeBuffer.viewportY <= 1;
}

function initializeTerminalRenderer(
  terminal: Terminal,
): RendererController {
  const webglRenderer = installWebglRenderer(terminal);

  if (webglRenderer) {
    return webglRenderer;
  }

  const canvasRenderer = installCanvasRenderer(terminal);

  if (canvasRenderer) {
    return canvasRenderer;
  }

  return {
    mode: 'default',
    dispose: () => {},
  };
}

function installWebglRenderer(terminal: Terminal): RendererController | null {
  try {
    const addon = new WebglAddon(WEBGL_PRESERVE_DRAWING_BUFFER);
    let currentFallback: RendererController | null = null;
    let disposed = false;
    let contextLossSubscription: { dispose(): void } | null =
      addon.onContextLoss(() => {
        if (disposed || currentFallback) {
          return;
        }

        contextLossSubscription?.dispose();
        contextLossSubscription = null;
        currentFallback = installCanvasRenderer(terminal);
      });

    terminal.loadAddon(addon);
    markTerminalDomAsCanvasSafe(terminal);

    return {
      mode: 'webgl',
      dispose: () => {
        if (disposed) {
          return;
        }

        disposed = true;
        contextLossSubscription?.dispose();
        contextLossSubscription = null;
        currentFallback?.dispose();
        currentFallback = null;
      },
    };
  } catch {
    return null;
  }
}

function installCanvasRenderer(terminal: Terminal): RendererController | null {
  try {
    const addon = new CanvasAddon();
    terminal.loadAddon(addon);
    markTerminalDomAsCanvasSafe(terminal);

    return {
      mode: 'canvas',
      // terminal.loadAddon transfers ownership to xterm's addon manager.
      dispose: () => {},
    };
  } catch {
    return null;
  }
}

function createTerminalOptions(
  visualScale: number,
): NonNullable<ConstructorParameters<typeof Terminal>[0]> {
  return {
    allowTransparency: true,
    convertEol: true,
    cursorBlink: true,
    disableStdin: false,
    fontFamily: TERMINAL_FONT_FAMILY,
    fontSize: getTerminalFontSize(visualScale),
    lineHeight: TERMINAL_LINE_HEIGHT,
    scrollback: TERMINAL_SCROLLBACK_LINES,
    theme: TERMINAL_THEME,
  };
}

function applyTerminalInteractivity(
  terminal: Terminal,
  readOnly: boolean,
): void {
  terminal.options.disableStdin = readOnly;
  terminal.options.cursorBlink = !readOnly;
  terminal.options.theme = getTerminalTheme(readOnly);

  const textarea = terminal.textarea;

  if (!(textarea instanceof HTMLTextAreaElement)) {
    return;
  }

  textarea.tabIndex = readOnly ? -1 : 0;

  if (readOnly) {
    textarea.setAttribute('aria-hidden', 'true');
    return;
  }

  textarea.removeAttribute('aria-hidden');
}

function getTerminalTheme(
  readOnly: boolean,
): NonNullable<ConstructorParameters<typeof Terminal>[0]>['theme'] {
  return {
    ...TERMINAL_THEME,
    cursor: readOnly ? 'transparent' : TERMINAL_THEME.cursor,
  };
}

function getTerminalFontSize(visualScale: number): number {
  const fontScale = clamp(visualScale, 0.5, 2);
  return Number((TERMINAL_FONT_SIZE * fontScale).toFixed(2));
}

function almostEqualOption(value: unknown, nextValue: number): boolean {
  return typeof value === 'number' && Math.abs(value - nextValue) < 0.001;
}

