export const MIN_TERMINAL_COLS = 20;
export const MAX_TERMINAL_COLS = 240;
export const MIN_TERMINAL_ROWS = 8;
export const MAX_TERMINAL_ROWS = 120;

export const DEFAULT_TERMINAL_COLS = 80;
export const DEFAULT_TERMINAL_ROWS = 24;

export interface TerminalDimensions {
  cols: number;
  rows: number;
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
