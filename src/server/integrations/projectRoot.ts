import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';

export async function findNearestProjectRoot(
  cwd: string,
  markers: readonly string[],
): Promise<string | null> {
  let current = cwd;

  while (true) {
    for (const marker of markers) {
      if (await pathExists(join(current, marker))) {
        return current;
      }
    }

    const parent = dirname(current);

    if (parent === current) {
      return null;
    }

    current = parent;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
