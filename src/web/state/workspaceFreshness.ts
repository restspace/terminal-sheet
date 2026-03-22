import type { Workspace } from '../../shared/workspace';

type WorkspaceTimestampSource = Pick<Workspace, 'updatedAt'> | null | undefined;

export function compareWorkspaceUpdatedAt(
  left: WorkspaceTimestampSource,
  right: WorkspaceTimestampSource,
): number {
  const leftUpdatedAt = left?.updatedAt ?? null;
  const rightUpdatedAt = right?.updatedAt ?? null;

  if (leftUpdatedAt === rightUpdatedAt) {
    return 0;
  }

  if (!leftUpdatedAt) {
    return -1;
  }

  if (!rightUpdatedAt) {
    return 1;
  }

  const leftTimestamp = Date.parse(leftUpdatedAt);
  const rightTimestamp = Date.parse(rightUpdatedAt);

  if (leftTimestamp === rightTimestamp) {
    return 0;
  }

  return leftTimestamp > rightTimestamp ? 1 : -1;
}

export function isNewerWorkspaceSnapshot(
  candidate: WorkspaceTimestampSource,
  current: WorkspaceTimestampSource,
): boolean {
  return compareWorkspaceUpdatedAt(candidate, current) > 0;
}

export function isStaleWorkspaceSnapshot(
  candidate: WorkspaceTimestampSource,
  current: WorkspaceTimestampSource,
): boolean {
  return compareWorkspaceUpdatedAt(candidate, current) < 0;
}
