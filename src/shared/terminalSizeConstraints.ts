export const MIN_TERMINAL_COLS = 20;
export const MAX_TERMINAL_COLS = 240;
export const MIN_TERMINAL_ROWS = 8;
export const MAX_TERMINAL_ROWS = 120;

export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;

/** Matches web `terminalSizing` defaults for server-side PTY size estimation from node bounds. */
export const DEFAULT_TERMINAL_CELL_WIDTH = 6.4;
export const DEFAULT_TERMINAL_CELL_HEIGHT = 10.5 * 1.1;

/**
 * Deduction from terminal node width/height for window chrome and padding before
 * estimating cell counts (logical pixels).
 */
export const TERMINAL_NODE_BOUNDS_PADDING_X = 24;
export const TERMINAL_NODE_BOUNDS_PADDING_Y = 48;

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface NodeBoundsSize {
  width: number;
  height: number;
}

export function estimateTerminalDimensionsFromNodeBounds(
  bounds: NodeBoundsSize,
  cellWidth: number = DEFAULT_TERMINAL_CELL_WIDTH,
  cellHeight: number = DEFAULT_TERMINAL_CELL_HEIGHT,
): TerminalDimensions {
  const innerWidth = Math.max(0, bounds.width - TERMINAL_NODE_BOUNDS_PADDING_X);
  const innerHeight = Math.max(0, bounds.height - TERMINAL_NODE_BOUNDS_PADDING_Y);

  if (innerWidth < cellWidth || innerHeight < cellHeight) {
    return {
      cols: MIN_TERMINAL_COLS,
      rows: MIN_TERMINAL_ROWS,
    };
  }

  const rawCols = Math.floor(innerWidth / cellWidth);
  const rawRows = Math.floor(innerHeight / cellHeight);

  return clampTerminalDimensions(rawCols, rawRows);
}

export function clampTerminalDimensions(
  cols: number,
  rows: number,
): TerminalDimensions {
  return {
    cols: clamp(cols, MIN_TERMINAL_COLS, MAX_TERMINAL_COLS),
    rows: clamp(rows, MIN_TERMINAL_ROWS, MAX_TERMINAL_ROWS),
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
