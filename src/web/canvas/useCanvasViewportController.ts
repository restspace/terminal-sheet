import { useCallback, useEffect, useRef, useState } from 'react';

import type { CameraViewport } from '../../shared/workspace';
import { logStateDebug } from '../debug/stateDebug';

interface UseCanvasViewportControllerOptions {
  workspaceViewport: CameraViewport;
  onViewportCommit: (viewport: CameraViewport) => void;
}

interface CanvasViewportController {
  activeViewport: CameraViewport;
  isViewportInteracting: boolean;
  onMoveStart: (event: MouseEvent | TouchEvent | null) => void;
  onMoveEnd: (
    event: MouseEvent | TouchEvent | null,
    maybeViewport: unknown,
  ) => void;
  onReactFlowViewportChange: (nextViewport: CameraViewport) => void;
}

export function useCanvasViewportController({
  workspaceViewport,
  onViewportCommit,
}: UseCanvasViewportControllerOptions): CanvasViewportController {
  const pendingViewportCommitRef = useRef<CameraViewport | null>(null);
  const [lastCommittedViewport, setLastCommittedViewport] =
    useState<CameraViewport>(workspaceViewport);
  const [isAwaitingViewportCommit, setIsAwaitingViewportCommit] =
    useState(false);
  const [canvasViewport, setCanvasViewport] = useState<CameraViewport>(
    workspaceViewport,
  );
  const previousObservedWorkspaceViewportRef =
    useRef<CameraViewport>(workspaceViewport);
  const [isViewportInteracting, setIsViewportInteracting] = useState(false);
  const hasPendingViewportCommit =
    isAwaitingViewportCommit &&
    !sameViewport(workspaceViewport, lastCommittedViewport);
  const shouldUseCanvasViewport =
    isViewportInteracting || hasPendingViewportCommit;
  const activeViewport = shouldUseCanvasViewport
    ? canvasViewport
    : workspaceViewport;

  useEffect(() => {
    if (
      !isAwaitingViewportCommit ||
      !sameViewport(workspaceViewport, lastCommittedViewport)
    ) {
      return;
    }

    setIsAwaitingViewportCommit(false);
  }, [isAwaitingViewportCommit, lastCommittedViewport, workspaceViewport]);

  useEffect(() => {
    if (
      sameViewport(
        previousObservedWorkspaceViewportRef.current,
        workspaceViewport,
      )
    ) {
      return;
    }

    logStateDebug('canvas', 'workspaceViewportObserved', {
      previousViewport: previousObservedWorkspaceViewportRef.current,
      nextViewport: workspaceViewport,
      canvasViewport,
      lastCommittedViewport,
      isViewportInteracting,
      hasPendingViewportCommit,
    });
    previousObservedWorkspaceViewportRef.current = workspaceViewport;
  }, [
    canvasViewport,
    hasPendingViewportCommit,
    isViewportInteracting,
    lastCommittedViewport,
    workspaceViewport,
  ]);

  const onReactFlowViewportChange = useCallback(
    (nextViewport: CameraViewport) => {
      logStateDebug('canvas', 'reactFlowViewportChange', {
        nextViewport,
        activeViewport,
        workspaceViewport,
        canvasViewport,
        lastCommittedViewport,
        isViewportInteracting,
        hasPendingViewportCommit,
      });

      if (!isViewportInteracting && !hasPendingViewportCommit) {
        logStateDebug('canvas', 'reactFlowViewportChangeIgnored', {
          nextViewport,
          reason: 'not-interacting-and-no-pending-commit',
        });
        return;
      }

      setCanvasViewport((current) =>
        sameViewport(current, nextViewport) ? current : nextViewport,
      );
      pendingViewportCommitRef.current = nextViewport;
    },
    [
      activeViewport,
      canvasViewport,
      hasPendingViewportCommit,
      isViewportInteracting,
      lastCommittedViewport,
      workspaceViewport,
    ],
  );

  const onMoveStart = useCallback(
    (event: MouseEvent | TouchEvent | null) => {
      logStateDebug('canvas', 'reactFlowMoveStart', {
        event: summarizeMoveEvent(event),
        workspaceViewport,
        canvasViewport,
        lastCommittedViewport,
        activeViewport,
      });

      if (!isUserViewportEvent(event)) {
        logStateDebug('canvas', 'reactFlowMoveStartIgnored', {
          reason: 'non-user-event',
          event: summarizeMoveEvent(event),
        });
        return;
      }

      pendingViewportCommitRef.current = null;
      setCanvasViewport((current) =>
        sameViewport(current, workspaceViewport) ? current : workspaceViewport,
      );
      setLastCommittedViewport(workspaceViewport);
      setIsAwaitingViewportCommit(false);
      setIsViewportInteracting(true);
    },
    [activeViewport, canvasViewport, lastCommittedViewport, workspaceViewport],
  );

  const onMoveEnd = useCallback(
    (event: MouseEvent | TouchEvent | null, maybeViewport: unknown) => {
      logStateDebug('canvas', 'reactFlowMoveEnd', {
        event: summarizeMoveEvent(event),
        maybeViewport: isCameraViewport(maybeViewport) ? maybeViewport : null,
        pendingViewport: pendingViewportCommitRef.current,
        canvasViewport,
        lastCommittedViewport,
        workspaceViewport,
      });

      if (!isUserViewportEvent(event)) {
        logStateDebug('canvas', 'reactFlowMoveEndIgnored', {
          reason: 'non-user-event',
          event: summarizeMoveEvent(event),
        });
        return;
      }

      setIsViewportInteracting(false);

      const finalViewport = isCameraViewport(maybeViewport)
        ? maybeViewport
        : (pendingViewportCommitRef.current ?? canvasViewport);
      pendingViewportCommitRef.current = null;

      if (!finalViewport) {
        return;
      }

      setCanvasViewport((current) =>
        sameViewport(current, finalViewport) ? current : finalViewport,
      );
      if (!sameViewport(lastCommittedViewport, finalViewport)) {
        logStateDebug('canvas', 'reactFlowViewportCommit', {
          previousViewport: lastCommittedViewport,
          nextViewport: finalViewport,
        });
        setIsAwaitingViewportCommit(true);
        setLastCommittedViewport(finalViewport);
        onViewportCommit(finalViewport);
      } else {
        logStateDebug('canvas', 'reactFlowViewportCommitSkipped', {
          reason: 'same-as-last-committed',
          viewport: finalViewport,
        });
      }
    },
    [
      canvasViewport,
      lastCommittedViewport,
      onViewportCommit,
      workspaceViewport,
    ],
  );

  return {
    activeViewport,
    isViewportInteracting,
    onMoveStart,
    onMoveEnd,
    onReactFlowViewportChange,
  };
}

function isCameraViewport(value: unknown): value is CameraViewport {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<CameraViewport>;
  return (
    typeof candidate.x === 'number' &&
    typeof candidate.y === 'number' &&
    typeof candidate.zoom === 'number'
  );
}

function summarizeMoveEvent(event: unknown): Record<string, unknown> | null {
  if (!event) {
    return null;
  }

  if (typeof MouseEvent !== 'undefined' && event instanceof MouseEvent) {
    return {
      kind: 'mouse',
      type: event.type,
      button: event.button,
      buttons: event.buttons,
      clientX: roundForEventDebug(event.clientX),
      clientY: roundForEventDebug(event.clientY),
    };
  }

  if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) {
    const firstTouch = event.touches[0] ?? event.changedTouches[0] ?? null;

    return {
      kind: 'touch',
      type: event.type,
      touches: event.touches.length,
      changedTouches: event.changedTouches.length,
      clientX: firstTouch ? roundForEventDebug(firstTouch.clientX) : null,
      clientY: firstTouch ? roundForEventDebug(firstTouch.clientY) : null,
    };
  }

  return {
    kind: 'unknown',
    type:
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      typeof event.type === 'string'
        ? event.type
        : null,
    constructorName:
      typeof event === 'object' &&
      event !== null &&
      'constructor' in event &&
      typeof event.constructor === 'function' &&
      'name' in event.constructor &&
      typeof event.constructor.name === 'string'
        ? event.constructor.name
        : null,
  };
}

function sameViewport(left: CameraViewport, right: CameraViewport): boolean {
  return (
    almostEqual(left.x, right.x) &&
    almostEqual(left.y, right.y) &&
    almostEqual(left.zoom, right.zoom)
  );
}

function roundForEventDebug(value: number): number {
  return Number(value.toFixed(3));
}

function almostEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}

function isUserViewportEvent(
  event: unknown,
): event is MouseEvent | TouchEvent {
  if (!event) {
    return false;
  }

  if (typeof MouseEvent !== 'undefined' && event instanceof MouseEvent) {
    return true;
  }

  if (typeof TouchEvent !== 'undefined' && event instanceof TouchEvent) {
    return true;
  }

  return false;
}
