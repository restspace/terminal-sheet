import type { FastifyInstance } from 'fastify';

import { backendTerminalCreateRequestSchema } from '../../shared/backends';
import { createTerminalNode } from '../../shared/workspace';
import type { ServerRole } from '../../shared/backends';
import type { AttentionService } from '../integrations/attentionService';
import { rotateServerIdentityToken } from '../persistence/serverIdentityStore';
import type { WorkspaceService } from '../persistence/workspaceService';
import type { PtySessionManager } from '../pty/ptySessionManager';
import { WorkspaceCommitService } from '../workspace/workspaceCommitService';
import { readMachineToken } from './machineAuth';

interface BackendMachineRouteOptions {
  role: ServerRole;
  serverId: string;
  getMachineToken: () => string;
  setMachineToken: (machineToken: string) => void;
  serverIdentityFilePath: string;
  localBackendId: string;
  workspaceService: WorkspaceService;
  workspaceCommitService: WorkspaceCommitService;
  ptySessionManager: PtySessionManager;
  attentionService: AttentionService;
  onTokenRotated?: (newToken: string) => void;
}

export async function registerBackendMachineRoutes(
  app: FastifyInstance,
  options: BackendMachineRouteOptions,
): Promise<void> {
  app.addHook('preHandler', async (request, reply) => {
    if (!request.url.startsWith('/api/backend/')) {
      return;
    }

    const token = readMachineToken(request);

    if (token !== options.getMachineToken()) {
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

  app.post('/api/backend/terminals', async (request, reply) => {
    const body = backendTerminalCreateRequestSchema.parse(request.body);
    const workspace = options.workspaceService.getWorkspace();

    if (body.id && workspace.terminals.some((terminal) => terminal.id === body.id)) {
      return reply.code(409).send({ message: `Terminal ${body.id} already exists.` });
    }

    const generated = createTerminalNode(
      {
        label: body.label,
        shell: body.shell,
        cwd: body.cwd,
        agentType: body.agentType,
        backendId: options.localBackendId,
        repoLabel: body.repoLabel,
        taskLabel: body.taskLabel,
        tags: body.tags,
      },
      workspace.terminals.length,
      workspace.currentViewport,
    );
    const terminal = body.id
      ? {
          ...generated,
          id: body.id,
        }
      : generated;
    const nextWorkspace = {
      ...workspace,
      terminals: [...workspace.terminals, terminal],
    };
    const savedWorkspace = await options.workspaceCommitService.commitWorkspace(nextWorkspace);

    return {
      terminal,
      workspace: savedWorkspace,
    };
  });

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
      const body = request.body as {
        cols?: number;
        rows?: number;
        generation?: number;
      };

      if (
        !Number.isFinite(body?.cols) ||
        !Number.isFinite(body?.rows) ||
        !Number.isFinite(body?.generation)
      ) {
        return reply.code(400).send({ message: 'Missing resize dimensions' });
      }

      const ok = options.ptySessionManager.resizeSession(
        request.params.sessionId,
        Number(body.cols),
        Number(body.rows),
        Number(body.generation),
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

  app.post('/api/backend/machine/token/rotate', async () => {
    const newIdentity = await rotateServerIdentityToken(
      options.serverIdentityFilePath,
    );
    options.setMachineToken(newIdentity.machineToken);
    options.onTokenRotated?.(newIdentity.machineToken);
    return { machineToken: newIdentity.machineToken };
  });
}
