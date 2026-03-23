import type { FastifyBaseLogger } from 'fastify';

export {
  summarizeWorkspaceDiffForDebug,
  summarizeWorkspaceForDebug,
} from '../../shared/workspaceDebug';

const DEBUG_SESSION_HEADER = 'x-tsheet-debug-session';
const DEBUG_SESSION_QUERY_PARAM = 'debugSession';

export function getWorkspaceDebugSessionId(request: {
  headers?: Record<string, unknown>;
  query?: unknown;
}): string | null {
  const headerValue = normalizeDebugValue(
    request.headers?.[DEBUG_SESSION_HEADER],
  );

  if (headerValue) {
    return headerValue;
  }

  if (!request.query || typeof request.query !== 'object') {
    return null;
  }

  const query = request.query as Record<string, unknown>;
  return normalizeDebugValue(query[DEBUG_SESSION_QUERY_PARAM]);
}

export function logWorkspaceDebug(
  logger: FastifyBaseLogger,
  sessionId: string | null,
  event: string,
  details: Record<string, unknown>,
): void {
  if (!sessionId) {
    return;
  }

  logger.info(
    {
      component: 'workspace-debug',
      debugSession: sessionId,
      ...details,
    },
    event,
  );
}

function normalizeDebugValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

