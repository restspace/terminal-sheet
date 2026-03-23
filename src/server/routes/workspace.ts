import type { FastifyInstance } from 'fastify';

import { type Workspace, workspaceSchema } from '../../shared/workspace';
import {
  type WorkspaceCommandResponse,
  type WorkspaceMutationRequest,
  workspaceMutationRequestSchema,
} from '../../shared/workspaceCommands';
import { WORKSPACE_BASE_UPDATED_AT_HEADER } from '../../shared/workspaceTransport';
import {
  getWorkspaceDebugSessionId,
  logWorkspaceDebug,
  summarizeWorkspaceDiffForDebug,
  summarizeWorkspaceForDebug,
} from '../debug/workspaceDebug';
import type { WorkspaceService } from '../persistence/workspaceService';
import { WorkspaceCommitService } from '../workspace/workspaceCommitService';
import {
  WorkspaceCommandService,
  WorkspaceMutationError,
} from '../workspace/workspaceCommandService';

interface WorkspaceRouteOptions {
  workspaceService: WorkspaceService;
  workspaceCommitService: WorkspaceCommitService;
}

export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  options: WorkspaceRouteOptions,
): Promise<void> {
  const workspaceCommandService = new WorkspaceCommandService(
    options.workspaceCommitService,
  );

  app.get('/api/workspace', async (request) => {
    const debugSessionId = getWorkspaceDebugSessionId(request);
    const workspace = options.workspaceService.getWorkspace();
    logWorkspaceDebug(app.log, debugSessionId, 'workspace GET', {
      workspace: summarizeWorkspaceForDebug(workspace),
    });
    return workspace;
  });

  app.put<{ Body: Workspace }>(
    '/api/workspace',
    async (request, reply): Promise<Workspace | { message: string; workspace: Workspace }> => {
      const debugSessionId = getWorkspaceDebugSessionId(request);
      const currentWorkspace = options.workspaceService.getWorkspace();
      const baseUpdatedAt = readBaseUpdatedAtHeader(request.headers);
      const workspace = workspaceSchema.parse(request.body);

      if (!baseUpdatedAt) {
        logWorkspaceDebug(
          app.log,
          debugSessionId,
          'workspace PUT missing baseUpdatedAt',
          {
            currentWorkspace: summarizeWorkspaceForDebug(currentWorkspace),
            incomingWorkspace: summarizeWorkspaceForDebug(workspace),
          },
        );
        reply.code(428);
        return reply.send({
          message: 'Workspace save requires a base revision.',
          workspace: currentWorkspace,
        });
      }

      if (currentWorkspace.updatedAt !== baseUpdatedAt) {
        logWorkspaceDebug(app.log, debugSessionId, 'workspace PUT conflict', {
          currentWorkspace: summarizeWorkspaceForDebug(currentWorkspace),
          incomingWorkspace: summarizeWorkspaceForDebug(workspace),
          baseUpdatedAt,
        });
        reply.code(409);
        return reply.send({
          message: 'Workspace state is out of date.',
          workspace: currentWorkspace,
        });
      }

      logWorkspaceDebug(app.log, debugSessionId, 'workspace PUT request', {
        currentWorkspace: summarizeWorkspaceForDebug(currentWorkspace),
        incomingWorkspace: summarizeWorkspaceForDebug(workspace),
        diff: summarizeWorkspaceDiffForDebug(currentWorkspace, workspace),
        baseUpdatedAt,
      });
      const saved = await options.workspaceCommitService.commitWorkspace(workspace);
      logWorkspaceDebug(app.log, debugSessionId, 'workspace PUT saved', {
        savedWorkspace: summarizeWorkspaceForDebug(saved),
        diff: summarizeWorkspaceDiffForDebug(currentWorkspace, saved),
      });

      reply.code(200);
      return saved;
    },
  );

  app.post<{
    Body: WorkspaceMutationRequest;
  }>(
    '/api/workspace/mutations',
    async (
      request,
      reply,
    ): Promise<
      Workspace | WorkspaceCommandResponse | { message: string; workspace: Workspace }
    > => {
      const debugSessionId = getWorkspaceDebugSessionId(request);
      const currentWorkspace = options.workspaceService.getWorkspace();
      const body = workspaceMutationRequestSchema.parse(request.body);
      const baseUpdatedAt =
        readBaseUpdatedAtHeader(request.headers) ?? body.baseUpdatedAt;

      logWorkspaceDebug(app.log, debugSessionId, 'workspace POST mutations request', {
        currentWorkspace: summarizeWorkspaceForDebug(currentWorkspace),
        commands: body.commands,
        baseUpdatedAt,
      });

      try {
        const saved = await workspaceCommandService.applyCommands({
          baseUpdatedAt,
          commands: body.commands,
        });
        const commandResponse = buildWorkspaceCommandResponse(
          currentWorkspace,
          saved,
          body.commands,
        );

        logWorkspaceDebug(app.log, debugSessionId, 'workspace POST mutations saved', {
          savedWorkspace: summarizeWorkspaceForDebug(saved),
          diff: summarizeWorkspaceDiffForDebug(currentWorkspace, saved),
          commands: body.commands,
        });

        reply.code(200);
        return commandResponse ?? { workspace: saved };
      } catch (error) {
        if (error instanceof WorkspaceMutationError) {
          logWorkspaceDebug(
            app.log,
            debugSessionId,
            'workspace POST mutations rejected',
            {
              statusCode: error.statusCode,
              currentWorkspace: summarizeWorkspaceForDebug(currentWorkspace),
              serverWorkspace: summarizeWorkspaceForDebug(error.workspace),
              commands: body.commands,
              baseUpdatedAt,
            },
          );

          reply.code(error.statusCode);
          return reply.send({
            message: error.message,
            workspace: error.workspace,
          });
        }

        throw error;
      }
    },
  );
}

function readBaseUpdatedAtHeader(headers: Record<string, unknown>): string | null {
  const value = headers[WORKSPACE_BASE_UPDATED_AT_HEADER];

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function buildWorkspaceCommandResponse(
  previousWorkspace: Workspace,
  nextWorkspace: Workspace,
  commands: WorkspaceMutationRequest['commands'],
): WorkspaceCommandResponse | null {
  if (commands.length !== 1) {
    return null;
  }

  const [command] = commands;

  if (!command) {
    return null;
  }

  if (command.type === 'add-terminal') {
    const terminal = nextWorkspace.terminals.find(
      (candidate) =>
        !previousWorkspace.terminals.some((existing) => existing.id === candidate.id),
    );

    if (!terminal) {
      return null;
    }

    return {
      workspace: nextWorkspace,
      terminal,
    };
  }

  if (command.type === 'add-markdown') {
    const markdownNode = nextWorkspace.markdown.find(
      (candidate) =>
        !previousWorkspace.markdown.some((existing) => existing.id === candidate.id),
    );

    if (!markdownNode) {
      return null;
    }

    return {
      workspace: nextWorkspace,
      markdownNode,
    };
  }

  return null;
}
