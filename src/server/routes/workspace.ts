import type { FastifyInstance } from 'fastify';

import { type Workspace, workspaceSchema } from '../../shared/workspace';
import { WORKSPACE_BASE_UPDATED_AT_HEADER } from '../../shared/workspaceTransport';
import {
  getWorkspaceDebugSessionId,
  logWorkspaceDebug,
  summarizeWorkspaceDiffForDebug,
  summarizeWorkspaceForDebug,
} from '../debug/workspaceDebug';
import type { WorkspaceService } from '../persistence/workspaceService';

interface WorkspaceRouteOptions {
  workspaceService: WorkspaceService;
}

export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  options: WorkspaceRouteOptions,
): Promise<void> {
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

      if (
        currentWorkspace.updatedAt !== baseUpdatedAt
      ) {
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
      const saved = await options.workspaceService.saveWorkspace(workspace);
      logWorkspaceDebug(app.log, debugSessionId, 'workspace PUT saved', {
        savedWorkspace: summarizeWorkspaceForDebug(saved),
        diff: summarizeWorkspaceDiffForDebug(currentWorkspace, saved),
      });

      reply.code(200);
      return saved;
    },
  );
}

function readBaseUpdatedAtHeader(
  headers: Record<string, unknown>,
): string | null {
  const value = headers[WORKSPACE_BASE_UPDATED_AT_HEADER];

  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}
