import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { stateDebugEventBatchSchema } from '../../shared/debugState';
import { getWorkspaceDebugSessionId } from '../debug/workspaceDebug';
import type { StateDebugEventStore } from '../debug/stateDebugEventStore';

interface DebugStateRouteOptions {
  eventStore: StateDebugEventStore;
}

const debugStateQuerySchema = z.object({
  sessionId: z.string().trim().optional(),
});

export async function registerDebugStateRoutes(
  app: FastifyInstance,
  options: DebugStateRouteOptions,
): Promise<void> {
  app.post('/api/debug/state', async (request, reply) => {
    const debugSessionId = getWorkspaceDebugSessionId(request);
    const body = stateDebugEventBatchSchema.parse(request.body);
    const sessionId = body.sessionId?.trim() || debugSessionId;

    if (!sessionId || body.events.length === 0) {
      return reply.code(202).send({
        accepted: false,
        reason: 'missing-session-or-events',
      });
    }

    options.eventStore.append(sessionId, body.events);
    app.log.info(
      {
        component: 'client-state-debug',
        debugSession: sessionId,
        eventCount: body.events.length,
        lastEvent: body.events.at(-1)?.event ?? null,
        lastScope: body.events.at(-1)?.scope ?? null,
      },
      'state debug batch received',
    );

    return reply.code(202).send({
      accepted: true,
      sessionId,
      eventCount: body.events.length,
    });
  });

  app.get('/api/debug/state', async (request) => {
    const query = debugStateQuerySchema.parse(request.query);
    const sessionId = query.sessionId?.trim() || null;
    const sessions = options.eventStore.listSessions();

    if (!sessionId) {
      return {
        sessions,
      };
    }

    return {
      sessions,
      sessionId,
      events: options.eventStore.getEvents(sessionId),
    };
  });
}
