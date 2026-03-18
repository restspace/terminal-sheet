import { useEffect, useEffectEvent, useRef, type CSSProperties } from 'react';

import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import type { CameraViewport, TerminalNode } from '../../shared/workspace';
import type { BackendAccent } from '../canvas/backendAccents';
import {
  getTerminalDisplayStatus,
  getTerminalRuntimePath,
} from './presentation';
import { TerminalFocusSurface } from './TerminalFocusSurface';
import { TerminalTitleBar } from './TerminalTitleBar';

interface FocusedTerminalOverlayProps {
  terminal: TerminalNode;
  backendAccent: BackendAccent | null;
  session: TerminalSessionSnapshot | null;
  viewport: CameraViewport;
  autoFocusAtMs: number | null;
  visualVariant?: 'normal' | 'swap-in' | 'swap-out';
  interactive?: boolean;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onBoundsChange: (
    nodeId: string,
    bounds: Partial<TerminalNode['bounds']>,
  ) => void;
  onTerminalChange: (
    nodeId: string,
    patch: Partial<Pick<TerminalNode, 'label' | 'cwd'>>,
  ) => void;
  onPathSelectRequest: (terminalId: string) => void;
  onRemove: (terminalId: string) => void;
  onRestart: (sessionId: string) => void;
}

export function FocusedTerminalOverlay({
  terminal,
  backendAccent,
  session,
  viewport,
  autoFocusAtMs,
  visualVariant = 'normal',
  interactive = true,
  onInput,
  onResize,
  onBoundsChange,
  onTerminalChange,
  onPathSelectRequest,
  onRemove,
  onRestart,
}: FocusedTerminalOverlayProps) {
  const overlayStyle = createOverlayStyle(terminal, viewport);
  const status = getTerminalDisplayStatus(terminal, session);
  const liveCwd = getTerminalRuntimePath(terminal, session, 'cwd');
  const dragStateRef = useRef<{
    originX: number;
    originY: number;
    startX: number;
    startY: number;
    zoom: number;
  } | null>(null);
  const moveOverlay = useEffectEvent((event: PointerEvent) => {
    const dragState = dragStateRef.current;

    if (!dragState) {
      return;
    }

    const deltaX = (event.clientX - dragState.startX) / dragState.zoom;
    const deltaY = (event.clientY - dragState.startY) / dragState.zoom;

    onBoundsChange(terminal.id, {
      x: dragState.originX + deltaX,
      y: dragState.originY + deltaY,
    });
  });
  const stopDragging = useEffectEvent(() => {
    if (!dragStateRef.current) {
      return;
    }

    dragStateRef.current = null;
    document.body.classList.remove('is-dragging-terminal-overlay');
  });

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      moveOverlay(event);
    }

    function handlePointerUp() {
      stopDragging();
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);
    window.addEventListener('pointercancel', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
    };
  }, []);

  return (
    <div
      className={buildOverlayClassName(visualVariant, interactive)}
      style={overlayStyle}
    >
      <span
        className={`focus-terminal-overlay-stripe terminal-node-stripe is-${status}`}
        aria-hidden="true"
      />

      <div
        className="focus-terminal-overlay-toolbar"
        onPointerDown={(event) => {
          if (!interactive) {
            return;
          }

          if (event.button !== 0) {
            return;
          }

          dragStateRef.current = {
            originX: terminal.bounds.x,
            originY: terminal.bounds.y,
            startX: event.clientX,
            startY: event.clientY,
            zoom: viewport.zoom,
          };
          document.body.classList.add('is-dragging-terminal-overlay');
          event.preventDefault();
          event.stopPropagation();
        }}
      >
        <TerminalTitleBar
          className="terminal-window-header"
          terminal={terminal}
          status={status}
          currentPath={liveCwd}
          backendAccent={backendAccent}
          onPathSelectRequest={onPathSelectRequest}
          onTerminalChange={onTerminalChange}
          onClose={onRemove}
          sidecar={
            interactive && !session?.connected ? (
              <button
                className="nodrag nopan"
                type="button"
                onPointerDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={() => {
                  onRestart(terminal.id);
                }}
              >
                Restart
              </button>
            ) : null
          }
        />
      </div>

      <div className="focus-terminal-overlay-body">
        {session ? (
          <div className="canvas-node-summary terminal-live-preview-card focus-terminal-overlay-summary">
            <TerminalFocusSurface
              autoFocusAtMs={interactive ? autoFocusAtMs : null}
              sessionId={terminal.id}
              scrollback={session.scrollback}
              visualScale={viewport.zoom}
              onInput={onInput}
              onResize={onResize}
            />
          </div>
        ) : (
          <div className="canvas-node-summary focus-terminal-overlay-summary focus-terminal-overlay-empty">
            <strong>Launching terminal session.</strong>
            <span>
              The live terminal will attach here as soon as the backend publishes
              the first session snapshot.
            </span>
          </div>
        )}
      </div>
    </div>
  );
}

const OVERLAY_TOOLBAR_HEIGHT = 42;
const OVERLAY_INSET = {
  left: 0,
  right: 0,
  top: OVERLAY_TOOLBAR_HEIGHT,
  bottom: 0,
};

function createOverlayStyle(
  terminal: TerminalNode,
  viewport: CameraViewport,
): CSSProperties {
  const zoom = viewport.zoom;
  const width = Math.max(
    (terminal.bounds.width - OVERLAY_INSET.left - OVERLAY_INSET.right) * zoom,
    220,
  );
  const height = Math.max(
    (terminal.bounds.height -
      OVERLAY_INSET.top -
      OVERLAY_INSET.bottom +
      OVERLAY_TOOLBAR_HEIGHT) *
      zoom,
    140,
  );

  return {
    left: `${(terminal.bounds.x + OVERLAY_INSET.left) * zoom + viewport.x}px`,
    top: `${
      (terminal.bounds.y + OVERLAY_INSET.top - OVERLAY_TOOLBAR_HEIGHT) * zoom +
      viewport.y
    }px`,
    width: `${width}px`,
    height: `${height}px`,
  };
}

function buildOverlayClassName(
  visualVariant: 'normal' | 'swap-in' | 'swap-out',
  interactive: boolean,
): string {
  const classes = ['focus-terminal-overlay', 'nodrag', 'nopan', 'nowheel'];

  if (visualVariant === 'swap-in') {
    classes.push('is-swap-in');
  } else if (visualVariant === 'swap-out') {
    classes.push('is-swap-out');
  }

  if (!interactive) {
    classes.push('is-non-interactive');
  }

  return classes.join(' ');
}
