import type { FastifyInstance } from 'fastify';

import { parseJsonMessage } from '../../shared/jsonTransport';
import {
  terminalClientSocketMessageSchema,
  type TerminalClientSocketMessage,
} from '../../shared/terminalSessions';
import {
  getWorkspaceDebugSessionId,
  logWorkspaceDebug,
  summarizeWorkspaceForDebug,
} from '../debug/workspaceDebug';
import type { MarkdownService } from '../markdown/markdownService';
import type { WorkspaceService } from '../persistence/workspaceService';
import type { BackendRuntimeManager } from '../runtime/backendRuntimeManager';
import { WorkspaceCommitPublisher } from '../workspace/workspaceCommitPublisher';
import { sendJson } from './sendJson';

interface WorkspaceSocketOptions {
  runtimeManager: BackendRuntimeManager;
  markdownService: MarkdownService;
  workspaceService: WorkspaceService;
  workspaceCommitPublisher: WorkspaceCommitPublisher;
}

export async function registerWorkspaceSocket(
  app: FastifyInstance,
  options: WorkspaceSocketOptions,
): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const debugSessionId = getWorkspaceDebugSessionId(request);
    logWorkspaceDebug(app.log, debugSessionId, 'workspace socket connected', {
      url: request.url,
    });

    sendJson(socket, {
      type: 'ready',
      timestamp: new Date().toISOString(),
    });

    logWorkspaceDebug(
      app.log,
      debugSessionId,
      'workspace socket send initial workspace',
      {
        workspace: summarizeWorkspaceForDebug(
          options.workspaceService.getWorkspace(),
        ),
      },
    );
    sendJson(socket, {
      type: 'workspace.updated',
      workspace: options.workspaceService.getWorkspace(),
    });
    sendJson(socket, {
      type: 'session.init',
      sessions: options.runtimeManager.getSnapshots(),
    });
    sendJson(socket, {
      type: 'attention.init',
      events: options.runtimeManager.getAttentionEvents(),
    });
    sendJson(socket, {
      type: 'markdown.init',
      documents: options.markdownService.getDocuments(),
    });
    sendJson(socket, {
      type: 'markdown.link.init',
      links: options.markdownService.getLinks(),
    });

    const unsubscribe = options.runtimeManager.subscribeSession((message) => {
      sendJson(socket, message);
    });
    const unsubscribeAttention = options.runtimeManager.subscribeAttention((event) => {
      sendJson(socket, {
        type: 'attention.event',
        event,
      });
    });
    const unsubscribeDocuments = options.markdownService.subscribeDocuments(
      (document) => {
        sendJson(socket, {
          type: 'markdown.document',
          document,
        });
      },
    );
    const unsubscribeLinks = options.markdownService.subscribeLinks((links) => {
      sendJson(socket, {
        type: 'markdown.link',
        links,
      });
    });
    const unsubscribeWorkspace = options.workspaceCommitPublisher.subscribe((workspace) => {
      logWorkspaceDebug(
        app.log,
        debugSessionId,
        'workspace socket push workspace.updated',
        {
          workspace: summarizeWorkspaceForDebug(workspace),
        },
      );
      sendJson(socket, {
        type: 'workspace.updated',
        workspace,
      });
    });

    socket.on('message', (payload: Buffer) => {
      const rawPayload = payload.toString();
      const parsed = parseClientMessage(rawPayload);

      if (!parsed) {
        app.log.warn(
          {
            debugSessionId,
            payloadLength: rawPayload.length,
          },
          'Ignoring invalid workspace websocket client message',
        );
        return;
      }

      handleClientMessage(options.runtimeManager, parsed);
    });

    socket.on('close', () => {
      logWorkspaceDebug(app.log, debugSessionId, 'workspace socket closed', {
        url: request.url,
      });
      unsubscribe();
      unsubscribeAttention();
      unsubscribeDocuments();
      unsubscribeLinks();
      unsubscribeWorkspace();
    });
    socket.on('error', (error: unknown) => {
      app.log.warn(
        {
          debugSessionId,
          error: error instanceof Error ? error.message : String(error),
          url: request.url,
        },
        'Workspace websocket error',
      );
    });
  });
}

function parseClientMessage(payload: string): TerminalClientSocketMessage | null {
  return parseJsonMessage(payload, terminalClientSocketMessageSchema);
}

function handleClientMessage(
  runtimeManager: BackendRuntimeManager,
  message: TerminalClientSocketMessage,
): void {
  switch (message.type) {
    case 'terminal.input':
      runtimeManager.sendInput(message.sessionId, message.data);
      return;
    case 'terminal.resize':
      runtimeManager.resizeSession(
        message.sessionId,
        message.cols,
        message.rows,
      );
      return;
    case 'terminal.restart':
      runtimeManager.restartSession(message.sessionId);
      return;
    case 'terminal.mark-read':
      runtimeManager.markRead(message.sessionId);
      return;
  }
}
