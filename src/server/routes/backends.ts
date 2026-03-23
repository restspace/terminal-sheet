import type { FastifyInstance, FastifyReply } from 'fastify';

import {
  type BackendConnection,
  type BackendStatus,
  type BackendTunnelStatus,
  backendCreateRequestSchema,
  backendTerminalCreateRequestSchema,
  backendSshSetupRequestSchema,
  type ServerRole,
} from '../../shared/backends';
import type { WorkspaceService } from '../persistence/workspaceService';
import type { BackendRuntimeManager } from '../runtime/backendRuntimeManager';
import { SshSetupService } from '../runtime/sshSetupService';
import type { SshTunnelManager } from '../runtime/sshTunnelManager';
import {
  BackendProvisioningError,
  BackendProvisioningService,
  findAvailablePort,
} from '../backends/backendProvisioningService';
import { normalizeBaseUrl } from '../backends/remoteBackendClient';
import { WorkspaceCommitService } from '../workspace/workspaceCommitService';
import { getHomeUrl } from './requestOrigin';

interface BackendRouteOptions {
  role: ServerRole;
  workspaceService: WorkspaceService;
  workspaceCommitService: WorkspaceCommitService;
  runtimeManager: BackendRuntimeManager;
  tunnelManager: SshTunnelManager;
  contentRoot: string;
}

export async function registerBackendRoutes(
  app: FastifyInstance,
  options: BackendRouteOptions,
): Promise<void> {
  const sshSetupService = new SshSetupService(
    app.log.child({ component: 'ssh-setup' }),
    { contentRoot: options.contentRoot },
  );
  const provisioningService = new BackendProvisioningService(
    options.workspaceCommitService,
    options.tunnelManager,
  );

  app.get('/api/backends', async () => {
    const workspace = options.workspaceService.getWorkspace();
    const runtimeStatuses = new Map(
      options.runtimeManager.getBackendStatuses().map((status) => [status.id, status]),
    );
    const tunnelStatuses = new Map(
      options.tunnelManager
        .getTunnelStatuses()
        .map((status) => [status.backendId, status]),
    );

    return {
      backends: workspace.backends.map((backend) => ({
        ...backend,
        status: mergeBackendStatus(
          backend,
          runtimeStatuses.get(backend.id) ?? null,
          tunnelStatuses.get(backend.id) ?? null,
        ),
      })),
    };
  });

  app.post('/api/backends', async (request, reply) => {
    if (options.role !== 'home') {
      return reply.code(400).send({
        message: 'Remote backends can only be configured on a home server.',
      });
    }

    const body = backendCreateRequestSchema.parse(request.body);
    const workspace = options.workspaceService.getWorkspace();
    const backendId = provisioningService.buildBackendId(
      body.label,
      workspace.backends.map((backend) => backend.id),
    );

    try {
      const result = await provisioningService.registerBackendConnection({
        connection: {
          id: backendId,
          label: body.label.trim(),
          baseUrl: body.baseUrl,
          token: body.token.trim(),
          transport: 'direct',
          enabled: true,
        },
      });

      return {
        backend: result.backend,
        importedTerminalCount: result.importedTerminalCount,
        workspace: result.workspace,
      };
    } catch (error) {
      return sendBackendError(reply, error);
    }
  });

  app.post('/api/backends/ssh/setup', async (request, reply) => {
    if (options.role !== 'home') {
      return reply.code(400).send({
        message: 'Remote backends can only be configured on a home server.',
      });
    }

    const body = backendSshSetupRequestSchema.parse(request.body);
    const workspace = options.workspaceService.getWorkspace();
    const backendId = provisioningService.buildBackendId(
      body.label,
      workspace.backends.map((backend) => backend.id),
    );

    try {
      const localPort = await findAvailablePort(body.localPort);
      const localHost = '127.0.0.1';
      const remoteHost = '127.0.0.1';
      const baseUrl = `http://${localHost}:${localPort}`;

      if (workspace.backends.some((backend) => normalizeBaseUrl(backend.baseUrl) === baseUrl)) {
        return reply.code(409).send({ message: 'Tunnel URL is already configured.' });
      }

      const resolvedToken = await sshSetupService.resolveToken(body);
      const installResult = await sshSetupService.runInstall(
        body.sshTarget,
        {
          sshPort: body.sshPort,
          sshIdentityFile: body.sshIdentityFile,
        },
        getHomeUrl(request),
        body.remotePort,
        body.runInstall,
      );
      const token = installResult.capturedToken ?? resolvedToken;

      if (!token) {
        throw new BackendProvisioningError(
          400,
          'No token available. Provide a token manually, choose a token file path, or enable install output parsing.',
        );
      }

      const connection: BackendConnection = {
        id: backendId,
        label: body.label.trim(),
        baseUrl,
        token,
        enabled: true,
        transport: 'ssh-tunnel',
        ssh: {
          target: body.sshTarget.trim(),
          port: body.sshPort,
          identityFile: body.sshIdentityFile?.trim() || undefined,
          remoteHost,
          remotePort: body.remotePort,
          localHost,
          localPort,
        },
      };

      options.tunnelManager.ensureTunnel(connection);
      await provisioningService.waitForTunnelReady(backendId);

      try {
        const result = await provisioningService.registerBackendConnection({
          connection,
          healthAttempts: 20,
          healthDelayMs: 1_000,
        });
        const tunnelStatus =
          options.tunnelManager
            .getTunnelStatuses()
            .find((status) => status.backendId === backendId) ?? null;

        return {
          backend: result.backend,
          importedTerminalCount: result.importedTerminalCount,
          workspace: result.workspace,
          tunnel: tunnelStatus,
          detectedOs: installResult.detectedOs,
        };
      } catch (error) {
        const enrichedError = provisioningService.enrichErrorWithTunnelStatus(error, backendId);
        options.tunnelManager.removeTunnel(backendId);
        throw enrichedError;
      }
    } catch (error) {
      return sendBackendError(reply, error);
    }
  });

  app.post<{ Params: { backendId: string } }>(
    '/api/backends/:backendId/terminals',
    async (request, reply) => {
      if (options.role !== 'home') {
        return reply.code(400).send({
          message: 'Remote terminals can only be created from a home server.',
        });
      }

      const workspace = options.workspaceService.getWorkspace();
      const backend = workspace.backends.find(
        (candidate) => candidate.id === request.params.backendId,
      );

      if (!backend) {
        return reply.code(404).send({ message: 'Backend not found.' });
      }

      if (!backend.enabled) {
        return reply.code(400).send({ message: 'Backend is disabled.' });
      }

      const body = backendTerminalCreateRequestSchema.parse(request.body);

      try {
        const result = await provisioningService.createRemoteTerminal(backend, {
          label: body.label,
          shell: body.shell,
          cwd: body.cwd,
          agentType: body.agentType,
          repoLabel: body.repoLabel,
          taskLabel: body.taskLabel,
          tags: body.tags,
        });

        return { terminal: result.terminal, workspace: result.workspace };
      } catch (error) {
        return sendBackendError(
          reply,
          provisioningService.enrichErrorWithTunnelStatus(error, backend.id),
        );
      }
    },
  );

  app.post<{ Params: { backendId: string } }>(
    '/api/backends/:backendId/rotate-token',
    async (request, reply) => {
      if (options.role !== 'home') {
        return reply.code(400).send({ message: 'Token rotation only available on home servers.' });
      }

      const workspace = options.workspaceService.getWorkspace();
      const backend = workspace.backends.find(
        (candidate) => candidate.id === request.params.backendId,
      );

      if (!backend) {
        return reply.code(404).send({ message: 'Backend not found.' });
      }

      try {
        const result = await provisioningService.rotateBackendToken(backend);
        return { backendId: backend.id, workspace: result.workspace };
      } catch (error) {
        return sendBackendError(reply, error);
      }
    },
  );

  app.delete<{ Params: { backendId: string } }>(
    '/api/backends/:backendId',
    async (request, reply) => {
      const workspace = options.workspaceService.getWorkspace();
      const backend = workspace.backends.find(
        (candidate) => candidate.id === request.params.backendId,
      );

      if (!backend) {
        return reply.code(404).send({ message: 'Backend not found.' });
      }

      const nextWorkspace = {
        ...workspace,
        backends: workspace.backends.filter(
          (candidate) => candidate.id !== request.params.backendId,
        ),
        terminals: workspace.terminals.filter(
          (terminal) => terminal.backendId !== request.params.backendId,
        ),
      };
      const savedWorkspace =
        await options.workspaceCommitService.commitWorkspace(nextWorkspace);
      options.tunnelManager.removeTunnel(request.params.backendId);

      return {
        backendId: request.params.backendId,
        workspace: savedWorkspace,
      };
    },
  );
}

function mergeBackendStatus(
  connection: BackendConnection,
  runtimeStatus: BackendStatus | null,
  tunnelStatus: BackendTunnelStatus | null,
): BackendStatus | null {
  if (runtimeStatus) {
    return {
      ...runtimeStatus,
      tunnel: tunnelStatus,
    };
  }

  if (!tunnelStatus) {
    return null;
  }

  return {
    id: connection.id,
    label: connection.label,
    baseUrl: connection.baseUrl,
    state: tunnelStatus.state === 'connected' ? 'connecting' : 'disconnected',
    lastError: tunnelStatus.lastError,
    connectedAt: null,
    updatedAt: tunnelStatus.updatedAt,
    tunnel: tunnelStatus,
  };
}

function sendBackendError(reply: FastifyReply, error: unknown) {
  if (error instanceof BackendProvisioningError) {
    return reply.code(error.status).send({ message: error.message });
  }

  const message = error instanceof Error ? error.message : 'Backend setup failed.';
  return reply.code(500).send({ message });
}
