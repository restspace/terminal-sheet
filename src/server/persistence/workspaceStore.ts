import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import {
  createDefaultWorkspace,
  touchWorkspace,
  type Workspace,
  workspaceSchema,
} from '../../shared/workspace';
import { ZodError } from 'zod';

export function resolveWorkspaceFilePath(inputPath?: string): string {
  if (inputPath) {
    return resolve(process.cwd(), inputPath);
  }

  return resolve(process.cwd(), '.terminal-canvas', 'workspace.json');
}

export async function loadOrCreateWorkspace(
  filePath: string,
): Promise<Workspace> {
  await mkdir(dirname(filePath), { recursive: true });

  try {
    const raw = await readFile(filePath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    return workspaceSchema.parse(parsed);
  } catch (error) {
    if (!isMissingFileError(error) && !isRecoverableWorkspaceError(error)) {
      throw error;
    }

    const workspace = createDefaultWorkspace();
    await saveWorkspace(filePath, workspace);
    return workspace;
  }
}

export async function saveWorkspace(
  filePath: string,
  workspace: Workspace,
): Promise<Workspace> {
  await mkdir(dirname(filePath), { recursive: true });

  const normalized = touchWorkspace(workspaceSchema.parse(workspace));

  await writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf8');

  return normalized;
}

function isMissingFileError(error: unknown): error is NodeJS.ErrnoException {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as NodeJS.ErrnoException).code === 'ENOENT',
  );
}

function isRecoverableWorkspaceError(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof ZodError;
}
