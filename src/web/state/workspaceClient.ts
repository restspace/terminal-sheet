import { serializeJsonMessage } from '../../shared/jsonTransport';
import { type Workspace, workspaceSchema } from '../../shared/workspace';

export async function fetchWorkspace(): Promise<Workspace> {
  const response = await fetch('/api/workspace');

  if (!response.ok) {
    throw new Error(`Workspace request failed with ${response.status}`);
  }

  return workspaceSchema.parse(await response.json());
}

export async function persistWorkspace(
  workspace: Workspace,
): Promise<Workspace> {
  const response = await fetch('/api/workspace', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: serializeJsonMessage(workspace),
  });

  if (!response.ok) {
    throw new Error(`Workspace save failed with ${response.status}`);
  }

  return workspaceSchema.parse(await response.json());
}
