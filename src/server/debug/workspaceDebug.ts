import type { FastifyBaseLogger } from 'fastify';

import type { Workspace } from '../../shared/workspace';

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

export function summarizeWorkspaceForDebug(
  workspace: Workspace | null | undefined,
): Record<string, unknown> | null {
  if (!workspace) {
    return null;
  }

  return {
    id: workspace.id,
    updatedAt: workspace.updatedAt,
    layoutMode: workspace.layoutMode,
    selectedNodeId: workspace.selectedNodeId,
    viewport: {
      x: roundForDebug(workspace.currentViewport.x),
      y: roundForDebug(workspace.currentViewport.y),
      zoom: roundForDebug(workspace.currentViewport.zoom),
    },
    terminalIds: workspace.terminals.map((terminal) => terminal.id),
    markdownIds: workspace.markdown.map((node) => node.id),
    terminalCount: workspace.terminals.length,
    markdownCount: workspace.markdown.length,
  };
}

export function summarizeWorkspaceDiffForDebug(
  previousWorkspace: Workspace | null | undefined,
  nextWorkspace: Workspace | null | undefined,
): Record<string, unknown> {
  return {
    updatedAtChanged:
      previousWorkspace?.updatedAt !== nextWorkspace?.updatedAt,
    layoutModeChanged:
      previousWorkspace?.layoutMode !== nextWorkspace?.layoutMode,
    layoutMode: {
      from: previousWorkspace?.layoutMode ?? null,
      to: nextWorkspace?.layoutMode ?? null,
    },
    selectedNodeId: {
      from: previousWorkspace?.selectedNodeId ?? null,
      to: nextWorkspace?.selectedNodeId ?? null,
    },
    viewportChanged: !sameViewportOrNull(
      previousWorkspace?.currentViewport ?? null,
      nextWorkspace?.currentViewport ?? null,
    ),
    terminalCount: {
      from: previousWorkspace?.terminals.length ?? 0,
      to: nextWorkspace?.terminals.length ?? 0,
    },
    markdownCount: {
      from: previousWorkspace?.markdown.length ?? 0,
      to: nextWorkspace?.markdown.length ?? 0,
    },
  };
}

function normalizeDebugValue(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim();
  return normalized || null;
}

function sameViewportOrNull(
  left:
    | {
        x: number;
        y: number;
        zoom: number;
      }
    | null,
  right:
    | {
        x: number;
        y: number;
        zoom: number;
      }
    | null,
): boolean {
  if (!left || !right) {
    return left === right;
  }

  return (
    almostEqual(left.x, right.x) &&
    almostEqual(left.y, right.y) &&
    almostEqual(left.zoom, right.zoom)
  );
}

function roundForDebug(value: number): number {
  return Number(value.toFixed(3));
}

function almostEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}
