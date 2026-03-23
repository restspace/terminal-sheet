import { useXtermSurfaceController, type TerminalSurfaceProps } from './useXtermSurfaceController';

export function TerminalSurface(props: TerminalSurfaceProps) {
  const controller = useXtermSurfaceController(props);
  const menuX = controller.selectionContextMenu
    ? Math.max(6, controller.selectionContextMenu.x)
    : 0;
  const menuY = controller.selectionContextMenu
    ? Math.max(6, controller.selectionContextMenu.y)
    : 0;

  return (
    <div
      ref={controller.containerRef}
      className={controller.surfaceClassName}
      aria-hidden={controller.isReadOnly}
      onPointerDown={controller.onPointerDown}
      onClick={controller.onClick}
      onContextMenu={controller.onContextMenu}
      onWheel={controller.onWheel}
    >
      {controller.selectionContextMenu ? (
        <div
          className="terminal-selection-context-menu nodrag nopan nowheel"
          role="menu"
          style={{ left: `${menuX}px`, top: `${menuY}px` }}
          onPointerDown={(event) => {
            event.stopPropagation();
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="terminal-selection-context-menu-item"
            onClick={() => {
              void controller.onCopySelection();
            }}
          >
            Copy
          </button>
          <button
            type="button"
            role="menuitem"
            className="terminal-selection-context-menu-item"
            onClick={() => {
              void controller.onCutSelection();
            }}
          >
            Cut
          </button>
          <button
            type="button"
            role="menuitem"
            className="terminal-selection-context-menu-item is-dismiss"
            onClick={controller.onDismissSelectionContextMenu}
          >
            Dismiss
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function TerminalFocusSurface(props: {
  className?: string;
  autoFocusAtMs?: number | null;
  sessionId: string;
  scrollback: string;
  visualScale?: number;
  snapshotCols?: number;
  scrollResetKey?: string | number | boolean;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
}) {
  return (
    <TerminalSurface
      {...props}
      className={`terminal-focus-surface ${props.className ?? ''}`.trim()}
      interactionMode="interactive"
      sizeSource="measured"
      resizeAuthority="owner"
    />
  );
}

export function ReadOnlyTerminalSurface(props: {
  sessionId: string;
  scrollback: string;
  className?: string;
  snapshotCols?: number;
  snapshotRows?: number;
  scrollResetKey?: string | number | boolean;
}) {
  return (
    <TerminalSurface
      {...props}
      interactionMode="read-only"
      sizeSource="snapshot"
      resizeAuthority="none"
    />
  );
}
