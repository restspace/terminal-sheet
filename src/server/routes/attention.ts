import type { FastifyInstance } from 'fastify';

import type { AttentionService } from '../integrations/attentionService';
import type { PtySessionManager } from '../pty/ptySessionManager';

interface AttentionRouteOptions {
  attentionService: AttentionService;
  ptySessionManager: PtySessionManager;
}

export async function registerAttentionRoutes(
  app: FastifyInstance,
  options: AttentionRouteOptions,
): Promise<void> {
  app.get('/api/attention/setup', async () => options.attentionService.getSetup());

  app.get('/api/attention/events', async () => ({
    events: options.attentionService.getEvents(),
  }));

  app.post('/api/attention/:source', async (request, reply) => {
    const token = readToken(request);

    if (!options.attentionService.validateToken(token)) {
      return reply.code(401).send({ message: 'Invalid attention token' });
    }

    const source = readSourceParam(request.params);

    if (!source) {
      return reply.code(404).send({ message: 'Unknown attention source' });
    }

    const sessionIdOverride = readSessionId(request);
    const event = options.attentionService.ingestExternalEvent(
      source,
      request.body,
      sessionIdOverride,
    );

    if (!event) {
      return reply.code(400).send({ message: 'Invalid attention payload' });
    }

    if (!options.ptySessionManager.applyAttentionEvent(event)) {
      return reply.code(404).send({
        message: `Unknown session: ${event.sessionId}`,
      });
    }

    return {
      ok: true,
      event,
    };
  });
}

function readToken(request: {
  headers: Record<string, unknown>;
  query: unknown;
}): string | null {
  const headerToken = request.headers['x-terminal-canvas-token'];

  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }

  if (Array.isArray(headerToken) && typeof headerToken[0] === 'string') {
    return headerToken[0];
  }

  if (
    request.query &&
    typeof request.query === 'object' &&
    'token' in request.query &&
    typeof (request.query as Record<string, unknown>).token === 'string'
  ) {
    return String((request.query as Record<string, unknown>).token);
  }

  return null;
}

function readSessionId(request: {
  headers: Record<string, unknown>;
  query: unknown;
}): string | undefined {
  const headerSessionId = request.headers['x-terminal-canvas-session-id'];

  if (typeof headerSessionId === 'string' && headerSessionId.trim()) {
    return headerSessionId.trim();
  }

  if (
    request.query &&
    typeof request.query === 'object' &&
    'sessionId' in request.query &&
    typeof (request.query as Record<string, unknown>).sessionId === 'string'
  ) {
    return String((request.query as Record<string, unknown>).sessionId);
  }

  return undefined;
}

function readSourceParam(
  params: unknown,
): 'claude' | 'codex' | null {
  if (!params || typeof params !== 'object') {
    return null;
  }

  const source = (params as Record<string, unknown>).source;

  if (source === 'claude' || source === 'codex') {
    return source;
  }

  return null;
}
