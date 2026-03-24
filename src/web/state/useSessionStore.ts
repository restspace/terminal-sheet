import { useCallback, useState } from 'react';

import { appendScrollback } from '../../shared/scrollback';
import type {
  TerminalServerSocketMessage,
  TerminalSessionOutputState,
  TerminalSessionSnapshot,
} from '../../shared/terminalSessions';
import { logStateDebug } from '../debug/stateDebug';

interface MergeSessionSnapshotsOptions {
  replaceAll?: boolean;
}

interface SessionStore {
  sessions: Record<string, TerminalSessionSnapshot>;
  handleSessionMessage: (message: TerminalServerSocketMessage) => void;
  mergeFetchedSnapshots: (
    sessions: TerminalSessionSnapshot[],
    options?: MergeSessionSnapshotsOptions,
  ) => void;
}

export function useSessionStore(): SessionStore {
  const [sessions, setSessions] = useState<
    Record<string, TerminalSessionSnapshot>
  >({});

  const handleSessionMessage = useCallback(
    (message: TerminalServerSocketMessage) => {
      setSessions((current) => applyServerMessage(current, message));
    },
    [],
  );

  const mergeFetchedSnapshots = useCallback(
    (
      nextSessions: TerminalSessionSnapshot[],
      options?: MergeSessionSnapshotsOptions,
    ) => {
      setSessions((current) =>
        mergeSessionSnapshots(current, nextSessions, options),
      );
    },
    [],
  );

  return {
    sessions,
    handleSessionMessage,
    mergeFetchedSnapshots,
  };
}

export function applyServerMessage(
  current: Record<string, TerminalSessionSnapshot>,
  message: TerminalServerSocketMessage,
): Record<string, TerminalSessionSnapshot> {
  switch (message.type) {
    case 'frontend.lease':
    case 'frontend.locked':
    case 'ready':
    case 'workspace.updated':
      return current;
    case 'session.init':
      logStateDebug('sessions', 'session.init', {
        sessions: message.sessions.map(summarizeSessionSnapshotForDebug),
      });
      return mergeSessionSnapshots(current, message.sessions);
    case 'session.snapshot': {
      const existing = current[message.session.sessionId];

      if (existing && areSessionSnapshotsEqual(existing, message.session)) {
        logStateDebug('sessions', 'session.snapshotIgnored', {
          existing: summarizeSessionSnapshotForDebug(existing),
          next: summarizeSessionSnapshotForDebug(message.session),
        });
        return current;
      }

      logStateDebug('sessions', 'session.snapshotApplied', {
        existing: existing ? summarizeSessionSnapshotForDebug(existing) : null,
        next: summarizeSessionSnapshotForDebug(message.session),
      });

      return {
        ...current,
        [message.session.sessionId]: message.session,
      };
    }
    case 'session.output': {
      const existing = current[message.sessionId];
      const nextSession = mergeSessionOutput(existing, message);

      return {
        ...current,
        [message.sessionId]: nextSession,
      };
    }
    case 'session.removed': {
      const next = { ...current };
      delete next[message.sessionId];
      return next;
    }
    case 'attention.init':
    case 'attention.event':
    case 'markdown.init':
    case 'markdown.document':
    case 'markdown.link.init':
    case 'markdown.link':
      return current;
  }
}

export function mergeSessionSnapshots(
  current: Record<string, TerminalSessionSnapshot>,
  sessions: TerminalSessionSnapshot[],
  options: MergeSessionSnapshotsOptions = {},
): Record<string, TerminalSessionSnapshot> {
  const { replaceAll = false } = options;

  if (!sessions.length) {
    return replaceAll && Object.keys(current).length ? {} : current;
  }

  let changed = false;
  const next = replaceAll ? {} : { ...current };
  const seenSessionIds = new Set<string>();

  for (const session of sessions) {
    seenSessionIds.add(session.sessionId);

    const existing = current[session.sessionId];
    const nextSession =
      existing && areSessionSnapshotsEqual(existing, session) ? existing : session;

    if (existing !== nextSession) {
      changed = true;
    }

    next[session.sessionId] = nextSession;
  }

  if (replaceAll) {
    for (const sessionId of Object.keys(current)) {
      if (!seenSessionIds.has(sessionId)) {
        changed = true;
        break;
      }
    }
  }

  return changed ? next : current;
}

function mergeSessionOutput(
  existing: TerminalSessionSnapshot | undefined,
  message: Extract<TerminalServerSocketMessage, { type: 'session.output' }>,
): TerminalSessionSnapshot {
  const scrollback = appendScrollback(existing?.scrollback ?? '', message.data);

  if (!existing) {
    return createSnapshotFromOutput(
      message.sessionId,
      message.backendId,
      message.state,
      scrollback,
    );
  }

  return {
    ...existing,
    ...message.state,
    scrollback,
  };
}

function createSnapshotFromOutput(
  sessionId: string,
  backendId: string,
  state: TerminalSessionOutputState,
  scrollback: string,
): TerminalSessionSnapshot {
  return {
    sessionId,
    backendId,
    scrollback,
    ...state,
  };
}

function areSessionSnapshotsEqual(
  left: TerminalSessionSnapshot,
  right: TerminalSessionSnapshot,
): boolean {
  return (
    left.sessionId === right.sessionId &&
    left.backendId === right.backendId &&
    left.pid === right.pid &&
    left.status === right.status &&
    left.commandState === right.commandState &&
    left.connected === right.connected &&
    left.recoveryState === right.recoveryState &&
    left.startedAt === right.startedAt &&
    left.lastActivityAt === right.lastActivityAt &&
    left.lastOutputAt === right.lastOutputAt &&
    left.lastOutputLine === right.lastOutputLine &&
    left.scrollback === right.scrollback &&
    left.unreadCount === right.unreadCount &&
    left.summary === right.summary &&
    left.exitCode === right.exitCode &&
    left.disconnectReason === right.disconnectReason &&
    left.cols === right.cols &&
    left.rows === right.rows &&
    left.liveCwd === right.liveCwd &&
    left.projectRoot === right.projectRoot &&
    arePreviewLinesEqual(left.previewLines, right.previewLines) &&
    areIntegrationStatesEqual(left.integration, right.integration)
  );
}

function arePreviewLinesEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function areIntegrationStatesEqual(
  left: TerminalSessionSnapshot['integration'],
  right: TerminalSessionSnapshot['integration'],
): boolean {
  return (
    left.owner === right.owner &&
    left.status === right.status &&
    left.message === right.message &&
    left.updatedAt === right.updatedAt
  );
}

function summarizeSessionSnapshotForDebug(
  session: TerminalSessionSnapshot,
): Record<string, unknown> {
  return {
    sessionId: session.sessionId,
    status: session.status,
    recoveryState: session.recoveryState,
    connected: session.connected,
    cols: session.cols,
    rows: session.rows,
    appliedResizeGeneration: session.appliedResizeGeneration,
    lastActivityAt: session.lastActivityAt,
    lastOutputAt: session.lastOutputAt,
  };
}
