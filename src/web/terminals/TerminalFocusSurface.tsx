import { useXtermSurfaceController, type TerminalSurfaceProps } from './useXtermSurfaceController';

export function TerminalSurface(props: TerminalSurfaceProps) {
  const controller = useXtermSurfaceController(props);

  return (
    <div
      ref={controller.containerRef}
      className={controller.surfaceClassName}
      aria-hidden={controller.isReadOnly}
      onPointerDown={controller.onPointerDown}
      onClick={controller.onClick}
      onWheel={controller.onWheel}
    />
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
