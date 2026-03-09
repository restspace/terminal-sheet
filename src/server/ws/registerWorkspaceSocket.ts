import type { FastifyInstance } from 'fastify';

import {
  terminalClientSocketMessageSchema,
  type TerminalClientSocketMessage,
} from '../../shared/terminalSessions';
import type { PtySessionManager } from '../pty/ptySessionManager';

interface WorkspaceSocketOptions {
  ptySessionManager: PtySessionManager;
}

export async function registerWorkspaceSocket(
  app: FastifyInstance,
  options: WorkspaceSocketOptions,
): Promise<void> {
  app.get('/ws', { websocket: true }, (socket) => {
    sendJson(socket, {
      type: 'ready',
      timestamp: new Date().toISOString(),
    });
    sendJson(socket, {
      type: 'session.init',
      sessions: options.ptySessionManager.getSnapshots(),
    });

    const unsubscribe = options.ptySessionManager.subscribe((message) => {
      sendJson(socket, message);
    });

    socket.on('message', (payload: Buffer) => {
      const parsed = parseClientMessage(payload.toString());

      if (!parsed) {
        return;
      }

      handleClientMessage(options.ptySessionManager, parsed);
    });

    socket.on('close', () => {
      unsubscribe();
    });
  });
}

function parseClientMessage(payload: string): TerminalClientSocketMessage | null {
  try {
    return terminalClientSocketMessageSchema.parse(JSON.parse(payload));
  } catch {
    return null;
  }
}

function handleClientMessage(
  ptySessionManager: PtySessionManager,
  message: TerminalClientSocketMessage,
): void {
  switch (message.type) {
    case 'terminal.input':
      ptySessionManager.sendInput(message.sessionId, message.data);
      return;
    case 'terminal.resize':
      ptySessionManager.resizeSession(
        message.sessionId,
        message.cols,
        message.rows,
      );
      return;
    case 'terminal.restart':
      ptySessionManager.restartSession(message.sessionId);
      return;
    case 'terminal.mark-read':
      ptySessionManager.markRead(message.sessionId);
      return;
  }
}

function sendJson(
  socket: {
    readyState: number;
    send: (payload: string) => void;
  },
  payload: object,
): void {
  if (socket.readyState !== 1) {
    return;
  }

  socket.send(JSON.stringify(payload));
}
