import {
  type MutableRefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from 'react';

import { parseJsonMessage, serializeJsonMessage } from '../../shared/jsonTransport';
import {
  type TerminalClientSocketMessage,
  type TerminalServerSocketMessage,
  terminalServerSocketMessageSchema,
} from '../../shared/terminalSessions';
import { logStateDebug } from '../debug/stateDebug';
import {
  appendFrontendLeaseToUrl,
  reportFrontendLeaseLocked,
} from './frontendLeaseClient';

export type TerminalSocketState = 'connecting' | 'open' | 'closed' | 'error';

const WORKSPACE_SOCKET_HEARTBEAT_INTERVAL_MS = 4_000;
const WORKSPACE_SOCKET_HEARTBEAT_TIMEOUT_MS = 12_000;

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
  const heartbeatTimerRef = useRef<number | null>(null);
  const heartbeatWatchdogRef = useRef<number | null>(null);
  const onMessageRef = useRef(onMessage);
  const lastLeaseAckAtRef = useRef<number>(Date.now());
  const suppressReconnectRef = useRef(false);

  useEffect(() => {
    onMessageRef.current = onMessage;
  }, [onMessage]);

  useEffect(() => {
    let cancelled = false;

    const connect = () => {
      if (cancelled) {
        return;
      }

      suppressReconnectRef.current = false;
      setSocketState('connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const socket = new WebSocket(
        appendFrontendLeaseToUrl(`${protocol}://${window.location.host}/ws`),
      );
      socketRef.current = socket;

      socket.addEventListener('open', () => {
        if (cancelled) {
          return;
        }

        setSocketState('open');
        lastLeaseAckAtRef.current = Date.now();
        logStateDebug('socket', 'open', {
          url: socket.url,
        });
        heartbeatTimerRef.current = window.setInterval(() => {
          if (socket.readyState !== WebSocket.OPEN) {
            return;
          }

          socket.send(
            serializeJsonMessage({
              type: 'frontend.heartbeat',
              timestamp: new Date().toISOString(),
            }),
          );
        }, WORKSPACE_SOCKET_HEARTBEAT_INTERVAL_MS);
        heartbeatWatchdogRef.current = window.setInterval(() => {
          if (
            Date.now() - lastLeaseAckAtRef.current <
            WORKSPACE_SOCKET_HEARTBEAT_TIMEOUT_MS
          ) {
            return;
          }

          socket.close();
        }, 1_000);
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
        clearHeartbeatTimers(heartbeatTimerRef, heartbeatWatchdogRef);

        if (cancelled) {
          return;
        }

        setSocketState('closed');
        logStateDebug('socket', 'close', {
          url: socket.url,
        });

        if (!suppressReconnectRef.current) {
          reconnectTimerRef.current = window.setTimeout(() => {
            connect();
          }, 1_000);
        }
      });

      socket.addEventListener('message', (event) => {
        const parsed = parseServerMessage(event.data);

        if (!parsed) {
          return;
        }

        if (parsed.type === 'frontend.lease') {
          lastLeaseAckAtRef.current = Date.now();
        }

        const summary = summarizeServerMessageForDebug(parsed);

        if (summary) {
          logStateDebug('socket', 'message', summary);
        }

        if (parsed.type === 'frontend.locked') {
          suppressReconnectRef.current = true;
          reportFrontendLeaseLocked(parsed.lock);
          socket.close();
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

      clearHeartbeatTimers(heartbeatTimerRef, heartbeatWatchdogRef);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, []);

  const send = useCallback((message: TerminalClientSocketMessage) => {
    const socket = socketRef.current;

    if (!socket || socket.readyState !== WebSocket.OPEN) {
      logStateDebug('socket', 'sendBlocked', summarizeClientMessageForDebug(message));
      return false;
    }
    logStateDebug('socket', 'send', summarizeClientMessageForDebug(message));

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

function summarizeClientMessageForDebug(
  message: TerminalClientSocketMessage,
): Record<string, unknown> {
  switch (message.type) {
    case 'frontend.heartbeat':
      return {
        type: message.type,
        timestamp: message.timestamp,
      };
    case 'terminal.input':
      return {
        type: message.type,
        sessionId: message.sessionId,
        dataLength: message.data.length,
        hasNewline: /[\r\n]/.test(message.data),
      };
    case 'terminal.resize':
      return {
        type: message.type,
        sessionId: message.sessionId,
        cols: message.cols,
        rows: message.rows,
        generation: message.generation,
      };
    case 'terminal.restart':
    case 'terminal.mark-read':
      return {
        type: message.type,
        sessionId: message.sessionId,
      };
  }
}

function summarizeServerMessageForDebug(
  message: TerminalServerSocketMessage,
): Record<string, unknown> | null {
  switch (message.type) {
    case 'frontend.lease':
      return {
        type: message.type,
        frontendId: message.lease.frontendId,
        ownerLabel: message.lease.ownerLabel,
        leaseEpoch: message.lease.leaseEpoch,
        expiresAt: message.lease.expiresAt,
      };
    case 'frontend.locked':
      return {
        type: message.type,
        owner: message.lock.owner,
        canTakeOver: message.lock.canTakeOver,
      };
    case 'ready':
      return {
        type: message.type,
        timestamp: message.timestamp,
      };
    case 'workspace.updated':
      return {
        type: message.type,
        layoutMode: message.workspace.layoutMode,
        terminalCount: message.workspace.terminals.length,
        markdownCount: message.workspace.markdown.length,
        updatedAt: message.workspace.updatedAt,
      };
    case 'session.init':
      return {
        type: message.type,
        sessions: message.sessions.map((session) => ({
          sessionId: session.sessionId,
          connected: session.connected,
          status: session.status,
          recoveryState: session.recoveryState,
          cols: session.cols,
          rows: session.rows,
          appliedResizeGeneration: session.appliedResizeGeneration,
        })),
      };
    case 'session.snapshot':
      return {
        type: message.type,
        sessionId: message.session.sessionId,
        connected: message.session.connected,
        status: message.session.status,
        recoveryState: message.session.recoveryState,
        cols: message.session.cols,
        rows: message.session.rows,
        appliedResizeGeneration: message.session.appliedResizeGeneration,
      };
    case 'session.removed':
      return {
        type: message.type,
        sessionId: message.sessionId,
        backendId: message.backendId,
      };
    default:
      return null;
  }
}

function clearHeartbeatTimers(
  heartbeatTimerRef: MutableRefObject<number | null>,
  heartbeatWatchdogRef: MutableRefObject<number | null>,
): void {
  if (heartbeatTimerRef.current !== null) {
    window.clearInterval(heartbeatTimerRef.current);
    heartbeatTimerRef.current = null;
  }

  if (heartbeatWatchdogRef.current !== null) {
    window.clearInterval(heartbeatWatchdogRef.current);
    heartbeatWatchdogRef.current = null;
  }
}
