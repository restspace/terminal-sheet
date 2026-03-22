import { serializeJsonMessage } from '../../shared/jsonTransport';
import { type Workspace, workspaceSchema } from '../../shared/workspace';
import {
  WORKSPACE_BASE_UPDATED_AT_HEADER,
  workspaceConflictResponseSchema,
} from '../../shared/workspaceTransport';
import { getStateDebugRequestHeaders } from '../debug/stateDebug';

export async function fetchWorkspace(): Promise<Workspace> {
  const response = await fetch('/api/workspace', {
    headers: getStateDebugRequestHeaders(),
  });

  if (!response.ok) {
    throw new Error(`Workspace request failed with ${response.status}`);
  }

  return workspaceSchema.parse(await response.json());
}

export async function persistWorkspace(
  workspace: Workspace,
  options?: {
    baseUpdatedAt?: string | null;
  },
): Promise<Workspace> {
  const response = await fetch('/api/workspace', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.baseUpdatedAt
        ? { [WORKSPACE_BASE_UPDATED_AT_HEADER]: options.baseUpdatedAt }
        : {}),
      ...getStateDebugRequestHeaders(),
    },
    body: serializeJsonMessage(workspace),
  });

  if (response.status === 409 || response.status === 428) {
    throw new WorkspaceConflictError(
      workspaceConflictResponseSchema.parse(await response.json()).workspace,
    );
  }

  if (!response.ok) {
    throw new Error(`Workspace save failed with ${response.status}`);
  }

  return workspaceSchema.parse(await response.json());
}

export class WorkspaceConflictError extends Error {
  constructor(readonly workspace: Workspace) {
    super('Workspace save conflict');
    this.name = 'WorkspaceConflictError';
  }
}
