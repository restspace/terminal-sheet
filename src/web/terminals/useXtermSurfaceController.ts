import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';

import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';

import { MAX_SCROLLBACK_CHARS } from '../../shared/scrollback';
import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from '../../shared/terminalSizeConstraints';
import { logStateDebug } from '../debug/stateDebug';
import { getIncrementalWrite } from './incrementalWrite';
import {
  DEFAULT_TERMINAL_CELL_SIZE,
  measureCellSize,
  type TerminalCellSize,
} from './terminalSizing';

export interface TerminalSurfaceProps {
  sessionId: string;
  scrollback: string;
  className?: string;
  interactionMode?: 'interactive' | 'read-only';
  sizeSource?: 'measured' | 'snapshot';
  resizeAuthority?: 'owner' | 'none';
  deferResizeSync?: boolean;
  visualScale?: number;
  snapshotCols?: number;
  snapshotRows?: number;
  canSyncResize?: boolean;
  scrollResetKey?: string | number | boolean;
  autoFocusAtMs?: number | null;
  onInput?: (sessionId: string, data: string) => void;
  onResize?: (sessionId: string, cols: number, rows: number) => boolean | void;
}

const TERMINAL_FONT_FAMILY = '"IBM Plex Mono", "Cascadia Code", monospace';
const TERMINAL_FONT_SIZE = 10.5;
const TERMINAL_LINE_HEIGHT = 1.1;
const TERMINAL_SCROLLBACK_LINES = Math.ceil(MAX_SCROLLBACK_CHARS / 48);
const WEBGL_PRESERVE_DRAWING_BUFFER = false;
const RESIZE_SYNC_RETRY_MS = 100;
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

interface TerminalSelectionContextMenu {
  x: number;
  y: number;
}

export function useXtermSurfaceController({
  sessionId,
  scrollback,
  className,
  interactionMode = 'interactive',
  sizeSource = 'measured',
  resizeAuthority = 'owner',
  deferResizeSync = false,
  visualScale = 1,
  snapshotCols,
  snapshotRows,
  canSyncResize = true,
  scrollResetKey,
  autoFocusAtMs,
  onInput,
  onResize,
}: TerminalSurfaceProps) {
  const readOnly = interactionMode === 'read-only';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const lastRenderedScrollbackRef = useRef('');
  const lastSizeRef = useRef('');
  const lastRenderedTerminalSizeRef = useRef('');
  const lastSyncedBackendSizeRef = useRef('');
  const pendingBackendSizeRef = useRef<{
    cols: number;
    rows: number;
  } | null>(null);
  const lastResizeMismatchKeyRef = useRef('');
  const pendingResizeRetryTimerRef = useRef<number | null>(null);
  const didInitializeReadOnlySizingRef = useRef(false);
  const focusTimerRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const [selectionContextMenu, setSelectionContextMenu] =
    useState<TerminalSelectionContextMenu | null>(null);
  const cellSizeRef = useRef<TerminalCellSize>(DEFAULT_TERMINAL_CELL_SIZE);
  const shouldStickToBottomRef = useRef(true);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const resizeAuthorityRef = useRef(resizeAuthority);
  resizeAuthorityRef.current = resizeAuthority;
  const sizeSourceRef = useRef(sizeSource);
  sizeSourceRef.current = sizeSource;
  const deferResizeSyncRef = useRef(deferResizeSync);
  deferResizeSyncRef.current = deferResizeSync;
  const snapshotColsRef = useRef<number | undefined>(snapshotCols);
  snapshotColsRef.current = snapshotCols;
  const snapshotRowsRef = useRef<number | undefined>(snapshotRows);
  snapshotRowsRef.current = snapshotRows;
  const canSyncResizeRef = useRef(canSyncResize);
  canSyncResizeRef.current = canSyncResize;
  const visualScaleRef = useRef(visualScale);
  visualScaleRef.current = visualScale;
  const scheduleFitRef = useRef<(() => void) | null>(null);
  const forwardInput = useEffectEvent((data: string) => {
    if (!readOnly) {
      onInput?.(sessionId, data);
    }
  });
  const syncBackendSize = useEffectEvent(
    (cols: number, rows: number, force = false) => {
      if (deferResizeSyncRef.current) {
        pendingBackendSizeRef.current = { cols, rows };
        return;
      }

      if (!canSyncResizeRef.current) {
        pendingBackendSizeRef.current = { cols, rows };
        return;
      }

      const sizeKey = `${cols}x${rows}`;
      if (!force && sizeKey === lastSyncedBackendSizeRef.current) {
        return;
      }

      logStateDebug('terminalSurface', 'resizeSentToBackend', {
        sessionId,
        cols,
        rows,
        readOnly: readOnlyRef.current,
        debounced: false,
        force,
      });
      const resizeAccepted = onResize?.(sessionId, cols, rows);

      if (resizeAccepted === false) {
        pendingBackendSizeRef.current = { cols, rows };
        if (pendingResizeRetryTimerRef.current === null) {
          pendingResizeRetryTimerRef.current = window.setTimeout(() => {
            pendingResizeRetryTimerRef.current = null;
            const pendingBackendSize = pendingBackendSizeRef.current;
            if (!pendingBackendSize) {
              return;
            }
            if (deferResizeSyncRef.current || !canSyncResizeRef.current) {
              return;
            }
            syncBackendSize(pendingBackendSize.cols, pendingBackendSize.rows);
          }, RESIZE_SYNC_RETRY_MS);
        }
        return;
      }

      lastSyncedBackendSizeRef.current = sizeKey;
      pendingBackendSizeRef.current = null;
      if (pendingResizeRetryTimerRef.current !== null) {
        window.clearTimeout(pendingResizeRetryTimerRef.current);
        pendingResizeRetryTimerRef.current = null;
      }
    },
  );

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }

    lastSyncedBackendSizeRef.current = '';
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
      resizeAuthority: resizeAuthorityRef.current,
      sizeSource: sizeSourceRef.current,
      scrollbackLength: scrollback.length,
      snapshotCols: snapshotColsRef.current ?? null,
      visualScale: visualScaleRef.current,
    });

    const dataDisposable = terminal.onData((data) => {
      forwardInput(data);
    });

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
      const currentResizeAuthority = resizeAuthorityRef.current;
      const currentSizeSource = sizeSourceRef.current;
      cellSizeRef.current = getTerminalCellSize(
        terminal,
        container,
        cellSizeRef.current,
        getTerminalFontSize(visualScaleRef.current),
      );
      const size = measureTerminal(container, cellSizeRef.current);
      const effectiveCols =
        currentSizeSource === 'snapshot' && snapshotColsRef.current
          ? snapshotColsRef.current
          : size.cols;
      const effectiveRows =
        currentSizeSource === 'snapshot' && snapshotRowsRef.current
          ? snapshotRowsRef.current
          : size.rows;
      const terminalSizeKey = `${effectiveCols}x${effectiveRows}`;
      const sizeKey = terminalSizeKey;

      if (sizeKey === lastSizeRef.current) {
        return;
      }

      lastSizeRef.current = sizeKey;
      logStateDebug('terminalSurface', 'fit', {
        sessionId,
        readOnly: isReadOnly,
        resizeAuthority: currentResizeAuthority,
        sizeSource: currentSizeSource,
        effectiveCols,
        rows: effectiveRows,
        measuredCols: size.cols,
        measuredRows: size.rows,
        snapshotCols: snapshotColsRef.current ?? null,
        snapshotRows: snapshotRowsRef.current ?? null,
        containerWidth: container.clientWidth,
        containerHeight: container.clientHeight,
      });

      if (isReadOnly) {
        const cols = effectiveCols;
        const rows = effectiveRows;
        const shouldResizeTerminal =
          terminalSizeKey !== lastRenderedTerminalSizeRef.current;
        const stickToBottom =
          terminalRef.current === terminal && shouldStickToBottomRef.current;
        terminal.write('', () => {
          if (shouldResizeTerminal) {
            terminal.resize(cols, rows);
            lastRenderedTerminalSizeRef.current = terminalSizeKey;
          }
          syncReadOnlyViewport(terminal, stickToBottom);
        });
      } else {
        const shouldRestoreFocus = shouldRestoreTerminalFocus(terminal, isReadOnly);
        const shouldResizeTerminal =
          terminalSizeKey !== lastRenderedTerminalSizeRef.current;
        terminal.write('', () => {
          if (shouldResizeTerminal) {
            terminal.resize(effectiveCols, effectiveRows);
            lastRenderedTerminalSizeRef.current = terminalSizeKey;
          }
          if (currentResizeAuthority === 'owner') {
            syncBackendSize(effectiveCols, effectiveRows);
          }
          restoreInteractiveFocusIfNeeded(terminal, shouldRestoreFocus);
        });
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
      if (pendingResizeRetryTimerRef.current !== null) {
        window.clearTimeout(pendingResizeRetryTimerRef.current);
        pendingResizeRetryTimerRef.current = null;
      }
      lastSyncedBackendSizeRef.current = '';
      pendingBackendSizeRef.current = null;
      dataDisposable?.dispose();
      container.removeEventListener('wheel', handleUserScroll);
      rendererController.dispose();
      terminal.dispose();
      terminalRef.current = null;
      lastRenderedScrollbackRef.current = '';
      lastSizeRef.current = '';
      lastRenderedTerminalSizeRef.current = '';
      logStateDebug('terminalSurface', 'unmount', {
        sessionId,
        readOnly: readOnlyRef.current,
        resizeAuthority: resizeAuthorityRef.current,
        sizeSource: sizeSourceRef.current,
      });
    };
  }, [sessionId]);

  useEffect(() => {
    if (deferResizeSync || !canSyncResize) {
      return;
    }

    const pendingBackendSize = pendingBackendSizeRef.current;
    if (!pendingBackendSize) {
      return;
    }

    syncBackendSize(pendingBackendSize.cols, pendingBackendSize.rows);
  }, [canSyncResize, deferResizeSync, syncBackendSize]);

  useEffect(() => {
    if (readOnly || resizeAuthority !== 'owner') {
      return;
    }

    if (!snapshotCols || !snapshotRows) {
      return;
    }

    const backendSizeKey = `${snapshotCols}x${snapshotRows}`;
    const renderedSizeKey = lastRenderedTerminalSizeRef.current;
    const lastSyncedSizeKey = lastSyncedBackendSizeRef.current;

    if (
      !renderedSizeKey ||
      backendSizeKey === renderedSizeKey ||
      backendSizeKey === lastSyncedSizeKey
    ) {
      lastResizeMismatchKeyRef.current = '';
      return;
    }

    const renderedSize = parseTerminalSizeKey(renderedSizeKey);

    if (!renderedSize) {
      lastResizeMismatchKeyRef.current = '';
      return;
    }

    const pendingBackendSize = pendingBackendSizeRef.current;
    const pendingSizeKey = pendingBackendSize
      ? `${pendingBackendSize.cols}x${pendingBackendSize.rows}`
      : null;

    if (pendingSizeKey === renderedSizeKey) {
      lastResizeMismatchKeyRef.current = '';
      return;
    }

    const mismatchKey = `${renderedSizeKey}->${backendSizeKey}->${pendingSizeKey ?? 'none'}`;
    if (mismatchKey === lastResizeMismatchKeyRef.current) {
      return;
    }

    lastResizeMismatchKeyRef.current = mismatchKey;
    logStateDebug('terminalSurface', 'backendResizeMismatchRecover', {
      sessionId,
      renderedSize: renderedSizeKey,
      expectedSize: lastSyncedSizeKey,
      backendSize: backendSizeKey,
      pendingSize: pendingSizeKey,
      canSyncResize,
      deferResizeSync,
    });

    if (deferResizeSync || !canSyncResize) {
      pendingBackendSizeRef.current = renderedSize;
      return;
    }

    syncBackendSize(renderedSize.cols, renderedSize.rows, true);
  }, [
    canSyncResize,
    deferResizeSync,
    readOnly,
    resizeAuthority,
    sessionId,
    snapshotCols,
    snapshotRows,
  ]);

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

  useEffect(() => {
    if (!readOnly) {
      return;
    }

    if (!didInitializeReadOnlySizingRef.current) {
      didInitializeReadOnlySizingRef.current = true;
      return;
    }

    lastSizeRef.current = '';
    scheduleFitRef.current?.();
  }, [readOnly, resizeAuthority, sizeSource, snapshotCols, snapshotRows]);

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
      terminal.write(incrementalWrite, () => {
        restoreInteractiveFocusIfNeeded(terminal, shouldRestoreFocus);
      });
    } else {
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
  }, [readOnly, scrollback, sessionId]);

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
  }, [readOnly, scrollResetKey, sessionId]);

  const onClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    focusTerminalInput(terminalRef.current);
    setSelectionContextMenu(null);
    if (!readOnly) {
      event.stopPropagation();
    }
  };

  const onContextMenu = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (readOnly) {
      return;
    }

    const terminal = terminalRef.current;
    const hasSelection = terminal?.hasSelection() ?? false;
    const selectionText = hasSelection ? terminal?.getSelection() ?? '' : '';

    if (!hasSelection || selectionText.length === 0) {
      setSelectionContextMenu(null);
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    focusTerminalInput(terminal);
    const rect = event.currentTarget.getBoundingClientRect();
    setSelectionContextMenu({
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  };

  const onDismissSelectionContextMenu = () => {
    setSelectionContextMenu(null);
  };

  const onCopySelection = async () => {
    const terminal = terminalRef.current;
    await copyTerminalSelection(terminal);
    setSelectionContextMenu(null);
  };

  const onCutSelection = async () => {
    const terminal = terminalRef.current;
    await copyTerminalSelection(terminal);
    terminal?.clearSelection();
    setSelectionContextMenu(null);
  };

  useEffect(() => {
    if (!selectionContextMenu) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('.terminal-selection-context-menu')
      ) {
        return;
      }

      setSelectionContextMenu(null);
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setSelectionContextMenu(null);
      }
    };

    const handleWindowBlur = () => {
      setSelectionContextMenu(null);
    };

    window.addEventListener('pointerdown', handlePointerDown);
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('blur', handleWindowBlur);

    return () => {
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [selectionContextMenu]);

  return {
    containerRef,
    surfaceClassName: buildSurfaceClassName(className, readOnly),
    isReadOnly: readOnly,
    selectionContextMenu,
    onPointerDown: readOnly ? undefined : stopCanvasInteractionPropagation,
    onClick,
    onContextMenu,
    onDismissSelectionContextMenu,
    onCopySelection,
    onCutSelection,
    onWheel: stopCanvasInteractionPropagation,
  };
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
    cols: clamp(
      Math.floor(width / cellSize.width),
      MIN_TERMINAL_COLS,
      MAX_TERMINAL_COLS,
    ),
    rows: clamp(
      Math.floor(height / cellSize.height),
      MIN_TERMINAL_ROWS,
      MAX_TERMINAL_ROWS,
    ),
  };
}

function getTerminalCellSize(
  terminal: Terminal,
  container: HTMLDivElement,
  fallback: TerminalCellSize,
  fontSize: number,
): TerminalCellSize {
  const measuredCellSize = getMeasuredRendererCellSize(terminal);

  if (measuredCellSize) {
    return measuredCellSize;
  }

  return measureCellSize(container, fallback, fontSize);
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

function parseTerminalSizeKey(
  sizeKey: string,
): {
  cols: number;
  rows: number;
} | null {
  const [rawCols, rawRows] = sizeKey.split('x');
  const cols = Number(rawCols);
  const rows = Number(rawRows);

  if (!Number.isFinite(cols) || !Number.isFinite(rows)) {
    return null;
  }

  if (cols <= 0 || rows <= 0) {
    return null;
  }

  return {
    cols,
    rows,
  };
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

    if (textarea instanceof HTMLElement && activeElement === textarea) {
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
    | ReactPointerEvent<HTMLDivElement>
    | ReactMouseEvent<HTMLDivElement>
    | ReactWheelEvent<HTMLDivElement>,
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

async function copyTerminalSelection(terminal: Terminal | null): Promise<void> {
  if (!terminal?.hasSelection()) {
    return;
  }

  const selectionText = terminal.getSelection();
  if (selectionText.length === 0) {
    return;
  }

  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(selectionText);
      return;
    } catch {
      // Fall back for environments where clipboard writes are blocked.
    }
  }

  copyTextWithDocumentExecCommand(selectionText);
}

function copyTextWithDocumentExecCommand(text: string): void {
  if (typeof document === 'undefined') {
    return;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  textarea.style.opacity = '0';
  document.body.append(textarea);
  textarea.select();

  try {
    document.execCommand('copy');
  } catch {
    // Ignore environments where execCommand is unavailable.
  } finally {
    textarea.remove();
  }
}
