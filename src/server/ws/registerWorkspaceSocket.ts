import type { FastifyInstance } from 'fastify';

import { parseJsonMessage } from '../../shared/jsonTransport';
import {
  terminalClientSocketMessageSchema,
  type TerminalClientSocketMessage,
} from '../../shared/terminalSessions';
import type { MarkdownService } from '../markdown/markdownService';
import type { WorkspaceService } from '../persistence/workspaceService';
import type { BackendRuntimeManager } from '../runtime/backendRuntimeManager';
import { sendJson } from './sendJson';

interface WorkspaceSocketOptions {
  runtimeManager: BackendRuntimeManager;
  markdownService: MarkdownService;
  workspaceService: WorkspaceService;
}

export async function registerWorkspaceSocket(
  app: FastifyInstance,
  options: WorkspaceSocketOptions,
): Promise<void> {
  app.get('/ws', { websocket: true }, (socket) => {
    sendJson(socket, {
      type: 'ready',
      timestamp: new Date().toISOString(),
    });
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
    const unsubscribeWorkspace = options.workspaceService.subscribe((workspace) => {
      sendJson(socket, {
        type: 'workspace.updated',
        workspace,
      });
    });

    socket.on('message', (payload: Buffer) => {
      const parsed = parseClientMessage(payload.toString());

      if (!parsed) {
        return;
      }

      handleClientMessage(options.runtimeManager, parsed);
    });

    socket.on('close', () => {
      unsubscribe();
      unsubscribeAttention();
      unsubscribeDocuments();
      unsubscribeLinks();
      unsubscribeWorkspace();
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
