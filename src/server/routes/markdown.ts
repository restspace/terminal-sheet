import type { FastifyInstance } from 'fastify';

import {
  markdownCreateRequestSchema,
  markdownLinkRequestSchema,
  markdownOpenRequestSchema,
  markdownResolveConflictRequestSchema,
  markdownSaveRequestSchema,
} from '../../shared/markdown';
import {
  createWorkspaceMarkdownNode,
  type Workspace,
} from '../../shared/workspace';
import { getMarkdownLabel, type MarkdownService } from '../markdown/markdownService';
import type { WorkspaceService } from '../persistence/workspaceService';
import { WorkspaceCommitService } from '../workspace/workspaceCommitService';

interface MarkdownRouteOptions {
  markdownService: MarkdownService;
  workspaceService: WorkspaceService;
  workspaceCommitService: WorkspaceCommitService;
}

export async function registerMarkdownRoutes(
  app: FastifyInstance,
  options: MarkdownRouteOptions,
): Promise<void> {
  app.get<{ Params: { nodeId: string } }>(
    '/api/markdown/:nodeId',
    async (request, reply) => {
      const document = options.markdownService.getDocument(request.params.nodeId);

      if (!document) {
        reply.code(404);
        return {
          message: 'Markdown document not found.',
        };
      }

      return document;
    },
  );

  app.post('/api/markdown/create', async (request) => {
    const body = markdownCreateRequestSchema.parse(request.body);
    const workspace = options.workspaceService.getWorkspace();
    const requestedPath =
      body.filePath?.trim() || options.markdownService.createDefaultFilePath(workspace);

    await options.markdownService.createEmptyFile(requestedPath);

    const node = createWorkspaceMarkdownNode(
      workspace,
      {
        label: body.label?.trim() || getMarkdownLabel(requestedPath),
        filePath: requestedPath,
        readOnly: false,
      },
    );
    const nextWorkspace = {
      ...workspace,
      markdown: [...workspace.markdown, node],
    };
    const savedWorkspace = await options.workspaceCommitService.commitWorkspace(nextWorkspace);
    await options.markdownService.syncWithWorkspace(savedWorkspace);

    return {
      workspace: savedWorkspace,
      node,
      document: options.markdownService.getDocument(node.id),
    };
  });

  app.post('/api/markdown/open', async (request) => {
    const body = markdownOpenRequestSchema.parse(request.body);
    const workspace = options.workspaceService.getWorkspace();
    const resolvedPath = options.markdownService.resolvePath(body.filePath);
    const filePath = options.markdownService.toWorkspacePath(resolvedPath);
    const existing = workspace.markdown.find((node) => node.filePath === filePath);

    if (existing) {
      return {
        workspace,
        node: existing,
        document: options.markdownService.getDocument(existing.id),
      };
    }

    const hasLegacyDocument = await options.markdownService.hasLegacyDocument(
      filePath,
    );

    if (body.createIfMissing && !hasLegacyDocument) {
      await options.markdownService.createEmptyFile(filePath);
    }

    const node = createWorkspaceMarkdownNode(
      workspace,
      {
        label: getMarkdownLabel(filePath),
        filePath,
        readOnly: false,
      },
    );
    const nextWorkspace: Workspace = {
      ...workspace,
      markdown: [...workspace.markdown, node],
    };
    const savedWorkspace = await options.workspaceCommitService.commitWorkspace(nextWorkspace);
    await options.markdownService.syncWithWorkspace(savedWorkspace);

    return {
      workspace: savedWorkspace,
      node,
      document: options.markdownService.getDocument(node.id),
    };
  });

  app.put<{ Params: { nodeId: string } }>(
    '/api/markdown/:nodeId',
    async (request) => {
      const body = markdownSaveRequestSchema.parse(request.body);
      return options.markdownService.saveDocument(
        request.params.nodeId,
        body.content,
        body.externalVersion,
      );
    },
  );

  app.post<{ Params: { nodeId: string } }>(
    '/api/markdown/:nodeId/resolve',
    async (request) => {
      const body = markdownResolveConflictRequestSchema.parse(request.body);
      return options.markdownService.resolveConflict(
        request.params.nodeId,
        body.choice,
        body.content,
        body.externalVersion,
      );
    },
  );

  app.post('/api/markdown/link', async (request, reply) => {
    const body = markdownLinkRequestSchema.parse(request.body);

    const link = options.markdownService.queueLink(
      body.markdownNodeId,
      body.terminalId,
    );

    if (!link) {
      reply.code(404);
      return {
        message: 'Markdown node not found.',
      };
    }

    return {
      link,
      links: options.markdownService.getLinks(),
    };
  });
}
