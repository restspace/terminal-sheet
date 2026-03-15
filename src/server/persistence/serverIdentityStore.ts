import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { z } from 'zod';

const serverIdentitySchema = z.object({
  serverId: z.string().min(1),
  machineToken: z.string().min(1),
});

export interface ServerIdentity {
  serverId: string;
  machineToken: string;
}

export function resolveServerIdentityFilePath(workspaceFilePath: string): string {
  return resolve(dirname(workspaceFilePath), 'server.json');
}

export async function loadOrCreateServerIdentity(
  filePath: string,
): Promise<ServerIdentity> {
  await mkdir(dirname(filePath), { recursive: true });

  try {
    const raw = await readFile(filePath, 'utf8');
    return serverIdentitySchema.parse(JSON.parse(raw) as unknown);
  } catch (error) {
    if (!isRecoverableIdentityError(error)) {
      throw error;
    }
  }

  const identity = createServerIdentity();
  await saveServerIdentity(filePath, identity);
  return identity;
}

export async function saveServerIdentity(
  filePath: string,
  identity: ServerIdentity,
): Promise<ServerIdentity> {
  await mkdir(dirname(filePath), { recursive: true });
  const normalized = serverIdentitySchema.parse(identity);
  await writeFile(filePath, JSON.stringify(normalized, null, 2), 'utf8');
  return normalized;
}

export async function rotateServerIdentityToken(
  filePath: string,
): Promise<ServerIdentity> {
  const current = await loadOrCreateServerIdentity(filePath);
  return saveServerIdentity(filePath, {
    ...current,
    machineToken: randomBytes(24).toString('hex'),
  });
}

function createServerIdentity(): ServerIdentity {
  return {
    serverId: randomUUID(),
    machineToken: randomBytes(24).toString('hex'),
  };
}

function isRecoverableIdentityError(error: unknown): boolean {
  return Boolean(
    error instanceof SyntaxError ||
      (error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'),
  );
}
