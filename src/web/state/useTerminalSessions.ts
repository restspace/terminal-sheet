import { useCallback, useEffect, useRef } from 'react';

import type {
  TerminalClientSocketMessage,
  TerminalSessionSnapshot,
} from '../../shared/terminalSessions';
import type { Workspace } from '../../shared/workspace';
import { useAttentionStore } from './useAttentionStore';
import { useMarkdownRealtime } from './useMarkdownRealtime';
import { useSessionStore } from './useSessionStore';
import { useWorkspaceRealtime } from './useWorkspaceRealtime';
import { shouldPollSnapshots, useWorkspaceSocket } from './useWorkspaceSocket';

interface UseTerminalSessionsOptions {
  workspace: Workspace | null;
  refreshWorkspaceFromServer: (nextWorkspace?: Workspace | null) => Promise<boolean>;
}

export function useTerminalSessions({
  workspace,
  refreshWorkspaceFromServer,
}: UseTerminalSessionsOptions) {
  const { sessions, handleSessionMessage, mergeFetchedSnapshots } =
    useSessionStore();
  const { markdownDocuments, markdownLinks, handleMarkdownMessage } =
    useMarkdownRealtime();
  const { attentionEvents, handleAttentionMessage } = useAttentionStore();
  const { handleWorkspaceMessage } = useWorkspaceRealtime({
    workspace,
    refreshWorkspaceFromServer,
  });
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

      mergeFetchedSnapshots(nextSessions);
      return nextSessions;
    } catch {
      // WebSocket remains the primary transport; polling is only a safety net.
      return [] as TerminalSessionSnapshot[];
    }
  }, [mergeFetchedSnapshots]);

  const handleServerMessage = useCallback(
    (message: Parameters<typeof handleSessionMessage>[0]) => {
      handleSessionMessage(message);
      handleMarkdownMessage(message);
      handleAttentionMessage(message);
      handleWorkspaceMessage(message);
    },
    [
      handleAttentionMessage,
      handleMarkdownMessage,
      handleSessionMessage,
      handleWorkspaceMessage,
    ],
  );

  const { socketState, send } = useWorkspaceSocket({
    onMessage: handleServerMessage,
  });
  const pendingSessionPollTokensRef = useRef(new Map<string, symbol>());

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
    const pendingSessionPollTokens = pendingSessionPollTokensRef.current;

    return () => {
      for (const timerId of pendingSessionTimers.values()) {
        window.clearTimeout(timerId);
      }
      pendingSessionTimers.clear();
      pendingSessionPollTokens.clear();
    };
  }, []);

  return {
    sessions,
    markdownDocuments,
    markdownLinks,
    attentionEvents,
    socketState,
    awaitSession: useCallback(
      (sessionId: string) => {
        const existingTimerId = pendingSessionTimersRef.current.get(sessionId);
        if (existingTimerId !== undefined) {
          window.clearTimeout(existingTimerId);
        }
        pendingSessionTimersRef.current.delete(sessionId);

        const pollToken = Symbol(sessionId);
        pendingSessionPollTokensRef.current.set(sessionId, pollToken);

        let attemptsRemaining = 12;

        const pollForSession = async () => {
          if (pendingSessionPollTokensRef.current.get(sessionId) !== pollToken) {
            return;
          }

          const sessionsSnapshot = await refreshSnapshots();

          if (pendingSessionPollTokensRef.current.get(sessionId) !== pollToken) {
            return;
          }

          if (
            sessionsSnapshot.some((session) => session.sessionId === sessionId)
          ) {
            const timerId = pendingSessionTimersRef.current.get(sessionId);

            if (timerId !== undefined) {
              window.clearTimeout(timerId);
            }
            pendingSessionTimersRef.current.delete(sessionId);
            pendingSessionPollTokensRef.current.delete(sessionId);
            return;
          }

          attemptsRemaining -= 1;

          if (attemptsRemaining <= 0) {
            const timerId = pendingSessionTimersRef.current.get(sessionId);

            if (timerId !== undefined) {
              window.clearTimeout(timerId);
            }
            pendingSessionTimersRef.current.delete(sessionId);
            pendingSessionPollTokensRef.current.delete(sessionId);
            return;
          }

          const timerId = window.setTimeout(() => {
            void pollForSession();
          }, 250);
          pendingSessionTimersRef.current.set(sessionId, timerId);
        };

        void pollForSession();
      },
      [refreshSnapshots],
    ),
    sendInput: useCallback(
      (sessionId: string, data: string) => {
        send({
          type: 'terminal.input',
          sessionId,
          data,
        });
      },
      [send],
    ),
    resizeSession: useCallback(
      (sessionId: string, cols: number, rows: number) => {
        send({
          type: 'terminal.resize',
          sessionId,
          cols,
          rows,
        });
      },
      [send],
    ),
    restartSession: useCallback(
      (sessionId: string) => {
        send({
          type: 'terminal.restart',
          sessionId,
        });
      },
      [send],
    ),
    markSessionRead: useCallback(
      (sessionId: string) => {
        send({
          type: 'terminal.mark-read',
          sessionId,
        });
      },
      [send],
    ),
  };
}
