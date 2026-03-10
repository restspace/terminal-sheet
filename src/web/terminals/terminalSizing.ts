const TERMINAL_FONT_FAMILY = '"IBM Plex Mono", "Cascadia Code", monospace';
const TERMINAL_FONT_SIZE = 10.5;
const TERMINAL_LINE_HEIGHT = 1.1;
const DEFAULT_CELL_WIDTH = 6.4;
const DEFAULT_CELL_HEIGHT = TERMINAL_FONT_SIZE * TERMINAL_LINE_HEIGHT;
const PROBE_TEXT = 'WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW';

export interface TerminalCellSize {
  width: number;
  height: number;
}

export const DEFAULT_TERMINAL_CELL_SIZE: TerminalCellSize = {
  width: DEFAULT_CELL_WIDTH,
  height: DEFAULT_CELL_HEIGHT,
};

export function measureCellSize(
  container: HTMLDivElement,
  fallback: TerminalCellSize = DEFAULT_TERMINAL_CELL_SIZE,
): TerminalCellSize {
  const probe = document.createElement('span');
  probe.textContent = PROBE_TEXT;
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.pointerEvents = 'none';
  probe.style.whiteSpace = 'pre';
  probe.style.fontFamily = TERMINAL_FONT_FAMILY;
  probe.style.fontSize = `${TERMINAL_FONT_SIZE}px`;
  probe.style.lineHeight = 'normal';

  container.appendChild(probe);

  const probeRect = probe.getBoundingClientRect();
  const width = probeRect.width / PROBE_TEXT.length;
  const height = probeRect.height * TERMINAL_LINE_HEIGHT;

  probe.remove();

  return {
    width: Number.isFinite(width) && width > 0 ? width : fallback.width,
    height: Number.isFinite(height) && height > 0 ? height : fallback.height,
  };
}
