import { Terminal } from '@xterm/xterm';

import {
  MAX_TERMINAL_COLS,
  MAX_TERMINAL_ROWS,
  MIN_TERMINAL_COLS,
  MIN_TERMINAL_ROWS,
} from '../../shared/terminalSizeConstraints';
import {
  DEFAULT_TERMINAL_CELL_SIZE,
  measureCellSize,
  type TerminalCellSize,
} from './terminalSizing';

export interface MeasuredTerminalGeometry {
  cols: number;
  rows: number;
  width: number;
  height: number;
  source: 'screen' | 'container';
  cellSize: TerminalCellSize;
}

const MAX_SCREEN_GEOMETRY_DELTA_COLS = 8;
const MAX_SCREEN_GEOMETRY_DELTA_ROWS = 4;

export function measureLiveTerminalGeometry(options: {
  terminal: Terminal;
  container: HTMLDivElement;
  fallbackCellSize?: TerminalCellSize;
  fontSize: number;
}): MeasuredTerminalGeometry | null {
  const { terminal, container, fallbackCellSize, fontSize } = options;
  const cellSize = getTerminalCellSize(
    terminal,
    container,
    fallbackCellSize ?? DEFAULT_TERMINAL_CELL_SIZE,
    fontSize,
  );
  const containerSize = {
    width: Math.max(container.clientWidth, 0),
    height: Math.max(container.clientHeight, 0),
  };
  const measuredScreenSize = getMeasuredTerminalScreenSize(terminal);
  const useScreenSize = shouldUseMeasuredTerminalScreenSize(
    measuredScreenSize,
    containerSize,
    cellSize,
  );
  const source = useScreenSize ? 'screen' : 'container';
  const width = useScreenSize
    ? measuredScreenSize!.width
    : containerSize.width;
  const height = useScreenSize
    ? measuredScreenSize!.height
    : containerSize.height;

  if (width < cellSize.width || height < cellSize.height) {
    return null;
  }

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
    width,
    height,
    source,
    cellSize,
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

type XtermRendererDimensionsCss = {
  cell?: {
    width?: number;
    height?: number;
  };
};

function readXtermRendererDimensionsCss(
  terminal: Terminal,
): XtermRendererDimensionsCss | undefined {
  const core = (terminal as Terminal & {
    _core?: {
      _renderService?: {
        dimensions?: {
          css?: XtermRendererDimensionsCss;
        };
      };
    };
  })._core;

  return core?._renderService?.dimensions?.css;
}

function getMeasuredRendererCellSize(
  terminal: Terminal,
): TerminalCellSize | null {
  const cell = readXtermRendererDimensionsCss(terminal)?.cell;
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

function getMeasuredTerminalScreenSize(
  terminal: Terminal,
): {
  width: number;
  height: number;
} | null {
  const terminalElement = terminal.element;

  if (!(terminalElement instanceof HTMLElement)) {
    return null;
  }

  const screenElement = terminalElement.querySelector('.xterm-screen');

  if (!(screenElement instanceof HTMLElement)) {
    return null;
  }

  const width = Math.max(screenElement.clientWidth, 0);
  const height = Math.max(screenElement.clientHeight, 0);

  if (!Number.isFinite(width) || width <= 0) {
    return null;
  }

  if (!Number.isFinite(height) || height <= 0) {
    return null;
  }

  return { width, height };
}

function shouldUseMeasuredTerminalScreenSize(
  measuredScreenSize: {
    width: number;
    height: number;
  } | null,
  containerSize: {
    width: number;
    height: number;
  },
  cellSize: TerminalCellSize,
): boolean {
  if (!measuredScreenSize) {
    return false;
  }

  const containerCols = Math.floor(containerSize.width / cellSize.width);
  const containerRows = Math.floor(containerSize.height / cellSize.height);
  const screenCols = Math.floor(measuredScreenSize.width / cellSize.width);
  const screenRows = Math.floor(measuredScreenSize.height / cellSize.height);

  return (
    Math.abs(containerCols - screenCols) <= MAX_SCREEN_GEOMETRY_DELTA_COLS &&
    Math.abs(containerRows - screenRows) <= MAX_SCREEN_GEOMETRY_DELTA_ROWS
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
