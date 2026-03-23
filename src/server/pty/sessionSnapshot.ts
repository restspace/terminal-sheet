import type {
  TerminalCommandState,
  TerminalIntegrationState,
  TerminalSessionSnapshot,
} from '../../shared/terminalSessions';
import {
  DEFAULT_TERMINAL_COLS,
  DEFAULT_TERMINAL_ROWS,
} from '../../shared/terminalSizeConstraints';
import type { AgentType } from '../../shared/workspace';
import type { AttentionEvent } from '../../shared/events';
import { appendScrollback } from '../../shared/scrollback';
import type { TerminalNode, TerminalStatus } from '../../shared/workspace';
import { extractPreviewLines, renderTerminalText } from './outputPreview';

export function createInitialSnapshot(
  sessionId: string,
  backendId: string,
  agentType: AgentType,
  liveCwd: string | null = null,
): TerminalSessionSnapshot {
  return {
    sessionId,
    backendId,
    pid: null,
    status: 'idle',
    commandState: 'idle-at-prompt',
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
    cols: DEFAULT_TERMINAL_COLS,
    rows: DEFAULT_TERMINAL_ROWS,
    liveCwd,
    projectRoot: null,
    integration: createInitialIntegrationState(agentType),
  };
}

export function createRunningSnapshot(options: {
  snapshot: TerminalSessionSnapshot;
  terminal: TerminalNode;
  pid: number;
  startedAt: string;
  summary?: string;
}): TerminalSessionSnapshot {
  const { snapshot, terminal, pid, startedAt, summary } = options;

  return {
    ...snapshot,
    pid,
    status: 'running',
    commandState: 'running-command',
    connected: true,
    recoveryState: 'live',
    startedAt,
    lastActivityAt: startedAt,
    lastOutputAt: null,
    lastOutputLine: null,
    previewLines: [],
    scrollback: '',
    unreadCount: 0,
    summary: summary ?? `${terminal.shell} started in ${terminal.cwd}`,
    exitCode: null,
    disconnectReason: null,
    liveCwd: snapshot.liveCwd,
    projectRoot: snapshot.projectRoot,
    integration: snapshot.integration,
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
    commandState: 'idle-at-prompt',
    connected: false,
    recoveryState: 'spawn-failed',
    startedAt,
    summary: `Launch failed: ${message}`,
    exitCode: null,
    disconnectReason: message,
    liveCwd: snapshot.liveCwd,
    projectRoot: snapshot.projectRoot,
    integration: snapshot.integration,
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

  // renderTerminalText is O(scrollback length) — running it on every raw PTY
  // chunk (including single echoed characters) causes ~1 s input lag once the
  // scrollback grows large.  Preview lines are only shown on the overview card
  // and don't need to refresh on every byte; refreshing whenever a complete
  // line of output arrives is sufficient.
  const hasCompleteLine = chunk.includes('\n');
  const previewLines = hasCompleteLine
    ? extractPreviewLines(renderTerminalText(nextScrollback))
    : snapshot.previewLines;
  const lastOutputLine = hasCompleteLine
    ? (previewLines.at(-1) ?? snapshot.lastOutputLine)
    : snapshot.lastOutputLine;
  const unreadDelta = chunk.trim().length > 0 ? 1 : 0;

  return {
    ...snapshot,
    status: preserveOutputStatus(snapshot.status),
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

export function createContextSnapshot(
  snapshot: TerminalSessionSnapshot,
  context: {
    liveCwd?: string | null;
    projectRoot?: string | null;
    integration?: TerminalIntegrationState;
  },
): TerminalSessionSnapshot {
  return {
    ...snapshot,
    liveCwd:
      context.liveCwd === undefined ? snapshot.liveCwd : context.liveCwd,
    projectRoot:
      context.projectRoot === undefined ? snapshot.projectRoot : context.projectRoot,
    integration:
      context.integration === undefined
        ? snapshot.integration
        : context.integration,
  };
}

export function createCommandStateSnapshot(
  snapshot: TerminalSessionSnapshot,
  commandState: TerminalCommandState,
): TerminalSessionSnapshot {
  return {
    ...snapshot,
    commandState,
  };
}

export function applyAttentionEventSnapshot(
  snapshot: TerminalSessionSnapshot,
  event: AttentionEvent,
): TerminalSessionSnapshot {
  return {
    ...snapshot,
    status: event.status,
    lastActivityAt: event.timestamp,
    summary: event.detail || event.title || snapshot.summary,
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
    commandState: 'idle-at-prompt',
    exitCode,
    disconnectReason,
    summary: disconnectReason,
    lastActivityAt: timestamp,
  };
}

function preserveOutputStatus(status: TerminalStatus): TerminalStatus {
  if (
    status === 'needs-input' ||
    status === 'approval-needed' ||
    status === 'completed' ||
    status === 'failed' ||
    status === 'disconnected'
  ) {
    return status;
  }

  return 'active-output';
}

function createInitialIntegrationState(
  agentType: AgentType,
): TerminalIntegrationState {
  if (agentType === 'shell') {
    return {
      owner: null,
      status: 'not-required',
      message: 'Integration is not required for shell sessions.',
      updatedAt: null,
    };
  }

  return {
    owner: agentType,
    status: 'not-configured',
    message: 'Waiting for a project root to be detected.',
    updatedAt: null,
  };
}
