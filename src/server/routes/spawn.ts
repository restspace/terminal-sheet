import type { FastifyInstance } from 'fastify';

import {
  type SpawnRequest,
  type SpawnResponse,
  type SpawnWaitResponse,
  type SpawnReadResponse,
  type SpawnResultPayload,
  type SpawnResultResponse,
  spawnRequestSchema,
  spawnResultPayloadSchema,
} from '../../shared/spawnProtocol';
import type { AttentionService } from '../integrations/attentionService';
import type { WorkspaceService } from '../persistence/workspaceService';
import type { BackendRuntimeManager } from '../runtime/backendRuntimeManager';
import { WorkspaceCommitService } from '../workspace/workspaceCommitService';
import {
  WorkspaceCommandService,
  WorkspaceMutationError,
} from '../workspace/workspaceCommandService';
import { readMachineToken } from './machineAuth';
import type { TerminalNode } from '../../shared/workspace';

const MAX_SPAWN_RETRIES = 3;
const DEFAULT_WAIT_TIMEOUT_S = 300;
const MAX_WAIT_TIMEOUT_S = 600;

interface SpawnRouteOptions {
  attentionService: AttentionService;
  workspaceService: WorkspaceService;
  workspaceCommitService: WorkspaceCommitService;
  runtimeManager: BackendRuntimeManager;
}

export async function registerSpawnRoutes(
  app: FastifyInstance,
  options: SpawnRouteOptions,
): Promise<void> {
  const workspaceCommandService = new WorkspaceCommandService(
    options.workspaceCommitService,
  );
  const resultStore = new Map<string, unknown>();

  app.post<{ Body: SpawnRequest }>('/api/spawn', async (request, reply) => {
    const token = readMachineToken(request);

    if (!options.attentionService.validateToken(token)) {
      return reply.code(401).send({ message: 'Invalid token' });
    }

    const parentSessionId = readSessionIdHeader(request.headers);
    const body = spawnRequestSchema.parse(request.body);
    const label = body.label || truncateCommand(body.command);

    for (let attempt = 0; attempt < MAX_SPAWN_RETRIES; attempt++) {
      const workspace = options.workspaceService.getWorkspace();

      const parentTerminal = parentSessionId
        ? workspace.terminals.find((t) => t.id === parentSessionId)
        : undefined;

      const parentTerminalId = parentTerminal?.id;
      const spawnGroup = parentTerminal
        ? parentTerminal.spawnGroup ?? parentTerminal.id
        : undefined;

      try {
        const saved = await workspaceCommandService.applyCommands({
          baseUpdatedAt: workspace.updatedAt,
          commands: [
            {
              type: 'add-terminal' as const,
              input: {
                label,
                shell: body.command,
                cwd: body.cwd ?? resolveCwd(parentTerminal, options),
                agentType: body.agentType ?? 'shell',
                backendId: parentTerminal?.backendId,
                tags: body.tags,
                parentTerminalId,
                spawnGroup,
              },
            },
          ],
        });

        const newTerminal = saved.terminals.find(
          (t) =>
            !workspace.terminals.some((existing) => existing.id === t.id),
        );

        if (!newTerminal) {
          return reply.code(500).send({ message: 'Terminal creation failed' });
        }

        const response: SpawnResponse = {
          ok: true,
          terminalId: newTerminal.id,
          sessionId: newTerminal.id,
        };

        return response;
      } catch (error) {
        if (
          error instanceof WorkspaceMutationError &&
          error.statusCode === 409 &&
          attempt < MAX_SPAWN_RETRIES - 1
        ) {
          continue;
        }

        throw error;
      }
    }

    return reply.code(409).send({ message: 'Workspace conflict after retries' });
  });

  app.get<{
    Params: { terminalId: string };
    Querystring: { timeout?: string };
  }>('/api/spawn/:terminalId/wait', async (request, reply) => {
    const token = readMachineToken(request);

    if (!options.attentionService.validateToken(token)) {
      return reply.code(401).send({ message: 'Invalid token' });
    }

    const { terminalId } = request.params;
    const timeoutS = Math.min(
      Math.max(1, Number(request.query.timeout) || DEFAULT_WAIT_TIMEOUT_S),
      MAX_WAIT_TIMEOUT_S,
    );

    const terminal = options.workspaceService
      .getWorkspace()
      .terminals.find((candidate) => candidate.id === terminalId);

    if (!terminal) {
      return reply.code(404).send({ message: 'Session not found' });
    }

    return new Promise<SpawnWaitResponse>((resolve) => {
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let unsubscribe = () => {};

      const finish = (response: SpawnWaitResponse): void => {
        if (settled) {
          return;
        }

        settled = true;
        if (timeout) {
          clearTimeout(timeout);
        }
        unsubscribe();
        resolve(response);
      };

      unsubscribe = options.runtimeManager.subscribeSession((message) => {
        if (
          message.type === 'session.snapshot' &&
          message.session.sessionId === terminalId &&
          message.session.exitCode !== null
        ) {
          finish({
            terminalId,
            exitCode: message.session.exitCode,
            timedOut: false,
          });
        }
      });

      const existingSnapshot = options.runtimeManager
        .getSnapshots()
        .find((snapshot) => snapshot.sessionId === terminalId);
      const existingExitCode = existingSnapshot?.exitCode;
      if (existingExitCode !== null && existingExitCode !== undefined) {
        finish({
          terminalId,
          exitCode: existingExitCode,
          timedOut: false,
        });
        return;
      }

      timeout = setTimeout(() => {
        finish({ terminalId, exitCode: null, timedOut: true });
      }, timeoutS * 1000);
    });
  });

  app.get<{ Params: { terminalId: string } }>(
    '/api/spawn/:terminalId/read',
    async (request, reply) => {
      const token = readMachineToken(request);

      if (!options.attentionService.validateToken(token)) {
        return reply.code(401).send({ message: 'Invalid token' });
      }

      const { terminalId } = request.params;
      const snapshot = options.runtimeManager
        .getSnapshots()
        .find((s) => s.sessionId === terminalId);

      if (!snapshot) {
        return reply.code(404).send({ message: 'Session not found' });
      }

      const response: SpawnReadResponse = {
        terminalId,
        scrollback: snapshot.scrollback,
        lastOutputLine: snapshot.lastOutputLine,
        exitCode: snapshot.exitCode,
      };

      return response;
    },
  );

  app.post<{ Params: { terminalId: string }; Body: SpawnResultPayload }>(
    '/api/spawn/:terminalId/result',
    async (request, reply) => {
      const token = readMachineToken(request);

      if (!options.attentionService.validateToken(token)) {
        return reply.code(401).send({ message: 'Invalid token' });
      }

      const { terminalId } = request.params;
      const terminal = options.workspaceService
        .getWorkspace()
        .terminals.find((t) => t.id === terminalId);

      if (!terminal) {
        return reply.code(404).send({ message: 'Terminal not found' });
      }

      const body = spawnResultPayloadSchema.parse(request.body);
      resultStore.set(terminalId, body.data);

      return { ok: true, terminalId };
    },
  );

  app.get<{ Params: { terminalId: string } }>(
    '/api/spawn/:terminalId/result',
    async (request, reply) => {
      const token = readMachineToken(request);

      if (!options.attentionService.validateToken(token)) {
        return reply.code(401).send({ message: 'Invalid token' });
      }

      const { terminalId } = request.params;

      if (!resultStore.has(terminalId)) {
        const response: SpawnResultResponse = {
          terminalId,
          hasResult: false,
        };

        return response;
      }

      const response: SpawnResultResponse = {
        terminalId,
        hasResult: true,
        data: resultStore.get(terminalId),
      };

      return response;
    },
  );
}

function readSessionIdHeader(
  headers: Record<string, unknown>,
): string | undefined {
  const value = headers['x-terminal-canvas-session-id'];

  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }

  return undefined;
}

function resolveCwd(
  parentTerminal: TerminalNode | undefined,
  options: SpawnRouteOptions,
): string {
  if (!parentTerminal) {
    return '.';
  }

  const snapshot = options.runtimeManager
    .getSnapshots()
    .find((s) => s.sessionId === parentTerminal.id);

  return snapshot?.liveCwd ?? parentTerminal.cwd ?? '.';
}

function truncateCommand(command: string): string {
  const maxLength = 40;

  if (command.length <= maxLength) {
    return command;
  }

  return `${command.slice(0, maxLength - 3)}...`;
}
