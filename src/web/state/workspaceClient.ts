import { serializeJsonMessage } from '../../shared/jsonTransport';
import {
  type WorkspaceCommand,
} from '../../shared/workspaceCommands';
import { type Workspace, workspaceSchema } from '../../shared/workspace';
import {
  WORKSPACE_BASE_UPDATED_AT_HEADER,
  workspaceConflictResponseSchema,
} from '../../shared/workspaceTransport';
import { getStateDebugRequestHeaders } from '../debug/stateDebug';

export async function fetchWorkspace(): Promise<Workspace> {
  const response = await fetch('/api/workspace', {
    headers: getStateDebugRequestHeaders(),
    signal: AbortSignal.timeout(10_000),
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
    signal: AbortSignal.timeout(10_000),
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

export async function sendWorkspaceCommands(
  commands: readonly WorkspaceCommand[],
  options?: {
    baseUpdatedAt?: string | null;
  },
): Promise<Workspace> {
  const response = await fetch('/api/workspace/mutations', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(options?.baseUpdatedAt
        ? { [WORKSPACE_BASE_UPDATED_AT_HEADER]: options.baseUpdatedAt }
        : {}),
      ...getStateDebugRequestHeaders(),
    },
    body: serializeJsonMessage({
      commands,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 409 || response.status === 428) {
    throw new WorkspaceConflictError(
      workspaceConflictResponseSchema.parse(await response.json()).workspace,
    );
  }

  if (!response.ok) {
    throw new Error(`Workspace mutation failed with ${response.status}`);
  }

  return workspaceSchema.parse(await response.json());
}

export async function sendWorkspaceCommand(
  command: WorkspaceCommand,
  options?: {
    baseUpdatedAt?: string | null;
  },
): Promise<Workspace> {
  return sendWorkspaceCommands([command], options);
}

export class WorkspaceConflictError extends Error {
  constructor(readonly workspace: Workspace) {
    super('Workspace save conflict');
    this.name = 'WorkspaceConflictError';
  }
}
