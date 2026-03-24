import type { FastifyInstance } from 'fastify';

import {
  frontendSessionAcquireRequestSchema,
  frontendSessionReleaseRequestSchema,
  frontendSessionRenewRequestSchema,
} from '../../shared/frontendSessionTransport';
import type { FrontendLeaseManager } from '../frontend/frontendLeaseManager';
import { readFrontendLeaseAuth } from '../frontend/frontendLeaseAuth';

interface FrontendSessionRouteOptions {
  frontendLeaseManager: FrontendLeaseManager;
}

export async function registerFrontendSessionRoutes(
  app: FastifyInstance,
  options: FrontendSessionRouteOptions,
): Promise<void> {
  app.addHook('preValidation', async (request, reply) => {
    if (!requiresFrontendLease(request.url)) {
      return;
    }

    const validation = options.frontendLeaseManager.validate(
      readFrontendLeaseAuth(request),
    );

    if (!validation.ok) {
      return reply.code(423).send(validation.locked);
    }
  });

  app.get('/api/frontend-session', async (request) => {
    return options.frontendLeaseManager.getStatus(readFrontendLeaseAuth(request));
  });

  app.post('/api/frontend-session/acquire', async (request, reply) => {
    const body = frontendSessionAcquireRequestSchema.parse(request.body);
    const result = options.frontendLeaseManager.acquire(body);

    if (!result.ok) {
      return reply.code(423).send(result.locked);
    }

    return result.lease;
  });

  app.post('/api/frontend-session/renew', async (request, reply) => {
    const body = frontendSessionRenewRequestSchema.parse(request.body);
    const result = options.frontendLeaseManager.renew(body);

    if (!result.ok) {
      return reply.code(423).send(result.locked);
    }

    return result.lease;
  });

  app.post('/api/frontend-session/release', async (request) => {
    const body = frontendSessionReleaseRequestSchema.parse(request.body);

    return {
      released: options.frontendLeaseManager.release(body),
    };
  });
}

function requiresFrontendLease(url: string): boolean {
  const path = url.split('?')[0] ?? url;

  if (path === '/api/sessions') {
    return true;
  }

  if (path === '/api/filesystem/list') {
    return true;
  }

  if (
    path === '/api/attention/setup' ||
    path === '/api/attention/events' ||
    path === '/api/token/info' ||
    path === '/api/token/rotate'
  ) {
    return true;
  }

  if (path.startsWith('/api/workspace')) {
    return true;
  }

  if (path.startsWith('/api/markdown')) {
    return true;
  }

  if (path === '/api/backends' || path.startsWith('/api/backends/')) {
    return true;
  }

  return false;
}
