import type { Workspace } from '../../shared/workspace';

export async function fetchWorkspace(): Promise<Workspace> {
  const response = await fetch('/api/workspace');

  if (!response.ok) {
    throw new Error(`Workspace request failed with ${response.status}`);
  }

  return (await response.json()) as Workspace;
}

export async function persistWorkspace(
  workspace: Workspace,
): Promise<Workspace> {
  const response = await fetch('/api/workspace', {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(workspace),
  });

  if (!response.ok) {
    throw new Error(`Workspace save failed with ${response.status}`);
  }

  return (await response.json()) as Workspace;
}
