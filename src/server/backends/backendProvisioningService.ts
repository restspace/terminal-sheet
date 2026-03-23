import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';

import {
  createTerminalNode,
  terminalNodeSchema,
  type TerminalNode,
  type Workspace,
} from '../../shared/workspace';
import type { BackendConnection } from '../../shared/backends';
import type { WorkspaceCommitService } from '../workspace/workspaceCommitService';
import type { SshTunnelManager } from '../runtime/sshTunnelManager';
import {
  buildRemoteTerminalCreateError,
  extractRemoteErrorMessage,
  shouldRetryTerminalIdCollision,
} from '../routes/remoteTerminalCreateError';
import {
  describeNetworkError,
  fetchRemoteJson,
  normalizeBaseUrl,
  resolveUrl,
} from './remoteBackendClient';

export class BackendProvisioningError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface RegisterConnectionResult {
  workspace: Workspace;
  backend: BackendConnection | null;
  importedTerminalCount: number;
}

export interface CreateRemoteTerminalRequest {
  label: string;
  shell: string;
  cwd: string;
  agentType: 'claude' | 'codex' | 'shell';
  repoLabel?: string;
  taskLabel?: string;
  tags: string[];
}

export interface CreateRemoteTerminalResult {
  workspace: Workspace;
  terminal: TerminalNode;
}

export class BackendProvisioningService {
  constructor(
    private readonly workspaceCommitService: WorkspaceCommitService,
    private readonly tunnelManager: SshTunnelManager,
  ) {}

  buildBackendId(label: string, existingIds: readonly string[]): string {
    const base =
      label
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

  async registerBackendConnection(options: {
    connection: BackendConnection;
    healthAttempts?: number;
    healthDelayMs?: number;
  }): Promise<RegisterConnectionResult> {
    const workspace = this.workspaceCommitService.getWorkspace();
    const baseUrl = normalizeBaseUrl(options.connection.baseUrl);
    const duplicate = workspace.backends.some(
      (backend) => normalizeBaseUrl(backend.baseUrl) === baseUrl,
    );

    if (duplicate) {
      throw new BackendProvisioningError(409, 'Backend URL is already configured.');
    }

    const remoteTerminals = await this.fetchRemoteTerminals({
      baseUrl,
      token: options.connection.token,
      healthAttempts: options.healthAttempts ?? 1,
      healthDelayMs: options.healthDelayMs ?? 0,
    });
    const importedTerminals = mergeRemoteTerminals(workspace.terminals, remoteTerminals, {
      backendId: options.connection.id,
      backendLabel: options.connection.label,
    });
    const nextWorkspace: Workspace = {
      ...workspace,
      backends: [...workspace.backends, { ...options.connection, baseUrl }],
      terminals: importedTerminals,
    };
    const savedWorkspace = await this.workspaceCommitService.commitWorkspace(nextWorkspace);

    return {
      workspace: savedWorkspace,
      backend:
        savedWorkspace.backends.find((backend) => backend.id === options.connection.id) ?? null,
      importedTerminalCount: importedTerminals.length - workspace.terminals.length,
    };
  }

  async createRemoteTerminal(
    backend: BackendConnection,
    request: CreateRemoteTerminalRequest,
  ): Promise<CreateRemoteTerminalResult> {
    const workspace = this.workspaceCommitService.getWorkspace();
    const maxAttempts = 3;
    let provisional: TerminalNode | null = null;
    let remoteTerminal: TerminalNode | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      provisional = createTerminalNode(
        {
          label: request.label,
          shell: request.shell,
          cwd: request.cwd,
          agentType: request.agentType,
          backendId: backend.id,
          repoLabel: request.repoLabel,
          taskLabel: request.taskLabel,
          tags: request.tags,
        },
        workspace.terminals.length,
        workspace.currentViewport,
      );

      const remoteCreate = await fetchRemoteJson(
        resolveUrl(backend.baseUrl, '/api/backend/terminals'),
        backend.token,
        'POST',
        {
          id: provisional.id,
          label: request.label,
          shell: request.shell,
          cwd: request.cwd,
          agentType: request.agentType,
          repoLabel: request.repoLabel,
          taskLabel: request.taskLabel,
          tags: request.tags,
        },
      );

      if (!remoteCreate.ok) {
        if (remoteCreate.status === 401) {
          throw new BackendProvisioningError(401, 'Remote backend rejected the token.');
        }

        const remoteMessage = await extractRemoteErrorMessage(remoteCreate.response);

        if (shouldRetryTerminalIdCollision(remoteCreate.status) && attempt < maxAttempts) {
          continue;
        }

        throw new BackendProvisioningError(
          remoteCreate.status,
          buildRemoteTerminalCreateError(remoteCreate.status, remoteMessage),
        );
      }

      const payload = (await remoteCreate.response.json()) as { terminal?: unknown };

      if (!payload.terminal) {
        throw new BackendProvisioningError(
          502,
          'Remote backend did not return a created terminal.',
        );
      }

      remoteTerminal = terminalNodeSchema.parse(payload.terminal);
      break;
    }

    if (!provisional || !remoteTerminal) {
      throw new BackendProvisioningError(502, 'Remote backend did not return a created terminal.');
    }

    const createdRemoteTerminal = remoteTerminal;

    if (
      workspace.terminals.some(
        (terminal) =>
          terminal.id === createdRemoteTerminal.id && terminal.backendId !== backend.id,
      )
    ) {
      throw new BackendProvisioningError(
        409,
        `Terminal id collision for ${createdRemoteTerminal.id}.`,
      );
    }

    const imported: TerminalNode = {
      ...provisional,
      id: createdRemoteTerminal.id,
      label: createdRemoteTerminal.label,
      shell: createdRemoteTerminal.shell,
      cwd: createdRemoteTerminal.cwd,
      agentType: createdRemoteTerminal.agentType,
      repoLabel: createdRemoteTerminal.repoLabel ?? backend.label,
      taskLabel: createdRemoteTerminal.taskLabel,
      tags: createdRemoteTerminal.tags,
      backendId: backend.id,
    };
    const mergedTerminals = mergeRemoteTerminals(workspace.terminals, [imported], {
      backendId: backend.id,
      backendLabel: backend.label,
    });
    const nextWorkspace: Workspace = { ...workspace, terminals: mergedTerminals };
    const savedWorkspace = await this.workspaceCommitService.commitWorkspace(nextWorkspace);

    return {
      terminal: savedWorkspace.terminals.find((t) => t.id === imported.id) ?? imported,
      workspace: savedWorkspace,
    };
  }

  async waitForTunnelReady(backendId: string): Promise<void> {
    const timeoutMs = 20_000;
    const pollMs = 250;
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const status =
        this.tunnelManager
          .getTunnelStatuses()
          .find((candidate) => candidate.backendId === backendId) ?? null;

      if (status?.state === 'connected') {
        return;
      }

      if (status && (status.state === 'error' || status.state === 'disconnected')) {
        throw new BackendProvisioningError(
          502,
          `SSH tunnel failed for ${backendId}: ${status.lastError ?? status.state}.`,
        );
      }

      await delay(pollMs);
    }

    throw new BackendProvisioningError(
      504,
      `Timed out waiting for SSH tunnel ${backendId} to connect.`,
    );
  }

  async rotateBackendToken(
    backend: BackendConnection,
  ): Promise<{ workspace: Workspace }> {
    const workspace = this.workspaceCommitService.getWorkspace();
    const rotateResult = await fetchRemoteJson(
      resolveUrl(backend.baseUrl, '/api/backend/machine/token/rotate'),
      backend.token,
      'POST',
    );

    if (!rotateResult.ok) {
      throw new BackendProvisioningError(
        rotateResult.status,
        rotateResult.status === 401
          ? 'Remote backend rejected the token.'
          : 'Failed to rotate remote token.',
      );
    }

    const rotatePayload = (await rotateResult.response.json()) as { machineToken?: string };

    if (!rotatePayload.machineToken) {
      throw new BackendProvisioningError(502, 'Remote backend did not return a new token.');
    }

    const nextWorkspace: Workspace = {
      ...workspace,
      backends: workspace.backends.map((candidate) =>
        candidate.id === backend.id
          ? { ...candidate, token: rotatePayload.machineToken as string }
          : candidate,
      ),
    };
    const savedWorkspace = await this.workspaceCommitService.commitWorkspace(nextWorkspace);

    return { workspace: savedWorkspace };
  }

  enrichErrorWithTunnelStatus(error: unknown, backendId: string): unknown {
    if (!(error instanceof BackendProvisioningError)) {
      return error;
    }

    const status =
      this.tunnelManager
        .getTunnelStatuses()
        .find((candidate) => candidate.backendId === backendId) ?? null;

    if (!status) {
      return error;
    }

    const suffix =
      ` Tunnel status: ${status.state}` + (status.lastError ? ` (${status.lastError})` : '');

    return new BackendProvisioningError(error.status, `${error.message}${suffix}`);
  }

  private async fetchRemoteTerminals(input: {
    baseUrl: string;
    token: string;
    healthAttempts: number;
    healthDelayMs: number;
  }): Promise<TerminalNode[]> {
    let lastHealthStatus = 502;
    let lastHealthError: string | null = null;
    let healthOk = false;

    for (let attempt = 1; attempt <= input.healthAttempts; attempt += 1) {
      let health: { ok: boolean; status: number; response: Response } | null = null;

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
        throw new BackendProvisioningError(401, 'Remote backend rejected the token.');
      }

      if (attempt < input.healthAttempts && input.healthDelayMs > 0) {
        await delay(input.healthDelayMs);
      }
    }

    if (!healthOk) {
      const detail = lastHealthError;
      throw new BackendProvisioningError(
        lastHealthStatus,
        `Remote backend health check failed.${detail ? ` Last error: ${detail}` : ''}`,
      );
    }

    let remoteWorkspaceResult: { ok: boolean; status: number; response: Response };

    try {
      remoteWorkspaceResult = await fetchRemoteJson(
        resolveUrl(input.baseUrl, '/api/backend/workspace'),
        input.token,
      );
    } catch (error) {
      const message = describeNetworkError(error);
      throw new BackendProvisioningError(
        502,
        `Failed to fetch the remote backend workspace. Last error: ${message}`,
      );
    }

    if (!remoteWorkspaceResult.ok) {
      throw new BackendProvisioningError(
        remoteWorkspaceResult.status,
        'Failed to fetch the remote backend workspace.',
      );
    }

    const remotePayload = (await remoteWorkspaceResult.response.json()) as {
      terminals?: unknown[];
    };

    return Array.isArray(remotePayload.terminals)
      ? remotePayload.terminals.map((terminal) => terminalNodeSchema.parse(terminal))
      : [];
  }
}

export function mergeRemoteTerminals(
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

export async function findAvailablePort(preferredPort?: number): Promise<number> {
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

export async function assertPortAvailable(port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', () => {
      reject(new BackendProvisioningError(409, `Local port ${port} is already in use.`));
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
