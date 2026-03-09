import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import { appendScrollback } from '../../shared/scrollback';
import type { TerminalNode, TerminalStatus } from '../../shared/workspace';
import { extractPreviewLines, renderTerminalText } from './outputPreview';

const DEFAULT_COLS = 100;
const DEFAULT_ROWS = 30;

export function createInitialSnapshot(
  sessionId: string,
): TerminalSessionSnapshot {
  return {
    sessionId,
    pid: null,
    status: 'idle',
    connected: false,
    recoveryState: 'restartable',
    startedAt: null,
    lastActivityAt: null,
    lastOutputAt: null,
    lastOutputLine: null,
    previewLines: [],
    scrollback: '',
    unreadCount: 0,
    summary: 'Session not started yet.',
    exitCode: null,
    disconnectReason: null,
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
  };
}

export function createRunningSnapshot(options: {
  snapshot: TerminalSessionSnapshot;
  terminal: TerminalNode;
  pid: number;
  startedAt: string;
}): TerminalSessionSnapshot {
  const { snapshot, terminal, pid, startedAt } = options;

  return {
    ...snapshot,
    pid,
    status: 'running',
    connected: true,
    recoveryState: 'live',
    startedAt,
    lastActivityAt: startedAt,
    lastOutputAt: null,
    lastOutputLine: null,
    previewLines: [],
    scrollback: '',
    unreadCount: 0,
    summary: `${terminal.shell} started in ${terminal.cwd}`,
    exitCode: null,
    disconnectReason: null,
  };
}

export function createSpawnFailedSnapshot(options: {
  snapshot: TerminalSessionSnapshot;
  startedAt: string;
  message: string;
}): TerminalSessionSnapshot {
  const { snapshot, startedAt, message } = options;

  return {
    ...snapshot,
    pid: null,
    status: 'disconnected',
    connected: false,
    recoveryState: 'spawn-failed',
    startedAt,
    summary: `Launch failed: ${message}`,
    exitCode: null,
    disconnectReason: message,
  };
}

export function createInputSnapshot(
  snapshot: TerminalSessionSnapshot,
  timestamp: string,
): TerminalSessionSnapshot {
  return {
    ...snapshot,
    status: 'running',
    lastActivityAt: timestamp,
  };
}

export function createResizeSnapshot(
  snapshot: TerminalSessionSnapshot,
  cols: number,
  rows: number,
): TerminalSessionSnapshot {
  return {
    ...snapshot,
    cols,
    rows,
  };
}

export function createReadSnapshot(
  snapshot: TerminalSessionSnapshot,
): TerminalSessionSnapshot {
  return {
    ...snapshot,
    unreadCount: 0,
  };
}

export function createOutputSnapshot(options: {
  snapshot: TerminalSessionSnapshot;
  terminal: TerminalNode;
  chunk: string;
  timestamp: string;
}): TerminalSessionSnapshot {
  const { snapshot, terminal, chunk, timestamp } = options;
  const nextScrollback = appendScrollback(snapshot.scrollback, chunk);
  const readableOutput = renderTerminalText(nextScrollback);
  const previewLines = extractPreviewLines(readableOutput);
  const lastOutputLine = previewLines.at(-1) ?? snapshot.lastOutputLine;
  const unreadDelta = chunk.trim().length > 0 ? 1 : 0;

  return {
    ...snapshot,
    status: 'active-output',
    connected: true,
    recoveryState: 'live',
    lastActivityAt: timestamp,
    lastOutputAt: timestamp,
    lastOutputLine,
    previewLines,
    scrollback: nextScrollback,
    unreadCount: snapshot.unreadCount + unreadDelta,
    summary: lastOutputLine ?? `Running ${terminal.shell} in ${terminal.cwd}`,
  };
}

export function createExitSnapshot(options: {
  snapshot: TerminalSessionSnapshot;
  exitCode: number;
  signal?: number;
  timestamp: string;
}): TerminalSessionSnapshot {
  const { snapshot, exitCode, signal, timestamp } = options;
  const disconnectReason =
    signal === undefined
      ? `Exited with code ${exitCode}`
      : `Exited with code ${exitCode} (signal ${signal})`;
  const status: TerminalStatus = exitCode === 0 ? 'completed' : 'failed';

  return {
    ...snapshot,
    pid: null,
    connected: false,
    recoveryState: 'restartable',
    status,
    exitCode,
    disconnectReason,
    summary: disconnectReason,
    lastActivityAt: timestamp,
  };
}
