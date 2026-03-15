import type { FastifyInstance } from 'fastify';

import type { ServerRole } from '../../shared/backends';
import type { AttentionService } from '../integrations/attentionService';
import type { BackendRuntimeManager } from '../runtime/backendRuntimeManager';

interface HealthRouteOptions {
  port: number;
  role: ServerRole;
  serverId: string;
  localBackendId: string;
  workspaceFilePath: string;
  devWebUrl?: string;
  runtimeManager: BackendRuntimeManager;
  attentionService: AttentionService;
}

export async function registerHealthRoutes(
  app: FastifyInstance,
  options: HealthRouteOptions,
): Promise<void> {
  app.get('/api/health', async () => ({
    status: 'ok',
    port: options.port,
    role: options.role,
    serverId: options.serverId,
    localBackendId: options.localBackendId,
    workspacePath: options.workspaceFilePath,
    devMode: Boolean(options.devWebUrl),
    liveSessions: options.runtimeManager.getSnapshots().filter(
      (session) => session.connected,
    ).length,
    attentionEvents: options.runtimeManager.getAttentionEvents().length,
    backends: options.runtimeManager.getBackendStatuses(),
    attentionReceiverUrl: options.attentionService.getSetup().receiverUrl,
    timestamp: new Date().toISOString(),
  }));
}
