import type { FastifyInstance } from 'fastify';

import { serializeJsonMessage } from '../../shared/jsonTransport';
import type { AttentionService } from '../integrations/attentionService';
import type { PtySessionManager } from '../pty/ptySessionManager';
import { readMachineToken } from '../routes/machineAuth';

interface BackendSocketOptions {
  machineToken: string;
  ptySessionManager: PtySessionManager;
  attentionService: AttentionService;
}

export async function registerBackendSocket(
  app: FastifyInstance,
  options: BackendSocketOptions,
): Promise<void> {
  app.get('/ws/backend', { websocket: true }, (socket, request) => {
    const token = readMachineToken(request);

    if (token !== options.machineToken) {
      socket.close(1008, 'Invalid machine token');
      return;
    }

    sendJson(socket, {
      type: 'ready',
      timestamp: new Date().toISOString(),
    });
    sendJson(socket, {
      type: 'session.init',
      sessions: options.ptySessionManager.getSnapshots(),
    });
    sendJson(socket, {
      type: 'attention.init',
      events: options.attentionService.getEvents(),
    });

    const unsubscribe = options.ptySessionManager.subscribe((message) => {
      sendJson(socket, message);
    });
    const unsubscribeAttention = options.attentionService.subscribe((event) => {
      sendJson(socket, {
        type: 'attention.event',
        event,
      });
    });

    socket.on('close', () => {
      unsubscribe();
      unsubscribeAttention();
    });
  });
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

  try {
    socket.send(serializeJsonMessage(payload));
  } catch {
    // Ignore shutdown races.
  }
}
