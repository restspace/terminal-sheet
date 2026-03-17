import { promises as fs, type Dirent } from 'node:fs';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  resolve,
} from 'node:path';

import type { FileSystemEntry } from '../../shared/filesystem';

export type FileSystemListErrorKind =
  | 'not-found'
  | 'not-directory'
  | 'access-denied'
  | 'invalid-path';

export class FileSystemListError extends Error {
  readonly kind: FileSystemListErrorKind;

  constructor(kind: FileSystemListErrorKind, message: string) {
    super(message);
    this.kind = kind;
  }
}

export class LocalFileSystemService {
  constructor(private readonly contentRoot: string) {}

  async listDirectory(input: {
    directoryPath?: string;
    includeFiles: boolean;
    extensions?: string[];
  }): Promise<{
    directoryPath: string;
    parentDirectoryPath: string | null;
    entries: FileSystemEntry[];
  }> {
    const directoryPath = this.resolveDirectoryPath(input.directoryPath);
    const extensionFilter = normalizeExtensions(input.extensions);

    await this.assertDirectory(directoryPath);

    let dirents: Dirent[];

    try {
      dirents = await fs.readdir(directoryPath, { withFileTypes: true });
    } catch (error) {
      throw mapFsError(error, directoryPath);
    }

    const entries: FileSystemEntry[] = [];

    for (const dirent of dirents) {
      const nextPath = join(directoryPath, dirent.name);
      const kind = await resolveEntryKind(dirent, nextPath);

      if (!kind) {
        continue;
      }

      if (kind === 'file') {
        if (!input.includeFiles) {
          continue;
        }

        if (
          extensionFilter.size > 0 &&
          !extensionFilter.has(extname(dirent.name).toLowerCase())
        ) {
          continue;
        }
      }

      entries.push({
        name: dirent.name,
        path: nextPath,
        kind,
      });
    }

    entries.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'directory' ? -1 : 1;
      }

      return left.name.localeCompare(right.name, undefined, {
        sensitivity: 'base',
      });
    });

    return {
      directoryPath,
      parentDirectoryPath: getParentDirectoryPath(directoryPath),
      entries,
    };
  }

  private resolveDirectoryPath(inputPath?: string): string {
    if (!inputPath?.trim()) {
      return resolve(this.contentRoot);
    }

    if (isAbsolute(inputPath)) {
      return resolve(inputPath);
    }

    return resolve(this.contentRoot, inputPath);
  }

  private async assertDirectory(directoryPath: string): Promise<void> {
    if (!directoryPath.trim()) {
      throw new FileSystemListError('invalid-path', 'Directory path is empty.');
    }

    try {
      const stats = await fs.stat(directoryPath);

      if (!stats.isDirectory()) {
        throw new FileSystemListError(
          'not-directory',
          `Path is not a directory: ${directoryPath}`,
        );
      }
    } catch (error) {
      if (error instanceof FileSystemListError) {
        throw error;
      }

      throw mapFsError(error, directoryPath);
    }
  }
}

function normalizeExtensions(extensions: string[] | undefined): Set<string> {
  if (!extensions?.length) {
    return new Set();
  }

  return new Set(
    extensions
      .map((extension) => extension.trim().toLowerCase())
      .filter((extension) => extension.length > 0)
      .map((extension) =>
        extension.startsWith('.') ? extension : `.${extension}`,
      ),
  );
}

function getParentDirectoryPath(directoryPath: string): string | null {
  const parentDirectoryPath = dirname(directoryPath);

  if (parentDirectoryPath === directoryPath) {
    return null;
  }

  return parentDirectoryPath;
}

async function resolveEntryKind(
  dirent: Dirent,
  entryPath: string,
): Promise<FileSystemEntry['kind'] | null> {
  if (dirent.isDirectory()) {
    return 'directory';
  }

  if (dirent.isFile()) {
    return 'file';
  }

  if (!dirent.isSymbolicLink()) {
    return null;
  }

  try {
    const stats = await fs.stat(entryPath);

    if (stats.isDirectory()) {
      return 'directory';
    }

    if (stats.isFile()) {
      return 'file';
    }
  } catch {
    // Ignore invalid symlinks. They can disappear between readdir and stat.
  }

  return null;
}

function mapFsError(error: unknown, path: string): FileSystemListError {
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as NodeJS.ErrnoException).code === 'string'
      ? (error as NodeJS.ErrnoException).code
      : null;

  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new FileSystemListError('not-found', `Path not found: ${path}`);
  }

  if (code === 'EACCES' || code === 'EPERM') {
    return new FileSystemListError(
      'access-denied',
      `Access denied: ${path}`,
    );
  }

  return new FileSystemListError(
    'invalid-path',
    `Unable to read directory: ${path}`,
  );
}
