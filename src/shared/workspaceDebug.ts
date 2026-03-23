import type { CameraViewport, Workspace } from './workspace';

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
    viewport: summarizeViewportForDebug(workspace.currentViewport),
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
    updatedAtChanged: previousWorkspace?.updatedAt !== nextWorkspace?.updatedAt,
    layoutModeChanged: previousWorkspace?.layoutMode !== nextWorkspace?.layoutMode,
    layoutMode: describeChange(
      previousWorkspace?.layoutMode ?? null,
      nextWorkspace?.layoutMode ?? null,
    ),
    viewportChanged: !sameViewportOrNull(
      previousWorkspace?.currentViewport ?? null,
      nextWorkspace?.currentViewport ?? null,
    ),
    viewport: describeChange(
      summarizeViewportForDebug(previousWorkspace?.currentViewport ?? null),
      summarizeViewportForDebug(nextWorkspace?.currentViewport ?? null),
    ),
    terminalIdsChanged: !sameStringArray(
      previousWorkspace?.terminals.map((terminal) => terminal.id) ?? [],
      nextWorkspace?.terminals.map((terminal) => terminal.id) ?? [],
    ),
    markdownIdsChanged: !sameStringArray(
      previousWorkspace?.markdown.map((node) => node.id) ?? [],
      nextWorkspace?.markdown.map((node) => node.id) ?? [],
    ),
    terminalCount: describeChange(
      previousWorkspace?.terminals.length ?? 0,
      nextWorkspace?.terminals.length ?? 0,
    ),
    markdownCount: describeChange(
      previousWorkspace?.markdown.length ?? 0,
      nextWorkspace?.markdown.length ?? 0,
    ),
  };
}

function summarizeViewportForDebug(
  viewport: CameraViewport | null,
): Record<string, number> | null {
  if (!viewport) {
    return null;
  }

  return {
    x: roundForDebug(viewport.x),
    y: roundForDebug(viewport.y),
    zoom: roundForDebug(viewport.zoom),
  };
}

function sameViewportOrNull(
  left: CameraViewport | null,
  right: CameraViewport | null,
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

function sameStringArray(
  left: readonly string[],
  right: readonly string[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function describeChange<T>(from: T, to: T): { from: T; to: T } {
  return { from, to };
}

function roundForDebug(value: number): number {
  return Number(value.toFixed(3));
}

function almostEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}
