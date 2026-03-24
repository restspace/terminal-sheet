import type { FastifyInstance } from 'fastify';

import { parseJsonMessage } from '../../shared/jsonTransport';
import {
  terminalClientSocketMessageSchema,
  type TerminalServerSocketMessage,
  type TerminalClientSocketMessage,
} from '../../shared/terminalSessions';
import type { StateDebugEvent } from '../../shared/debugState';
import {
  getWorkspaceDebugSessionId,
  logWorkspaceDebug,
  summarizeWorkspaceForDebug,
} from '../debug/workspaceDebug';
import type { StateDebugEventStore } from '../debug/stateDebugEventStore';
import { readFrontendLeaseAuth } from '../frontend/frontendLeaseAuth';
import type { FrontendLeaseManager } from '../frontend/frontendLeaseManager';
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
  eventStore: StateDebugEventStore;
  frontendLeaseManager: FrontendLeaseManager;
}

export async function registerWorkspaceSocket(
  app: FastifyInstance,
  options: WorkspaceSocketOptions,
): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const leaseAuth = readFrontendLeaseAuth(request);
    const debugSessionId = getWorkspaceDebugSessionId(request);
    const appendServerDebugEvent = (
      scope: string,
      event: string,
      details: unknown,
    ) => {
      if (!debugSessionId) {
        return;
      }

      const entry: StateDebugEvent = {
        timestamp: new Date().toISOString(),
        scope,
        event,
        details,
      };

      options.eventStore.append(debugSessionId, [entry]);
    };
    const sendDebugTrackedJson = (message: TerminalServerSocketMessage) => {
      const summary = summarizeServerSocketMessageForDebug(message);

      if (summary) {
        appendServerDebugEvent('serverSocket', 'send', summary);
      }

      sendJson(socket, message);
    };
    logWorkspaceDebug(app.log, debugSessionId, 'workspace socket connected', {
      url: request.url,
    });
    appendServerDebugEvent('serverSocket', 'connected', {
      url: request.url,
    });
    const attachedLease = options.frontendLeaseManager.attachWorkspaceSocket(
      leaseAuth,
      socket,
    );

    if (!attachedLease.ok) {
      sendDebugTrackedJson({
        type: 'frontend.locked',
        lock: attachedLease.locked,
      });
      socket.close(4003, 'Active frontend lease required.');
      return;
    }

    sendDebugTrackedJson({
      type: 'frontend.lease',
      lease: toFrontendLeaseOwner(attachedLease.lease),
    });

    sendDebugTrackedJson({
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
    sendDebugTrackedJson({
      type: 'workspace.updated',
      workspace: options.workspaceService.getWorkspace(),
    });
    sendDebugTrackedJson({
      type: 'session.init',
      sessions: options.runtimeManager.getSnapshots(),
    });
    sendDebugTrackedJson({
      type: 'attention.init',
      events: options.runtimeManager.getAttentionEvents(),
    });
    sendDebugTrackedJson({
      type: 'markdown.init',
      documents: options.markdownService.getDocuments(),
    });
    sendDebugTrackedJson({
      type: 'markdown.link.init',
      links: options.markdownService.getLinks(),
    });

    const unsubscribe = options.runtimeManager.subscribeSession((message) => {
      sendDebugTrackedJson(message);
    });
    const unsubscribeAttention = options.runtimeManager.subscribeAttention((event) => {
      sendDebugTrackedJson({
        type: 'attention.event',
        event,
      });
    });
    const unsubscribeDocuments = options.markdownService.subscribeDocuments(
      (document) => {
        sendDebugTrackedJson({
          type: 'markdown.document',
          document,
        });
      },
    );
    const unsubscribeLinks = options.markdownService.subscribeLinks((links) => {
      sendDebugTrackedJson({
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
      sendDebugTrackedJson({
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

      appendServerDebugEvent(
        'serverSocket',
        'receive',
        summarizeClientSocketMessageForDebug(parsed),
      );
      handleClientMessage({
        runtimeManager: options.runtimeManager,
        frontendLeaseManager: options.frontendLeaseManager,
        leaseAuth,
        socket,
        message: parsed,
        sendMessage: sendDebugTrackedJson,
      });
    });

    socket.on('close', () => {
      logWorkspaceDebug(app.log, debugSessionId, 'workspace socket closed', {
        url: request.url,
      });
      appendServerDebugEvent('serverSocket', 'closed', {
        url: request.url,
      });
      options.frontendLeaseManager.detachWorkspaceSocket(socket);
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
      appendServerDebugEvent('serverSocket', 'error', {
        url: request.url,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  });
}

function parseClientMessage(payload: string): TerminalClientSocketMessage | null {
  return parseJsonMessage(payload, terminalClientSocketMessageSchema);
}

function handleClientMessage(
  options: {
    runtimeManager: BackendRuntimeManager;
    frontendLeaseManager: FrontendLeaseManager;
    leaseAuth: ReturnType<typeof readFrontendLeaseAuth>;
    socket: {
      close(code?: number, data?: string): void;
    };
    message: TerminalClientSocketMessage;
    sendMessage: (message: TerminalServerSocketMessage) => void;
  },
): void {
  const validation = options.frontendLeaseManager.validate(options.leaseAuth);

  if (!validation.ok) {
    options.sendMessage({
      type: 'frontend.locked',
      lock: validation.locked,
    });
    options.socket.close(4003, 'Active frontend lease required.');
    return;
  }

  switch (options.message.type) {
    case 'frontend.heartbeat':
      options.sendMessage({
        type: 'frontend.lease',
        lease: toFrontendLeaseOwner(validation.lease),
      });
      return;
    case 'terminal.input':
      options.runtimeManager.sendInput(
        options.message.sessionId,
        options.message.data,
      );
      return;
    case 'terminal.resize':
      options.runtimeManager.resizeSession(
        options.message.sessionId,
        options.message.cols,
        options.message.rows,
        options.message.generation,
      );
      return;
    case 'terminal.restart':
      options.runtimeManager.restartSession(options.message.sessionId);
      return;
    case 'terminal.mark-read':
      options.runtimeManager.markRead(options.message.sessionId);
      return;
  }
}

function summarizeClientSocketMessageForDebug(
  message: TerminalClientSocketMessage,
): Record<string, unknown> {
  switch (message.type) {
    case 'frontend.heartbeat':
      return {
        type: message.type,
        timestamp: message.timestamp,
      };
    case 'terminal.input':
      return {
        type: message.type,
        sessionId: message.sessionId,
        dataLength: message.data.length,
        hasNewline: /[\r\n]/.test(message.data),
      };
    case 'terminal.resize':
      return {
        type: message.type,
        sessionId: message.sessionId,
        cols: message.cols,
        rows: message.rows,
        generation: message.generation,
      };
    case 'terminal.restart':
    case 'terminal.mark-read':
      return {
        type: message.type,
        sessionId: message.sessionId,
      };
  }
}

function summarizeServerSocketMessageForDebug(
  message: TerminalServerSocketMessage,
): Record<string, unknown> | null {
  switch (message.type) {
    case 'frontend.lease':
      return {
        type: message.type,
        frontendId: message.lease.frontendId,
        ownerLabel: message.lease.ownerLabel,
        leaseEpoch: message.lease.leaseEpoch,
        expiresAt: message.lease.expiresAt,
      };
    case 'frontend.locked':
      return {
        type: message.type,
        owner: message.lock.owner,
        canTakeOver: message.lock.canTakeOver,
      };
    case 'ready':
      return {
        type: message.type,
        timestamp: message.timestamp,
      };
    case 'workspace.updated':
      return {
        type: message.type,
        layoutMode: message.workspace.layoutMode,
        terminalCount: message.workspace.terminals.length,
        markdownCount: message.workspace.markdown.length,
        updatedAt: message.workspace.updatedAt,
      };
    case 'session.init':
      return {
        type: message.type,
        sessions: message.sessions.map(summarizeSessionSnapshotForDebug),
      };
    case 'session.snapshot':
      return {
        type: message.type,
        session: summarizeSessionSnapshotForDebug(message.session),
      };
    case 'session.removed':
      return {
        type: message.type,
        sessionId: message.sessionId,
        backendId: message.backendId,
      };
    default:
      return null;
  }
}

function summarizeSessionSnapshotForDebug(message: {
  sessionId: string;
  backendId: string;
  pid: number | null;
  status: string;
  recoveryState: string;
  connected: boolean;
  cols: number | null;
  rows: number | null;
  appliedResizeGeneration: number | null;
}): Record<string, unknown> {
  return {
    sessionId: message.sessionId,
    backendId: message.backendId,
    pid: message.pid,
    status: message.status,
    recoveryState: message.recoveryState,
    connected: message.connected,
    cols: message.cols,
    rows: message.rows,
    appliedResizeGeneration: message.appliedResizeGeneration,
  };
}

function toFrontendLeaseOwner(lease: {
  frontendId: string;
  ownerLabel: string;
  leaseEpoch: number;
  acquiredAt: string;
  lastSeenAt: string;
  expiresAt: string;
}): {
  frontendId: string;
  ownerLabel: string;
  leaseEpoch: number;
  acquiredAt: string;
  lastSeenAt: string;
  expiresAt: string;
} {
  return {
    frontendId: lease.frontendId,
    ownerLabel: lease.ownerLabel,
    leaseEpoch: lease.leaseEpoch,
    acquiredAt: lease.acquiredAt,
    lastSeenAt: lease.lastSeenAt,
    expiresAt: lease.expiresAt,
  };
}
