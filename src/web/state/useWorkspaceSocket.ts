import { useCallback, useEffect, useRef, useState } from 'react';

import { parseJsonMessage, serializeJsonMessage } from '../../shared/jsonTransport';
import {
  type TerminalClientSocketMessage,
  type TerminalServerSocketMessage,
  terminalServerSocketMessageSchema,
} from '../../shared/terminalSessions';
import {
  appendStateDebugSessionToUrl,
  logStateDebug,
} from '../debug/stateDebug';

export type TerminalSocketState = 'connecting' | 'open' | 'closed' | 'error';

interface UseWorkspaceSocketOptions {
  onMessage: (message: TerminalServerSocketMessage) => void;
}

interface WorkspaceSocketController {
  socketState: TerminalSocketState;
  send: (message: TerminalClientSocketMessage) => boolean;
}

export function useWorkspaceSocket({
  onMessage,
}: UseWorkspaceSocketOptions): WorkspaceSocketController {
  const [socketState, setSocketState] =
    useState<TerminalSocketState>('connecting');
  const socketRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const onMessageRef = useRef(onMessage);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

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

        onMessageRef.current(parsed);
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
      return false;
    }

    socket.send(serializeJsonMessage(message));
    return true;
  }, []);

  return {
    socketState,
    send,
  };
}

export function parseServerMessage(
  payload: unknown,
): TerminalServerSocketMessage | null {
  return parseJsonMessage(payload, terminalServerSocketMessageSchema);
}

export function shouldPollSnapshots(socketState: TerminalSocketState): boolean {
  return socketState !== 'open';
}
