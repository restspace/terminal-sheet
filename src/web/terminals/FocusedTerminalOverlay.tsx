import { useEffect, useEffectEvent, useRef, type CSSProperties } from 'react';

import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import type { CameraViewport, TerminalNode } from '../../shared/workspace';
import { getTerminalDisplayStatus } from './presentation';
import { TerminalFocusSurface } from './TerminalFocusSurface';
import { TerminalTitleBar } from './TerminalTitleBar';

interface FocusedTerminalOverlayProps {
  terminal: TerminalNode;
  session: TerminalSessionSnapshot | null;
  viewport: CameraViewport;
  autoFocusAtMs: number | null;
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
  onRestart: (sessionId: string) => void;
}

export function FocusedTerminalOverlay({
  terminal,
  session,
  viewport,
  autoFocusAtMs,
  onInput,
  onResize,
  onBoundsChange,
  onTerminalChange,
  onRestart,
}: FocusedTerminalOverlayProps) {
  const overlayStyle = createOverlayStyle(terminal, viewport);
  const status = getTerminalDisplayStatus(terminal, session);
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
      className="focus-terminal-overlay nodrag nopan nowheel"
      style={overlayStyle}
    >
      <div
        className="focus-terminal-overlay-toolbar"
        onPointerDown={(event) => {
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
          onTerminalChange={onTerminalChange}
          sidecar={
            !session?.connected ? (
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

      {session ? (
        <TerminalFocusSurface
          autoFocusAtMs={autoFocusAtMs}
          sessionId={terminal.id}
          scrollback={session.scrollback}
          onInput={onInput}
          onResize={onResize}
        />
      ) : (
        <div className="focus-terminal-overlay-empty">
          <strong>Waiting for PTY session snapshot.</strong>
          <span>
            The live terminal will attach here as soon as session data arrives.
          </span>
        </div>
      )}
    </div>
  );
}

const OVERLAY_INSET = {
  left: 18,
  right: 18,
  top: 54,
  bottom: 18,
};
const OVERLAY_TOOLBAR_HEIGHT = 42;

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
