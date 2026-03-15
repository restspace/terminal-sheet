import { randomUUID } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import {
  backendCreateRequestSchema,
  type ServerRole,
} from '../../shared/backends';
import { terminalNodeSchema, type TerminalNode } from '../../shared/workspace';
import type { WorkspaceService } from '../persistence/workspaceService';
import type { BackendRuntimeManager } from '../runtime/backendRuntimeManager';

interface BackendRouteOptions {
  role: ServerRole;
  workspaceService: WorkspaceService;
  runtimeManager: BackendRuntimeManager;
}

export async function registerBackendRoutes(
  app: FastifyInstance,
  options: BackendRouteOptions,
): Promise<void> {
  app.get('/api/backends', async () => {
    const workspace = options.workspaceService.getWorkspace();
    const statuses = new Map(
      options.runtimeManager.getBackendStatuses().map((status) => [status.id, status]),
    );

    return {
      backends: workspace.backends.map((backend) => ({
        ...backend,
        status: statuses.get(backend.id) ?? null,
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
    const baseUrl = normalizeBaseUrl(body.baseUrl);

    if (workspace.backends.some((backend) => normalizeBaseUrl(backend.baseUrl) === baseUrl)) {
      return reply.code(409).send({ message: 'Backend URL is already configured.' });
    }

    const health = await fetchRemoteJson(resolveUrl(baseUrl, '/api/backend/health'), body.token);

    if (!health.ok) {
      return reply.code(health.status).send({
        message: health.status === 401 ? 'Remote backend rejected the token.' : 'Remote backend health check failed.',
      });
    }

    const remoteWorkspace = await fetchRemoteJson(
      resolveUrl(baseUrl, '/api/backend/workspace'),
      body.token,
    );

    if (!remoteWorkspace.ok) {
      return reply.code(remoteWorkspace.status).send({
        message: 'Failed to fetch the remote backend workspace.',
      });
    }

    const remotePayload = (await remoteWorkspace.response.json()) as {
      terminals?: unknown[];
    };
    const remoteTerminals = Array.isArray(remotePayload.terminals)
      ? remotePayload.terminals.map((terminal) => terminalNodeSchema.parse(terminal))
      : [];
    const backendId = buildBackendId(body.label, workspace.backends.map((backend) => backend.id));
    const importedTerminals = mergeRemoteTerminals(workspace.terminals, remoteTerminals, {
      backendId,
      backendLabel: body.label,
    });

    const nextWorkspace = {
      ...workspace,
      backends: [
        ...workspace.backends,
        {
          id: backendId,
          label: body.label.trim(),
          baseUrl,
          token: body.token.trim(),
          enabled: true,
        },
      ],
      terminals: importedTerminals,
    };
    const savedWorkspace = await options.workspaceService.saveWorkspace(nextWorkspace);

    return {
      backend: savedWorkspace.backends.find((backend) => backend.id === backendId) ?? null,
      importedTerminalCount: importedTerminals.length - workspace.terminals.length,
      workspace: savedWorkspace,
    };
  });

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

async function fetchRemoteJson(
  url: string,
  token: string,
): Promise<{
  ok: boolean;
  status: number;
  response: Response;
}> {
  const response = await fetch(url, {
    headers: {
      'x-terminal-canvas-token': token,
    },
  });

  return {
    ok: response.ok,
    status: response.status,
    response,
  };
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

function resolveUrl(baseUrl: string, path: string): string {
  return new URL(path, `${normalizeBaseUrl(baseUrl)}/`).toString();
}
