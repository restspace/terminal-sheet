import type { FastifyInstance } from 'fastify';

import type { PtySessionManager } from '../pty/ptySessionManager';

interface HealthRouteOptions {
  port: number;
  workspaceFilePath: string;
  devWebUrl?: string;
  ptySessionManager: PtySessionManager;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions,
): Promise<void> {
  app.get('/api/health', async () => ({
    status: 'ok',
    port: options.port,
    workspacePath: options.workspaceFilePath,
    devMode: Boolean(options.devWebUrl),
    liveSessions: options.ptySessionManager.getSnapshots().filter(
      (session) => session.connected,
    ).length,
    timestamp: new Date().toISOString(),
  }));
}
