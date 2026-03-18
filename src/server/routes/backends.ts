import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

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
import {
  createTerminalNode,
  terminalNodeSchema,
  type TerminalNode,
} from '../../shared/workspace';
import type { WorkspaceService } from '../persistence/workspaceService';
import type { BackendRuntimeManager } from '../runtime/backendRuntimeManager';
import { SshSetupService } from '../runtime/sshSetupService';
import type { SshTunnelManager } from '../runtime/sshTunnelManager';

interface BackendRouteOptions {
  role: ServerRole;
  workspaceService: WorkspaceService;
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
    const baseUrl = normalizeBaseUrl(body.baseUrl);

    try {
      const workspace = options.workspaceService.getWorkspace();
      const backendId = buildBackendId(
        body.label,
        workspace.backends.map((backend) => backend.id),
      );

      const result = await registerBackendConnection({
        workspaceService: options.workspaceService,
        connection: {
          id: backendId,
          label: body.label.trim(),
          baseUrl,
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
    const backendId = buildBackendId(
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
        throw new BackendRouteError(
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
      await waitForTunnelReady(options.tunnelManager, backendId);

      try {
        const result = await registerBackendConnection({
          workspaceService: options.workspaceService,
          connection,
          healthAttempts: 20,
          healthDelayMs: 1_000,
        });
        const tunnelStatus = options.tunnelManager
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
        const enrichedError = withTunnelStatusContext(
          error,
          options.tunnelManager,
          backendId,
        );
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
      const provisional = createTerminalNode(
        {
          label: body.label,
          shell: body.shell,
          cwd: body.cwd,
          agentType: body.agentType,
          backendId: backend.id,
          repoLabel: body.repoLabel,
          taskLabel: body.taskLabel,
          tags: body.tags,
        },
        workspace.terminals.length,
        workspace.currentViewport,
      );

      try {
        const remoteCreate = await fetchRemoteJson(
          resolveUrl(backend.baseUrl, '/api/backend/terminals'),
          backend.token,
          'POST',
          {
            id: provisional.id,
            label: body.label,
            shell: body.shell,
            cwd: body.cwd,
            agentType: body.agentType,
            repoLabel: body.repoLabel,
            taskLabel: body.taskLabel,
            tags: body.tags,
          },
        );

        if (!remoteCreate.ok) {
          if (remoteCreate.status === 401) {
            throw new BackendRouteError(401, 'Remote backend rejected the token.');
          }

          throw new BackendRouteError(
            remoteCreate.status,
            'Remote backend refused terminal creation.',
          );
        }

        const payload = (await remoteCreate.response.json()) as {
          terminal?: unknown;
        };

        if (!payload.terminal) {
          throw new BackendRouteError(
            502,
            'Remote backend did not return a created terminal.',
          );
        }

        const remoteTerminal = terminalNodeSchema.parse(payload.terminal);

        if (
          workspace.terminals.some(
            (terminal) =>
              terminal.id === remoteTerminal.id &&
              terminal.backendId !== backend.id,
          )
        ) {
          throw new BackendRouteError(
            409,
            `Terminal id collision for ${remoteTerminal.id}.`,
          );
        }

        const imported: TerminalNode = {
          ...provisional,
          id: remoteTerminal.id,
          label: remoteTerminal.label,
          shell: remoteTerminal.shell,
          cwd: remoteTerminal.cwd,
          agentType: remoteTerminal.agentType,
          repoLabel: remoteTerminal.repoLabel ?? backend.label,
          taskLabel: remoteTerminal.taskLabel,
          tags: remoteTerminal.tags,
          backendId: backend.id,
        };
        const mergedTerminals = mergeRemoteTerminals(
          workspace.terminals,
          [imported],
          {
            backendId: backend.id,
            backendLabel: backend.label,
          },
        );
        const nextWorkspace = {
          ...workspace,
          terminals: mergedTerminals,
        };
        const savedWorkspace = await options.workspaceService.saveWorkspace(nextWorkspace);

        return {
          terminal:
            savedWorkspace.terminals.find(
              (terminal) => terminal.id === imported.id,
            ) ?? imported,
          workspace: savedWorkspace,
        };
      } catch (error) {
        if (!(error instanceof BackendRouteError)) {
          const message = describeNetworkError(error);
          const wrapped = new BackendRouteError(
            502,
            `Failed to create remote terminal. Last error: ${message}`,
          );

          return sendBackendError(
            reply,
            withTunnelStatusContext(wrapped, options.tunnelManager, backend.id),
          );
        }

        return sendBackendError(
          reply,
          withTunnelStatusContext(error, options.tunnelManager, backend.id),
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

      const rotateResult = await fetchRemoteJson(
        resolveUrl(backend.baseUrl, '/api/backend/machine/token/rotate'),
        backend.token,
        'POST',
      );

      if (!rotateResult.ok) {
        return reply.code(rotateResult.status).send({
          message: rotateResult.status === 401
            ? 'Remote backend rejected the token.'
            : 'Failed to rotate remote token.',
        });
      }

      const rotatePayload = (await rotateResult.response.json()) as { machineToken?: string };

      if (!rotatePayload.machineToken) {
        return reply.code(502).send({ message: 'Remote backend did not return a new token.' });
      }

      const nextWorkspace = {
        ...workspace,
        backends: workspace.backends.map((candidate) =>
          candidate.id === backend.id
            ? { ...candidate, token: rotatePayload.machineToken as string }
            : candidate,
        ),
      };
      const savedWorkspace = await options.workspaceService.saveWorkspace(nextWorkspace);

      return { backendId: backend.id, workspace: savedWorkspace };
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
      const savedWorkspace = await options.workspaceService.saveWorkspace(nextWorkspace);
      options.tunnelManager.removeTunnel(request.params.backendId);

      return {
        backendId: request.params.backendId,
        workspace: savedWorkspace,
      };
    },
  );
}

function buildBackendId(label: string, existingIds: readonly string[]): string {
  const base = label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'backend';
  const existing = new Set(existingIds);

  if (!existing.has(base)) {
    return base;
  }

  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}`;

    if (!existing.has(candidate)) {
      return candidate;
    }
  }

  return `${base}-${randomUUID()}`;
}

function mergeRemoteTerminals(
  existingTerminals: readonly TerminalNode[],
  remoteTerminals: readonly TerminalNode[],
  options: {
    backendId: string;
    backendLabel: string;
  },
): TerminalNode[] {
  const currentById = new Map(existingTerminals.map((terminal) => [terminal.id, terminal]));
  const next = [...existingTerminals];

  for (const remoteTerminal of remoteTerminals) {
    const imported: TerminalNode = {
      ...remoteTerminal,
      backendId: options.backendId,
      repoLabel: remoteTerminal.repoLabel ?? options.backendLabel,
    };
    const existing = currentById.get(imported.id);

    if (existing && existing.backendId !== options.backendId) {
      continue;
    }

    if (!existing) {
      next.push(imported);
      continue;
    }

    const index = next.findIndex((terminal) => terminal.id === imported.id);

    if (index >= 0) {
      next[index] = {
        ...existing,
        label: imported.label,
        shell: imported.shell,
        cwd: imported.cwd,
        agentType: imported.agentType,
        repoLabel: imported.repoLabel,
        taskLabel: imported.taskLabel,
        tags: imported.tags,
      };
    }
  }

  return next;
}

async function registerBackendConnection(input: {
  workspaceService: WorkspaceService;
  connection: BackendConnection;
  healthAttempts?: number;
  healthDelayMs?: number;
}): Promise<{
  workspace: Awaited<ReturnType<WorkspaceService['saveWorkspace']>>;
  backend: BackendConnection | null;
  importedTerminalCount: number;
}> {
  const workspace = input.workspaceService.getWorkspace();
  const baseUrl = normalizeBaseUrl(input.connection.baseUrl);
  const duplicate = workspace.backends.some(
    (backend) => normalizeBaseUrl(backend.baseUrl) === baseUrl,
  );

  if (duplicate) {
    throw new BackendRouteError(409, 'Backend URL is already configured.');
  }

  const remoteTerminals = await fetchRemoteTerminals({
    baseUrl,
    token: input.connection.token,
    healthAttempts: input.healthAttempts ?? 1,
    healthDelayMs: input.healthDelayMs ?? 0,
  });
  const importedTerminals = mergeRemoteTerminals(workspace.terminals, remoteTerminals, {
    backendId: input.connection.id,
    backendLabel: input.connection.label,
  });
  const nextWorkspace = {
    ...workspace,
    backends: [
      ...workspace.backends,
      {
        ...input.connection,
        baseUrl,
      },
    ],
    terminals: importedTerminals,
  };
  const savedWorkspace = await input.workspaceService.saveWorkspace(nextWorkspace);

  return {
    workspace: savedWorkspace,
    backend:
      savedWorkspace.backends.find((backend) => backend.id === input.connection.id) ??
      null,
    importedTerminalCount: importedTerminals.length - workspace.terminals.length,
  };
}

async function fetchRemoteTerminals(input: {
  baseUrl: string;
  token: string;
  healthAttempts: number;
  healthDelayMs: number;
}): Promise<TerminalNode[]> {
  let lastHealthStatus = 502;
  let lastHealthError: string | null = null;
  let healthOk = false;

  for (let attempt = 1; attempt <= input.healthAttempts; attempt += 1) {
    let health: Awaited<ReturnType<typeof fetchRemoteJson>> | null = null;

    try {
      health = await fetchRemoteJson(
        resolveUrl(input.baseUrl, '/api/backend/health'),
        input.token,
      );
    } catch (error) {
      lastHealthStatus = 502;
      lastHealthError = describeNetworkError(error);

      if (attempt < input.healthAttempts && input.healthDelayMs > 0) {
        await delay(input.healthDelayMs);
      }

      continue;
    }

    if (health.ok) {
      healthOk = true;
      lastHealthError = null;
      break;
    }

    lastHealthStatus = health.status;
    lastHealthError = null;

    if (health.status === 401) {
      throw new BackendRouteError(401, 'Remote backend rejected the token.');
    }

    if (attempt < input.healthAttempts && input.healthDelayMs > 0) {
      await delay(input.healthDelayMs);
    }
  }

  if (!healthOk) {
    const detail = lastHealthError ? lastHealthError : null;
    throw new BackendRouteError(
      lastHealthStatus,
      `Remote backend health check failed.${detail ? ` Last error: ${detail}` : ''}`,
    );
  }

  let remoteWorkspace: Awaited<ReturnType<typeof fetchRemoteJson>>;

  try {
    remoteWorkspace = await fetchRemoteJson(
      resolveUrl(input.baseUrl, '/api/backend/workspace'),
      input.token,
    );
  } catch (error) {
    const message = describeNetworkError(error);
    throw new BackendRouteError(
      502,
      `Failed to fetch the remote backend workspace. Last error: ${message}`,
    );
  }

  if (!remoteWorkspace.ok) {
    throw new BackendRouteError(
      remoteWorkspace.status,
      'Failed to fetch the remote backend workspace.',
    );
  }

  const remotePayload = (await remoteWorkspace.response.json()) as {
    terminals?: unknown[];
  };
  return Array.isArray(remotePayload.terminals)
    ? remotePayload.terminals.map((terminal) => terminalNodeSchema.parse(terminal))
    : [];
}

async function fetchRemoteJson(
  url: string,
  token: string,
  method = 'GET',
  body?: unknown,
): Promise<{
  ok: boolean;
  status: number;
  response: Response;
}> {
  const headers: Record<string, string> = {
    'x-terminal-canvas-token': token,
  };
  const requestInit: RequestInit = {
    method,
    headers,
  };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestInit.body = JSON.stringify(body);
  }

  const response = await fetch(url, {
    ...requestInit,
  });

  return {
    ok: response.ok,
    status: response.status,
    response,
  };
}

async function waitForTunnelReady(
  tunnelManager: SshTunnelManager,
  backendId: string,
): Promise<void> {
  const timeoutMs = 20_000;
  const pollMs = 250;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const status =
      tunnelManager
        .getTunnelStatuses()
        .find((candidate) => candidate.backendId === backendId) ?? null;

    if (status?.state === 'connected') {
      return;
    }

    if (status && (status.state === 'error' || status.state === 'disconnected')) {
      throw new BackendRouteError(
        502,
        `SSH tunnel failed for ${backendId}: ${status.lastError ?? status.state}.`,
      );
    }

    await delay(pollMs);
  }

  throw new BackendRouteError(
    504,
    `Timed out waiting for SSH tunnel ${backendId} to connect.`,
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

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function resolveUrl(baseUrl: string, path: string): string {
  return new URL(path, `${normalizeBaseUrl(baseUrl)}/`).toString();
}

function getHomeUrl(request: {
  headers: Record<string, unknown>;
  hostname: string;
}): string {
  const host = request.headers['x-forwarded-host'] ?? request.headers.host ?? request.hostname;
  const proto = request.headers['x-forwarded-proto'] ?? 'http';
  return `${String(proto)}://${String(host)}`;
}

async function findAvailablePort(preferredPort?: number): Promise<number> {
  if (preferredPort) {
    await assertPortAvailable(preferredPort);
    return preferredPort;
  }

  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        server.close(() => {
          reject(new Error('Unable to allocate local tunnel port.'));
        });
        return;
      }

      const port = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(port);
      });
    });
  });
}

async function assertPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', () => {
      reject(new BackendRouteError(409, `Local port ${port} is already in use.`));
    });
    server.listen(port, '127.0.0.1', () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = (error as Error & { cause?: unknown }).cause;

  if (!cause || typeof cause !== 'object') {
    return error.message;
  }

  const causeCode =
    'code' in cause && typeof (cause as { code?: unknown }).code === 'string'
      ? (cause as { code: string }).code
      : null;
  const causeMessage =
    'message' in cause && typeof (cause as { message?: unknown }).message === 'string'
      ? (cause as { message: string }).message
      : null;

  if (causeCode && causeMessage) {
    return `${error.message} (${causeCode}: ${causeMessage})`;
  }

  if (causeMessage) {
    return `${error.message} (${causeMessage})`;
  }

  if (causeCode) {
    return `${error.message} (${causeCode})`;
  }

  return error.message;
}

function withTunnelStatusContext(
  error: unknown,
  tunnelManager: SshTunnelManager,
  backendId: string,
): unknown {
  if (!(error instanceof BackendRouteError)) {
    return error;
  }

  const status =
    tunnelManager
      .getTunnelStatuses()
      .find((candidate) => candidate.backendId === backendId) ?? null;

  if (!status) {
    return error;
  }

  const suffix =
    ` Tunnel status: ${status.state}` +
    (status.lastError ? ` (${status.lastError})` : '');

  return new BackendRouteError(error.status, `${error.message}${suffix}`);
}

function sendBackendError(
  reply: FastifyReply,
  error: unknown,
) {
  if (error instanceof BackendRouteError) {
    return reply.code(error.status).send({ message: error.message });
  }

  const message = error instanceof Error ? error.message : 'Backend setup failed.';
  return reply.code(500).send({ message });
}

class BackendRouteError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
