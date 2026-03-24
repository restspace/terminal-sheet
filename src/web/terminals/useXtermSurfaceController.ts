import {
  useEffect,
  useEffectEvent,
  useRef,
  useState,
  type MutableRefObject,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from 'react';

import { CanvasAddon } from '@xterm/addon-canvas';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal } from '@xterm/xterm';

import { MAX_SCROLLBACK_CHARS } from '../../shared/scrollback';
import { logStateDebug } from '../debug/stateDebug';
import { getIncrementalWrite } from './incrementalWrite';
import { measureLiveTerminalGeometry } from './terminalGeometry';
import {
  observeAppliedTerminalResizeGeneration,
  reserveNextTerminalResizeGeneration,
} from './terminalResizeGeneration';
import {
  DEFAULT_TERMINAL_CELL_SIZE,
  type TerminalCellSize,
} from './terminalSizing';

export interface TerminalSurfaceProps {
  sessionId: string;
  scrollback: string;
  className?: string;
  acceptsInput?: boolean;
  freezeGeometry?: boolean;
  visualScale?: number;
  appliedCols?: number | null;
  appliedRows?: number | null;
  appliedResizeGeneration?: number | null;
  canSyncResize?: boolean;
  scrollResetKey?: string | number | boolean;
  autoFocusAtMs?: number | null;
  onInput?: (sessionId: string, data: string) => void;
  onResize?: (
    sessionId: string,
    cols: number,
    rows: number,
    generation: number,
  ) => boolean | void;
  onResizeSyncError?: (details: {
    sessionId: string;
    cols: number;
    rows: number;
    timeoutMs: number;
  }) => void;
  onTimedOut?: () => void;
}

const TERMINAL_FONT_FAMILY = '"IBM Plex Mono", "Cascadia Code", monospace';
const TERMINAL_FONT_SIZE = 10.5;
const TERMINAL_LINE_HEIGHT = 1.1;
const TERMINAL_SCROLLBACK_LINES = Math.ceil(MAX_SCROLLBACK_CHARS / 48);
const WEBGL_PRESERVE_DRAWING_BUFFER = false;
const RESIZE_SYNC_RETRY_DELAYS_MS = [100, 200, 400] as const;
const RESIZE_SYNC_FAILURE_TIMEOUT_MS = 10_000;
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
type ResizeSyncBlockedReason =
  | 'geometry-frozen'
  | 'socket-unavailable'
  | 'rejected-send';
interface PendingResizeRequest {
  cols: number;
  rows: number;
  generation: number;
  sent: boolean;
}

export function useXtermSurfaceController({
  sessionId,
  scrollback,
  className,
  acceptsInput = true,
  freezeGeometry = false,
  visualScale = 1,
  appliedCols = null,
  appliedRows = null,
  appliedResizeGeneration = null,
  canSyncResize = true,
  scrollResetKey,
  autoFocusAtMs,
  onInput,
  onResize,
  onResizeSyncError,
  onTimedOut,
}: TerminalSurfaceProps) {
  const readOnly = !acceptsInput;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const lastRenderedScrollbackRef = useRef('');
  const lastFitStateKeyRef = useRef('');
  const lastRenderedTerminalSizeRef = useRef('');
  const pendingResizeRequestRef = useRef<PendingResizeRequest | null>(null);
  const pendingResizeRetryTimerRef = useRef<number | null>(null);
  const resizeSyncRetryDelayIndexRef = useRef(0);
  const resizeSyncFailureTimerRef = useRef<number | null>(null);
  const resizeSyncFailureRequestKeyRef = useRef<string | null>(null);
  const resizeSyncTimedOutRequestKeyRef = useRef<string | null>(null);
  const hasAttemptedResizeSyncRef = useRef(false);
  const resizeSyncBlockedReasonRef = useRef<ResizeSyncBlockedReason | null>(null);
  const resizeSyncBlockedRequestRef = useRef<PendingResizeRequest | null>(null);
  const focusTimerRef = useRef<number | null>(null);
  const resizeFrameRef = useRef<number | null>(null);
  const [selectionContextMenu, setSelectionContextMenu] =
    useState<TerminalSelectionContextMenu | null>(null);
  const [isResizePending, setIsResizePending] = useState(false);
  const cellSizeRef = useRef<TerminalCellSize>(DEFAULT_TERMINAL_CELL_SIZE);
  const shouldStickToBottomRef = useRef(true);
  const readOnlyRef = useRef(readOnly);
  readOnlyRef.current = readOnly;
  const freezeGeometryRef = useRef(freezeGeometry);
  freezeGeometryRef.current = freezeGeometry;
  const appliedColsRef = useRef<number | null>(appliedCols);
  appliedColsRef.current = appliedCols;
  const appliedRowsRef = useRef<number | null>(appliedRows);
  appliedRowsRef.current = appliedRows;
  const appliedResizeGenerationRef = useRef<number | null>(appliedResizeGeneration);
  appliedResizeGenerationRef.current = appliedResizeGeneration;
  const canSyncResizeRef = useRef(canSyncResize);
  canSyncResizeRef.current = canSyncResize;
  const visualScaleRef = useRef(visualScale);
  visualScaleRef.current = visualScale;
  const scheduleFitRef = useRef<(() => void) | null>(null);
  const onResizeSyncErrorRef = useRef(onResizeSyncError);
  const dispatchPendingResizeRef = useRef<((fromRetry?: boolean) => void) | null>(
    null,
  );
  onResizeSyncErrorRef.current = onResizeSyncError;
  const markResizeSyncBlocked = useEffectEvent((
    reason: ResizeSyncBlockedReason,
    request: PendingResizeRequest,
  ) => {

    if (
      resizeSyncBlockedReasonRef.current === reason &&
      areResizeRequestsEqual(resizeSyncBlockedRequestRef.current, request)
    ) {
      return;
    }

    resizeSyncBlockedReasonRef.current = reason;
    resizeSyncBlockedRequestRef.current = request;
    logStateDebug('terminalSurface', 'resizeSyncBlocked', {
      sessionId,
      reason,
      cols: request.cols,
      rows: request.rows,
      generation: request.generation,
      canSyncResize: canSyncResizeRef.current,
      freezeGeometry: freezeGeometryRef.current,
      hasAttemptedResizeSync: hasAttemptedResizeSyncRef.current,
    });
  });
  const clearResizeSyncBlocked = useEffectEvent((
    result: 'applied' | 'cleared' | 'requested',
  ) => {
    const previousReason = resizeSyncBlockedReasonRef.current;
    const previousRequest = resizeSyncBlockedRequestRef.current;

    if (!previousReason || !previousRequest) {
      return;
    }
    logStateDebug('terminalSurface', 'resizeSyncUnblocked', {
      sessionId,
      previousReason,
      previousCols: previousRequest.cols,
      previousRows: previousRequest.rows,
      previousGeneration: previousRequest.generation,
      result,
    });
    resizeSyncBlockedReasonRef.current = null;
    resizeSyncBlockedRequestRef.current = null;
  });
  const forwardInput = useEffectEvent((data: string) => {
    if (!readOnly) {
      onInput?.(sessionId, data);
    }
  });
  const dispatchPendingResize = useEffectEvent((fromRetry = false) => {
    const pendingRequest = pendingResizeRequestRef.current;

    if (!pendingRequest) {
      return;
    }

    if (pendingRequest.sent && !fromRetry) {
      return;
    }

    const requestKey = getResizeRequestKey(pendingRequest);
    if (resizeSyncTimedOutRequestKeyRef.current === requestKey) {
      return;
    }

    if (
      resizeSyncTimedOutRequestKeyRef.current &&
      resizeSyncTimedOutRequestKeyRef.current !== requestKey &&
      !fromRetry
    ) {
      resizeSyncTimedOutRequestKeyRef.current = null;
    }

    if (freezeGeometryRef.current) {
      markResizeSyncBlocked('geometry-frozen', pendingRequest);
      if (hasAttemptedResizeSyncRef.current) {
        scheduleResizeSyncFailureDeadline({
          sessionId,
          request: pendingRequest,
          timeoutMs: RESIZE_SYNC_FAILURE_TIMEOUT_MS,
          pendingResizeRequestRef,
          pendingResizeRetryTimerRef,
          resizeSyncRetryDelayIndexRef,
          resizeSyncFailureTimerRef,
          resizeSyncFailureRequestKeyRef,
          resizeSyncTimedOutRequestKeyRef,
          onResizeSyncError: onResizeSyncErrorRef.current,
          onTimedOut: () => {
            setIsResizePending(false);
            onTimedOut?.();
          },
          reason: 'geometry-frozen',
        });
      } else {
        clearResizeSyncFailureDeadline(
          resizeSyncFailureTimerRef,
          resizeSyncFailureRequestKeyRef,
        );
      }
      return;
    }

    if (!canSyncResizeRef.current) {
      markResizeSyncBlocked('socket-unavailable', pendingRequest);
      if (hasAttemptedResizeSyncRef.current) {
        scheduleResizeSyncFailureDeadline({
          sessionId,
          request: pendingRequest,
          timeoutMs: RESIZE_SYNC_FAILURE_TIMEOUT_MS,
          pendingResizeRequestRef,
          pendingResizeRetryTimerRef,
          resizeSyncRetryDelayIndexRef,
          resizeSyncFailureTimerRef,
          resizeSyncFailureRequestKeyRef,
          resizeSyncTimedOutRequestKeyRef,
          onResizeSyncError: onResizeSyncErrorRef.current,
          onTimedOut: () => {
            setIsResizePending(false);
            onTimedOut?.();
          },
          reason: 'socket-unavailable',
        });
      } else {
        clearResizeSyncFailureDeadline(
          resizeSyncFailureTimerRef,
          resizeSyncFailureRequestKeyRef,
        );
      }
      return;
    }

    if (!fromRetry) {
      clearResizeSyncRetryState(
        pendingResizeRetryTimerRef,
        resizeSyncRetryDelayIndexRef,
      );
    }

    logStateDebug('terminalSurface', 'resizeSentToBackend', {
      sessionId,
      cols: pendingRequest.cols,
      rows: pendingRequest.rows,
      generation: pendingRequest.generation,
      readOnly: readOnlyRef.current,
    });
    hasAttemptedResizeSyncRef.current = true;
    const resizeAccepted = onResize?.(
      sessionId,
      pendingRequest.cols,
      pendingRequest.rows,
      pendingRequest.generation,
    );

    if (resizeAccepted === false) {
      pendingResizeRequestRef.current = {
        ...pendingRequest,
        sent: false,
      };
      setIsResizePending(true);
      markResizeSyncBlocked('rejected-send', pendingRequest);
      scheduleResizeSyncFailureDeadline({
        sessionId,
        request: pendingRequest,
        timeoutMs: RESIZE_SYNC_FAILURE_TIMEOUT_MS,
        pendingResizeRequestRef,
        pendingResizeRetryTimerRef,
        resizeSyncRetryDelayIndexRef,
        resizeSyncFailureTimerRef,
        resizeSyncFailureRequestKeyRef,
        resizeSyncTimedOutRequestKeyRef,
        onResizeSyncError: onResizeSyncErrorRef.current,
        onTimedOut: () => {
          setIsResizePending(false);
          onTimedOut?.();
        },
        reason: 'rejected-send',
      });
      scheduleResizeSyncRetry({
        pendingResizeRequestRef,
        pendingResizeRetryTimerRef,
        resizeSyncRetryDelayIndexRef,
        freezeGeometryRef,
        canSyncResizeRef,
        dispatchPendingResize: (retryFromTimer = false) => {
          dispatchPendingResizeRef.current?.(retryFromTimer);
        },
      });
      return;
    }

    pendingResizeRequestRef.current = {
      ...pendingRequest,
      sent: true,
    };
    setIsResizePending(true);
    clearResizeSyncRetryState(
      pendingResizeRetryTimerRef,
      resizeSyncRetryDelayIndexRef,
    );
    scheduleResizeSyncFailureDeadline({
      sessionId,
      request: pendingRequest,
      timeoutMs: RESIZE_SYNC_FAILURE_TIMEOUT_MS,
      pendingResizeRequestRef,
      pendingResizeRetryTimerRef,
      resizeSyncRetryDelayIndexRef,
      resizeSyncFailureTimerRef,
      resizeSyncFailureRequestKeyRef,
      resizeSyncTimedOutRequestKeyRef,
      onResizeSyncError: onResizeSyncErrorRef.current,
      onTimedOut: () => {
        setIsResizePending(false);
        onTimedOut?.();
      },
    });
    clearResizeSyncBlocked('requested');
  });
  useEffect(() => {
    dispatchPendingResizeRef.current = (fromRetry = false) => {
      dispatchPendingResize(fromRetry);
    };

    return () => {
      dispatchPendingResizeRef.current = null;
    };
  });

  useEffect(() => {
    const container = containerRef.current;

    if (!container) {
      return;
    }
    hasAttemptedResizeSyncRef.current = false;
    resizeSyncBlockedReasonRef.current = null;
    resizeSyncBlockedRequestRef.current = null;
    pendingResizeRequestRef.current = null;
    resizeSyncTimedOutRequestKeyRef.current = null;
    setIsResizePending(false);
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
      freezeGeometry: freezeGeometryRef.current,
      scrollbackLength: scrollback.length,
      appliedCols: appliedColsRef.current,
      appliedRows: appliedRowsRef.current,
      appliedResizeGeneration: appliedResizeGenerationRef.current,
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
      const measuredGeometry = measureLiveTerminalGeometry({
        terminal,
        container,
        fallbackCellSize: cellSizeRef.current,
        fontSize: getTerminalFontSize(visualScaleRef.current),
      });
      if (measuredGeometry) {
        cellSizeRef.current = measuredGeometry.cellSize;
      }
      const desiredSize = measuredGeometry
        ? {
            cols: measuredGeometry.cols,
            rows: measuredGeometry.rows,
          }
        : null;
      const appliedSize = getTerminalSize(
        appliedColsRef.current,
        appliedRowsRef.current,
      );
      const existingPendingRequest = pendingResizeRequestRef.current;
      const pendingTargetsDesired = isResizeRequestForSize(
        existingPendingRequest,
        desiredSize,
      );
      const needsDesiredGeneration =
        desiredSize !== null &&
        (!areTerminalSizesEqual(desiredSize, appliedSize) ||
          Boolean(existingPendingRequest?.sent && !pendingTargetsDesired));
      let pendingRequest = existingPendingRequest;
      let shouldDispatchPendingResize = false;

      if (needsDesiredGeneration && desiredSize) {
        if (!pendingTargetsDesired) {
          pendingRequest = {
            cols: desiredSize.cols,
            rows: desiredSize.rows,
            generation: reserveNextTerminalResizeGeneration(
              sessionId,
              appliedResizeGenerationRef.current,
            ),
            sent: false,
          };
          pendingResizeRequestRef.current = pendingRequest;
          setIsResizePending(true);
          logStateDebug('terminalSurface', 'pendingResizeQueued', {
            sessionId,
            cols: pendingRequest.cols,
            rows: pendingRequest.rows,
            generation: pendingRequest.generation,
            appliedCols: appliedSize?.cols ?? null,
            appliedRows: appliedSize?.rows ?? null,
            appliedResizeGeneration: appliedResizeGenerationRef.current ?? null,
            freezeGeometry: freezeGeometryRef.current,
            readOnly: isReadOnly,
          });
        }
        shouldDispatchPendingResize = !pendingRequest?.sent;
      } else if (desiredSize !== null && existingPendingRequest && !existingPendingRequest.sent) {
        pendingResizeRequestRef.current = null;
        pendingRequest = null;
        setIsResizePending(false);
        logStateDebug('terminalSurface', 'pendingResizeCleared', {
          sessionId,
          reason: 'desired-matches-applied',
          cols: desiredSize.cols,
          rows: desiredSize.rows,
        });
        clearResizeSyncFailureDeadline(
          resizeSyncFailureTimerRef,
          resizeSyncFailureRequestKeyRef,
        );
        clearResizeSyncBlocked('cleared');
      }

      const displaySize =
        freezeGeometryRef.current && appliedSize ? appliedSize : desiredSize ?? appliedSize;
      if (!displaySize) {
        logStateDebug('terminalSurface', 'fitSkippedNoDisplaySize', {
          sessionId,
          readOnly: isReadOnly,
          freezeGeometry: freezeGeometryRef.current,
          containerWidth: container.clientWidth,
          containerHeight: container.clientHeight,
          desiredCols: desiredSize?.cols ?? null,
          desiredRows: desiredSize?.rows ?? null,
          appliedCols: appliedSize?.cols ?? null,
          appliedRows: appliedSize?.rows ?? null,
          appliedResizeGeneration: appliedResizeGenerationRef.current ?? null,
        });
        return;
      }

      const displaySizeKey = buildTerminalSizeKey(displaySize);
      const fitStateKey = buildFitStateKey({
        readOnly: isReadOnly,
        freezeGeometry: freezeGeometryRef.current,
        desiredSize,
        displaySize,
        appliedSize,
        pendingRequest,
      });
      if (fitStateKey === lastFitStateKeyRef.current) {
        return;
      }
      lastFitStateKeyRef.current = fitStateKey;
      logStateDebug('terminalSurface', 'fit', {
        sessionId,
        readOnly: isReadOnly,
        freezeGeometry: freezeGeometryRef.current,
        desiredCols: desiredSize?.cols ?? null,
        desiredRows: desiredSize?.rows ?? null,
        displayCols: displaySize.cols,
        displayRows: displaySize.rows,
        measuredWidth: measuredGeometry?.width ?? null,
        measuredHeight: measuredGeometry?.height ?? null,
        measuredSource: measuredGeometry?.source ?? null,
        appliedCols: appliedSize?.cols ?? null,
        appliedRows: appliedSize?.rows ?? null,
        appliedResizeGeneration: appliedResizeGenerationRef.current ?? null,
        pendingCols: pendingRequest?.cols ?? null,
        pendingRows: pendingRequest?.rows ?? null,
        pendingGeneration: pendingRequest?.generation ?? null,
        pendingSent: pendingRequest?.sent ?? null,
        containerWidth: container.clientWidth,
        containerHeight: container.clientHeight,
      });
      const shouldResizeTerminal =
        displaySizeKey !== lastRenderedTerminalSizeRef.current;
      const stickToBottom =
        terminalRef.current === terminal && shouldStickToBottomRef.current;
      const shouldRestoreFocus = shouldRestoreTerminalFocus(terminal, isReadOnly);
      terminal.write('', () => {
        if (shouldResizeTerminal) {
          terminal.resize(displaySize.cols, displaySize.rows);
          lastRenderedTerminalSizeRef.current = displaySizeKey;
          logStateDebug('terminalSurface', 'xtermResizedLocally', {
            sessionId,
            cols: displaySize.cols,
            rows: displaySize.rows,
            freezeGeometry: freezeGeometryRef.current,
            readOnly: isReadOnly,
            measuredSource: measuredGeometry?.source ?? null,
          });
        }
        if (shouldDispatchPendingResize) {
          dispatchPendingResizeRef.current?.();
        }
        if (isReadOnly) {
          syncReadOnlyViewport(terminal, stickToBottom);
          return;
        }
        restoreInteractiveFocusIfNeeded(terminal, shouldRestoreFocus);
      });
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
    window.requestAnimationFrame(() => {
      if (!disposed) {
        scheduleFit();
      }
    });

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
      clearResizeSyncRetryState(
        pendingResizeRetryTimerRef,
        resizeSyncRetryDelayIndexRef,
      );
      clearResizeSyncFailureDeadline(
        resizeSyncFailureTimerRef,
        resizeSyncFailureRequestKeyRef,
      );
      resizeSyncTimedOutRequestKeyRef.current = null;
      resizeSyncBlockedReasonRef.current = null;
      resizeSyncBlockedRequestRef.current = null;
      pendingResizeRequestRef.current = null;
      setIsResizePending(false);
      dataDisposable?.dispose();
      container.removeEventListener('wheel', handleUserScroll);
      rendererController.dispose();
      terminal.dispose();
      terminalRef.current = null;
      lastRenderedScrollbackRef.current = '';
      lastFitStateKeyRef.current = '';
      lastRenderedTerminalSizeRef.current = '';
      logStateDebug('terminalSurface', 'unmount', {
        sessionId,
        readOnly: readOnlyRef.current,
        freezeGeometry: freezeGeometryRef.current,
        isResizePending,
      });
    };
  }, [sessionId]);

  useEffect(() => {
    const pendingRequest = pendingResizeRequestRef.current;

    if (!pendingRequest || pendingRequest.sent) {
      return;
    }

    dispatchPendingResizeRef.current?.();
  }, [canSyncResize, freezeGeometry]);

  useEffect(() => {
    observeAppliedTerminalResizeGeneration(sessionId, appliedResizeGeneration);
    const pendingRequest = pendingResizeRequestRef.current;

    logStateDebug('terminalSurface', 'appliedResizeObserved', {
      sessionId,
      appliedCols,
      appliedRows,
      appliedResizeGeneration,
      pendingCols: pendingRequest?.cols ?? null,
      pendingRows: pendingRequest?.rows ?? null,
      pendingGeneration: pendingRequest?.generation ?? null,
    });

    if (
      pendingRequest &&
      appliedResizeGeneration != null &&
      appliedResizeGeneration >= pendingRequest.generation
    ) {
      pendingResizeRequestRef.current = null;
      setIsResizePending(false);
      clearResizeSyncRetryState(
        pendingResizeRetryTimerRef,
        resizeSyncRetryDelayIndexRef,
      );
      clearResizeSyncFailureDeadline(
        resizeSyncFailureTimerRef,
        resizeSyncFailureRequestKeyRef,
      );
      resizeSyncTimedOutRequestKeyRef.current = null;
      clearResizeSyncBlocked('applied');
    }

    lastFitStateKeyRef.current = '';
    scheduleFitRef.current?.();
  }, [appliedCols, appliedResizeGeneration, appliedRows, sessionId]);

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
    lastFitStateKeyRef.current = '';
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
    lastFitStateKeyRef.current = '';
    scheduleFitRef.current?.();
  }, [visualScale]);

  useEffect(() => {
    lastFitStateKeyRef.current = '';
    scheduleFitRef.current?.();
  }, [freezeGeometry]);

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
    surfaceClassName: buildSurfaceClassName(className, readOnly, isResizePending),
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


function clearResizeSyncRetryState(
  timerRef: MutableRefObject<number | null>,
  delayIndexRef: MutableRefObject<number>,
): void {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
  delayIndexRef.current = 0;
}

function scheduleResizeSyncRetry({
  pendingResizeRequestRef,
  pendingResizeRetryTimerRef,
  resizeSyncRetryDelayIndexRef,
  freezeGeometryRef,
  canSyncResizeRef,
  dispatchPendingResize,
}: {
  pendingResizeRequestRef: MutableRefObject<PendingResizeRequest | null>;
  pendingResizeRetryTimerRef: MutableRefObject<number | null>;
  resizeSyncRetryDelayIndexRef: MutableRefObject<number>;
  freezeGeometryRef: MutableRefObject<boolean>;
  canSyncResizeRef: MutableRefObject<boolean>;
  dispatchPendingResize: (fromRetry?: boolean) => void;
}): void {
  if (pendingResizeRetryTimerRef.current !== null) {
    return;
  }

  const delayIndex = resizeSyncRetryDelayIndexRef.current;
  const cappedDelayIndex = Math.min(
    delayIndex,
    RESIZE_SYNC_RETRY_DELAYS_MS.length - 1,
  );
  const delay = RESIZE_SYNC_RETRY_DELAYS_MS[cappedDelayIndex];
  pendingResizeRetryTimerRef.current = window.setTimeout(() => {
    pendingResizeRetryTimerRef.current = null;
    if (freezeGeometryRef.current || !canSyncResizeRef.current) {
      scheduleResizeSyncRetry({
        pendingResizeRequestRef,
        pendingResizeRetryTimerRef,
        resizeSyncRetryDelayIndexRef,
        freezeGeometryRef,
        canSyncResizeRef,
        dispatchPendingResize,
      });
      return;
    }

    const pendingResizeRequest = pendingResizeRequestRef.current;

    if (!pendingResizeRequest || pendingResizeRequest.sent) {
      return;
    }

    resizeSyncRetryDelayIndexRef.current = cappedDelayIndex + 1;
    dispatchPendingResize(true);
  }, delay);
}

function clearResizeSyncFailureDeadline(
  timerRef: MutableRefObject<number | null>,
  requestKeyRef: MutableRefObject<string | null>,
): void {
  if (timerRef.current !== null) {
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
  }
  requestKeyRef.current = null;
}

function scheduleResizeSyncFailureDeadline(options: {
  sessionId: string;
  request: PendingResizeRequest;
  timeoutMs: number;
  pendingResizeRequestRef: MutableRefObject<PendingResizeRequest | null>;
  pendingResizeRetryTimerRef: MutableRefObject<number | null>;
  resizeSyncRetryDelayIndexRef: MutableRefObject<number>;
  resizeSyncFailureTimerRef: MutableRefObject<number | null>;
  resizeSyncFailureRequestKeyRef: MutableRefObject<string | null>;
  resizeSyncTimedOutRequestKeyRef: MutableRefObject<string | null>;
  onResizeSyncError?: (details: {
    sessionId: string;
    cols: number;
    rows: number;
    timeoutMs: number;
  }) => void;
  onTimedOut?: () => void;
  reason?: ResizeSyncBlockedReason;
}): void {
  const {
    sessionId,
    request,
    timeoutMs,
    pendingResizeRequestRef,
    pendingResizeRetryTimerRef,
    resizeSyncRetryDelayIndexRef,
    resizeSyncFailureTimerRef,
    resizeSyncFailureRequestKeyRef,
    resizeSyncTimedOutRequestKeyRef,
    onResizeSyncError,
    onTimedOut,
    reason,
  } = options;
  const requestKey = getResizeRequestKey(request);

  if (resizeSyncTimedOutRequestKeyRef.current === requestKey) {
    return;
  }

  if (
    resizeSyncFailureTimerRef.current !== null &&
    resizeSyncFailureRequestKeyRef.current === requestKey
  ) {
    return;
  }

  clearResizeSyncFailureDeadline(
    resizeSyncFailureTimerRef,
    resizeSyncFailureRequestKeyRef,
  );
  logStateDebug('terminalSurface', 'resizeSyncDeadlineScheduled', {
    sessionId,
    cols: request.cols,
    rows: request.rows,
    generation: request.generation,
    timeoutMs,
    reason: reason ?? null,
  });
  resizeSyncFailureRequestKeyRef.current = requestKey;
  resizeSyncFailureTimerRef.current = window.setTimeout(() => {
    resizeSyncFailureTimerRef.current = null;
    resizeSyncFailureRequestKeyRef.current = null;
    resizeSyncTimedOutRequestKeyRef.current = requestKey;
    if (
      pendingResizeRequestRef.current &&
      getResizeRequestKey(pendingResizeRequestRef.current) === requestKey
    ) {
      pendingResizeRequestRef.current = null;
    }
    logStateDebug('terminalSurface', 'resizeSyncTimeout', {
      sessionId,
      cols: request.cols,
      rows: request.rows,
      generation: request.generation,
      timeoutMs,
      reason: reason ?? null,
    });
    clearResizeSyncRetryState(
      pendingResizeRetryTimerRef,
      resizeSyncRetryDelayIndexRef,
    );
    onTimedOut?.();
    onResizeSyncError?.({
      sessionId,
      cols: request.cols,
      rows: request.rows,
      timeoutMs,
    });
  }, timeoutMs);
}
function getTerminalSize(
  cols: number | null | undefined,
  rows: number | null | undefined,
): {
  cols: number;
  rows: number;
} | null {
  if (cols == null || rows == null) {
    return null;
  }

  return {
    cols,
    rows,
  };
}

function buildTerminalSizeKey(
  size: {
    cols: number;
    rows: number;
  } | null,
): string {
  return size ? `${size.cols}x${size.rows}` : 'none';
}

function buildFitStateKey(options: {
  readOnly: boolean;
  freezeGeometry: boolean;
  desiredSize: {
    cols: number;
    rows: number;
  } | null;
  displaySize: {
    cols: number;
    rows: number;
  };
  appliedSize: {
    cols: number;
    rows: number;
  } | null;
  pendingRequest: PendingResizeRequest | null;
}): string {
  const {
    readOnly,
    freezeGeometry,
    desiredSize,
    displaySize,
    appliedSize,
    pendingRequest,
  } = options;

  return [
    readOnly ? 'read-only' : 'interactive',
    freezeGeometry ? 'frozen' : 'live',
    `desired:${buildTerminalSizeKey(desiredSize)}`,
    `display:${buildTerminalSizeKey(displaySize)}`,
    `applied:${buildTerminalSizeKey(appliedSize)}`,
    pendingRequest
      ? `pending:${getResizeRequestKey(pendingRequest)}:${pendingRequest.sent ? 'sent' : 'queued'}`
      : 'pending:none',
  ].join('|');
}

function getResizeRequestKey(request: PendingResizeRequest): string {
  return `${request.generation}:${request.cols}x${request.rows}`;
}

function isResizeRequestForSize(
  request: PendingResizeRequest | null,
  size: {
    cols: number;
    rows: number;
  } | null,
): boolean {
  return Boolean(
    request &&
      size &&
      request.cols === size.cols &&
      request.rows === size.rows,
  );
}

function areResizeRequestsEqual(
  left: PendingResizeRequest | null,
  right: PendingResizeRequest | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }

  return (
    left.cols === right.cols &&
    left.rows === right.rows &&
    left.generation === right.generation &&
    left.sent === right.sent
  );
}

function areTerminalSizesEqual(
  left: {
    cols: number;
    rows: number;
  } | null,
  right: {
    cols: number;
    rows: number;
  } | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }

  return left.cols === right.cols && left.rows === right.rows;
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
  isResizePending: boolean,
): string {
  const classes = ['terminal-surface', 'nodrag', 'nopan', 'nowheel'];

  if (className) {
    classes.push(className);
  }

  if (readOnly) {
    classes.push('is-read-only');
  }

  if (isResizePending) {
    classes.push('is-resize-pending');
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
