import type { FastifyInstance } from 'fastify';

import type { BackendRuntimeManager } from '../runtime/backendRuntimeManager';

interface SessionRouteOptions {
  runtimeManager: BackendRuntimeManager;
}

export async function registerSessionRoutes(
  app: FastifyInstance,
  options: SessionRouteOptions,
): Promise<void> {
  app.get('/api/sessions', async () => ({
    sessions: options.runtimeManager.getSnapshots(),
  }));
}
