import { useCallback, useEffect, useRef, useState } from 'react';

import { parseJsonMessage, serializeJsonMessage } from '../../shared/jsonTransport';
import { appendScrollback } from '../../shared/scrollback';
import {
  type TerminalServerSocketMessage,
  terminalServerSocketMessageSchema,
  type TerminalClientSocketMessage,
  type TerminalSessionSnapshot,
} from '../../shared/terminalSessions';

export type TerminalSocketState = 'connecting' | 'open' | 'closed' | 'error';

export function useTerminalSessions() {
  const [sessions, setSessions] = useState<
    Record<string, TerminalSessionSnapshot>
  >({});
  const [socketState, setSocketState] =
    useState<TerminalSocketState>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) {
        return;
      }

      setSocketState('connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(`${protocol}://${window.location.host}/ws`);
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        if (!cancelled) {
          setSocketState('open');
        }
      });

      socket.addEventListener('error', () => {
        if (!cancelled) {
          setSocketState('error');
        }
      });

      socket.addEventListener('close', () => {
        if (cancelled) {
          return;
        }

        setSocketState('closed');
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

  const send = useCallback((message: TerminalClientSocketMessage) => {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }

    socket.send(serializeJsonMessage(message));
  }, []);

  return {
    sessions,
    socketState,
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

export function applyServerMessage(
  current: Record<string, TerminalSessionSnapshot>,
  message: TerminalServerSocketMessage,
): Record<string, TerminalSessionSnapshot> {
  switch (message.type) {
    case 'ready':
      return current;
    case 'session.init':
      return Object.fromEntries(
        message.sessions.map((session) => [session.sessionId, session]),
      );
    case 'session.snapshot':
      return {
        ...current,
        [message.session.sessionId]: message.session,
      };
    case 'session.output': {
      const existing = current[message.sessionId];

      if (!existing) {
        return current;
      }

      return {
        ...current,
        [message.sessionId]: {
          ...existing,
          scrollback: appendScrollback(existing.scrollback, message.data),
        },
      };
    }
    case 'session.removed': {
      const next = { ...current };
      delete next[message.sessionId];
      return next;
    }
  }
}
