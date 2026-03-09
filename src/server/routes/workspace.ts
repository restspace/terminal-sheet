import type { FastifyInstance } from 'fastify';

import { type Workspace, workspaceSchema } from '../../shared/workspace';
import type { WorkspaceService } from '../persistence/workspaceService';

interface WorkspaceRouteOptions {
  workspaceService: WorkspaceService;
}

export async function registerWorkspaceRoutes(
  app: FastifyInstance,
  options: WorkspaceRouteOptions,
): Promise<void> {
  app.get('/api/workspace', async () => {
    return options.workspaceService.getWorkspace();
  });

  app.put<{ Body: Workspace }>(
    '/api/workspace',
    async (request, reply): Promise<Workspace> => {
      const workspace = workspaceSchema.parse(request.body);
      const saved = await options.workspaceService.saveWorkspace(workspace);

      reply.code(200);
      return saved;
    },
  );
}
