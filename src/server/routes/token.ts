import type { FastifyInstance } from 'fastify';

import {
  loadOrCreateServerIdentity,
  rotateServerIdentityToken,
} from '../persistence/serverIdentityStore';

interface TokenRouteOptions {
  serverIdentityFilePath: string;
  serverId: string;
}

export async function registerTokenRoutes(
  app: FastifyInstance,
  options: TokenRouteOptions,
): Promise<void> {
  app.get('/api/token/info', async () => {
    const identity = await loadOrCreateServerIdentity(options.serverIdentityFilePath);

    return {
      tokenPreview: identity.machineToken.slice(0, 8),
      serverId: identity.serverId,
    };
  });

  app.post('/api/token/rotate', async () => {
    const identity = await rotateServerIdentityToken(options.serverIdentityFilePath);

    return {
      tokenPreview: identity.machineToken.slice(0, 8),
      serverId: identity.serverId,
    };
  });
}
