import type { FastifyInstance } from 'fastify';

import type { ServerRole } from '../../shared/backends';
import type { AttentionService } from '../integrations/attentionService';
import type { WorkspaceService } from '../persistence/workspaceService';
import type { PtySessionManager } from '../pty/ptySessionManager';
import { readMachineToken } from './machineAuth';

interface BackendMachineRouteOptions {
  role: ServerRole;
  serverId: string;
  machineToken: string;
  localBackendId: string;
  workspaceService: WorkspaceService;
  ptySessionManager: PtySessionManager;
  attentionService: AttentionService;
}

export async function registerBackendMachineRoutes(
  app: FastifyInstance,
  options: BackendMachineRouteOptions,
): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/backend')) {
      return;
    }

    const token = readMachineToken(request);

    if (token !== options.machineToken) {
      return reply.code(401).send({ message: 'Invalid machine token' });
    }
  });

  app.get('/api/backend/health', async () => ({
    status: 'ok',
    role: options.role,
    serverId: options.serverId,
    timestamp: new Date().toISOString(),
  }));

  app.get('/api/backend/workspace', async () => ({
    terminals: options.workspaceService
      .getWorkspace()
      .terminals.filter((terminal) => terminal.backendId === options.localBackendId),
  }));

  app.get('/api/backend/sessions', async () => ({
    sessions: options.ptySessionManager.getSnapshots(),
  }));

  app.get('/api/backend/attention/events', async () => ({
    events: options.attentionService.getEvents(),
  }));

  app.post<{ Params: { sessionId: string } }>(
    '/api/backend/sessions/:sessionId/input',
    async (request, reply) => {
      const body = request.body as { data?: string };

      if (typeof body?.data !== 'string') {
        return reply.code(400).send({ message: 'Missing input payload' });
      }

      const ok = options.ptySessionManager.sendInput(request.params.sessionId, body.data);
      return ok
        ? { ok: true }
        : reply.code(404).send({ message: 'Unknown session' });
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    '/api/backend/sessions/:sessionId/resize',
    async (request, reply) => {
      const body = request.body as { cols?: number; rows?: number };

      if (!Number.isFinite(body?.cols) || !Number.isFinite(body?.rows)) {
        return reply.code(400).send({ message: 'Missing resize dimensions' });
      }

      const ok = options.ptySessionManager.resizeSession(
        request.params.sessionId,
        Number(body.cols),
        Number(body.rows),
      );
      return ok
        ? { ok: true }
        : reply.code(404).send({ message: 'Unknown session' });
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    '/api/backend/sessions/:sessionId/restart',
    async (request, reply) => {
      const ok = options.ptySessionManager.restartSession(request.params.sessionId);
      return ok
        ? { ok: true }
        : reply.code(404).send({ message: 'Unknown session' });
    },
  );

  app.post<{ Params: { sessionId: string } }>(
    '/api/backend/sessions/:sessionId/mark-read',
    async (request, reply) => {
      const ok = options.ptySessionManager.markRead(request.params.sessionId);
      return ok
        ? { ok: true }
        : reply.code(404).send({ message: 'Unknown session' });
    },
  );
}
