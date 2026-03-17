import type { FastifyInstance } from 'fastify';

import {
  filesystemListRequestSchema,
  type FileSystemListRequest,
  type FileSystemListResponse,
} from '../../shared/filesystem';
import { LOCAL_BACKEND_ID } from '../../shared/backends';
import {
  FileSystemListError,
  type FileSystemListErrorKind,
  type LocalFileSystemService,
} from '../filesystem/localFileSystemService';

interface FileSystemRouteOptions {
  localFileSystemService: LocalFileSystemService;
}

export async function registerFileSystemRoutes(
  app: FastifyInstance,
  options: FileSystemRouteOptions,
): Promise<void> {
  app.post<{ Body: Partial<FileSystemListRequest> }>(
    '/api/filesystem/list',
    async (request, reply): Promise<FileSystemListResponse | { message: string }> => {
      const parsed = filesystemListRequestSchema.safeParse(request.body ?? {});

      if (!parsed.success) {
        reply.code(400);
        return {
          message: 'Invalid filesystem list request.',
        };
      }

      const body = parsed.data;

      if (body.server !== LOCAL_BACKEND_ID) {
        reply.code(501);
        return {
          message: `Filesystem server '${body.server}' is not supported yet.`,
        };
      }

      try {
        const listing = await options.localFileSystemService.listDirectory({
          directoryPath: body.directoryPath,
          includeFiles: body.includeFiles,
          extensions: body.extensions,
        });

        return {
          server: body.server,
          ...listing,
        };
      } catch (error) {
        if (!(error instanceof FileSystemListError)) {
          throw error;
        }

        reply.code(getStatusCode(error.kind));
        return {
          message: error.message,
        };
      }
    },
  );
}

function getStatusCode(kind: FileSystemListErrorKind): number {
  switch (kind) {
    case 'not-found':
      return 404;
    case 'not-directory':
      return 400;
    case 'access-denied':
      return 403;
    case 'invalid-path':
      return 400;
  }
}
