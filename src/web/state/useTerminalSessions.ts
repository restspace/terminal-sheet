import { useCallback, useEffect, useRef, useState } from 'react';

import type { AttentionEvent } from '../../shared/events';
import type {
  MarkdownDocumentState,
  MarkdownLinkState,
} from '../../shared/markdown';
import { parseJsonMessage, serializeJsonMessage } from '../../shared/jsonTransport';
import { appendScrollback } from '../../shared/scrollback';
import {
  type TerminalServerSocketMessage,
  terminalServerSocketMessageSchema,
  type TerminalClientSocketMessage,
  type TerminalSessionSnapshot,
  type TerminalSessionOutputState,
} from '../../shared/terminalSessions';
import type { Workspace } from '../../shared/workspace';
import {
  appendStateDebugSessionToUrl,
  logStateDebug,
  summarizeWorkspaceDiffForDebug,
  summarizeWorkspaceForDebug,
} from '../debug/stateDebug';

export type TerminalSocketState = 'connecting' | 'open' | 'closed' | 'error';

interface MergeSessionSnapshotsOptions {
  replaceAll?: boolean;
}

export function useTerminalSessions() {
  const [sessions, setSessions] = useState<
    Record<string, TerminalSessionSnapshot>
  >({});
  const [markdownDocuments, setMarkdownDocuments] = useState<
    Record<string, MarkdownDocumentState>
  >({});
  const [markdownLinks, setMarkdownLinks] = useState<MarkdownLinkState[]>([]);
  const [attentionEvents, setAttentionEvents] = useState<AttentionEvent[]>([]);
  const [workspaceSnapshot, setWorkspaceSnapshot] = useState<Workspace | null>(null);
  const [socketState, setSocketState] =
    useState<TerminalSocketState>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const pendingSessionTimersRef = useRef(new Map<string, number>());

  const refreshSnapshots = useCallback(async () => {
    try {
      const response = await fetch('/api/sessions');

      if (!response.ok) {
        return [] as TerminalSessionSnapshot[];
      }

      const body = (await response.json()) as {
        sessions?: TerminalSessionSnapshot[];
      };
      const nextSessions = Array.isArray(body.sessions) ? body.sessions : [];

      setSessions((current) => mergeSessionSnapshots(current, nextSessions));
      return nextSessions;
    } catch {
      // WebSocket remains the primary transport; polling is only a safety net.
      return [] as TerminalSessionSnapshot[];
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) {
        return;
      }

      setSocketState('connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(
        appendStateDebugSessionToUrl(
          `${protocol}://${window.location.host}/ws`,
        ),
      );
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        if (!cancelled) {
          setSocketState('open');
          logStateDebug('socket', 'open', {
            url: socket.url,
          });
        }
      });

      socket.addEventListener('error', () => {
        if (!cancelled) {
          setSocketState('error');
          logStateDebug('socket', 'error', {
            url: socket.url,
          });
        }
      });

      socket.addEventListener('close', () => {
        if (cancelled) {
          return;
        }

        setSocketState('closed');
        logStateDebug('socket', 'close', {
          url: socket.url,
        });
        reconnectTimerRef.current = window.setTimeout(() => {
          connect();
        }, 1_000);
      });

      socket.addEventListener('message', (event) => {
        const parsed = parseServerMessage(event.data);

        if (!parsed) {
          return;
        }

        setSessions((current) => applyServerMessage(current, parsed));
        setMarkdownDocuments((current) =>
          applyMarkdownDocumentMessage(current, parsed),
        );
        setMarkdownLinks((current) => applyMarkdownLinkMessage(current, parsed));
        setAttentionEvents((current) => applyAttentionMessage(current, parsed));
        setWorkspaceSnapshot((current) => {
          const nextWorkspace = applyWorkspaceMessage(current, parsed);

          if (parsed.type === 'workspace.updated') {
            logStateDebug('socket', 'workspace.updated', {
              workspace: summarizeWorkspaceForDebug(nextWorkspace),
              diff: summarizeWorkspaceDiffForDebug(current, nextWorkspace),
            });
          }

          return nextWorkspace;
        });
      });
    };

    connect();

    return () => {
      cancelled = true;

      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }

      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  useEffect(() => {
    const initialRefreshTimerId = window.setTimeout(() => {
      void refreshSnapshots();
    }, 0);
    const intervalId = shouldPollSnapshots(socketState)
      ? window.setInterval(() => {
          void refreshSnapshots();
        }, 2_000)
      : null;

    return () => {
      window.clearTimeout(initialRefreshTimerId);
      if (intervalId !== null) {
        window.clearInterval(intervalId);
      }
    };
  }, [refreshSnapshots, socketState]);

  useEffect(() => {
    const pendingSessionTimers = pendingSessionTimersRef.current;

    return () => {
      for (const timerId of pendingSessionTimers.values()) {
        window.clearTimeout(timerId);
      }
      pendingSessionTimers.clear();
    };
  }, []);

  const send = useCallback((message: TerminalClientSocketMessage) => {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(serializeJsonMessage(message));
  }, []);

  return {
    sessions,
    markdownDocuments,
    markdownLinks,
    attentionEvents,
    workspaceSnapshot,
    socketState,
    awaitSession: useCallback((sessionId: string) => {
      if (pendingSessionTimersRef.current.has(sessionId)) {
        return;
      }

      let attemptsRemaining = 12;

      const pollForSession = async () => {
        const sessionsSnapshot = await refreshSnapshots();

        if (sessionsSnapshot.some((session) => session.sessionId === sessionId)) {
          const timerId = pendingSessionTimersRef.current.get(sessionId);

          if (timerId !== undefined) {
            window.clearTimeout(timerId);
          }
          pendingSessionTimersRef.current.delete(sessionId);
          return;
        }

        attemptsRemaining -= 1;

        if (attemptsRemaining <= 0) {
          pendingSessionTimersRef.current.delete(sessionId);
          return;
        }

        const timerId = window.setTimeout(() => {
          void pollForSession();
        }, 250);
        pendingSessionTimersRef.current.set(sessionId, timerId);
      };

      void pollForSession();
    }, [refreshSnapshots]),
    sendInput: useCallback((sessionId: string, data: string) => {
      send({
        type: 'terminal.input',
        sessionId,
        data,
      });
    }, [send]),
    resizeSession: useCallback((sessionId: string, cols: number, rows: number) => {
      send({
        type: 'terminal.resize',
        sessionId,
        cols,
        rows,
      });
    }, [send]),
    restartSession: useCallback((sessionId: string) => {
      send({
        type: 'terminal.restart',
        sessionId,
      });
    }, [send]),
    markSessionRead: useCallback((sessionId: string) => {
      send({
        type: 'terminal.mark-read',
        sessionId,
      });
    }, [send]),
  };
}

function parseServerMessage(payload: unknown): TerminalServerSocketMessage | null {
  return parseJsonMessage(payload, terminalServerSocketMessageSchema);
}

export function shouldPollSnapshots(socketState: TerminalSocketState): boolean {
  return socketState !== 'open';
}

export function applyServerMessage(
  current: Record<string, TerminalSessionSnapshot>,
  message: TerminalServerSocketMessage,
): Record<string, TerminalSessionSnapshot> {
  switch (message.type) {
    case 'ready':
    case 'workspace.updated':
      return current;
    case 'session.init':
      return mergeSessionSnapshots(current, message.sessions, {
        replaceAll: true,
      });
    case 'session.snapshot': {
      const existing = current[message.session.sessionId];

      if (existing && areSessionSnapshotsEqual(existing, message.session)) {
        return current;
      }

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

function mergeSessionOutput(
  existing: TerminalSessionSnapshot | undefined,
  message: Extract<TerminalServerSocketMessage, { type: 'session.output' }>,
): TerminalSessionSnapshot {
  const scrollback = appendScrollback(existing?.scrollback ?? '', message.data);

  if (!existing) {
    return createSnapshotFromOutput(message.sessionId, message.backendId, message.state, scrollback);
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

export function applyWorkspaceMessage(
  current: Workspace | null,
  message: TerminalServerSocketMessage,
): Workspace | null {
  switch (message.type) {
    case 'workspace.updated':
      return message.workspace;
    default:
      return current;
  }
}

export function applyAttentionMessage(
  current: AttentionEvent[],
  message: TerminalServerSocketMessage,
): AttentionEvent[] {
  switch (message.type) {
    case 'attention.init':
      return message.events;
    case 'attention.event':
      return [message.event, ...current].slice(0, 48);
    default:
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

function applyMarkdownDocumentMessage(
  current: Record<string, MarkdownDocumentState>,
  message: TerminalServerSocketMessage,
): Record<string, MarkdownDocumentState> {
  switch (message.type) {
    case 'markdown.init':
      return Object.fromEntries(
        message.documents.map((document) => [document.nodeId, document]),
      );
    case 'markdown.document':
      return {
        ...current,
        [message.document.nodeId]: message.document,
      };
    default:
      return current;
  }
}

function applyMarkdownLinkMessage(
  current: MarkdownLinkState[],
  message: TerminalServerSocketMessage,
): MarkdownLinkState[] {
  switch (message.type) {
    case 'markdown.link.init':
    case 'markdown.link':
      return message.links;
    default:
      return current;
  }
}
