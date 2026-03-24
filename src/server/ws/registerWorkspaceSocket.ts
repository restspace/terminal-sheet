import type { FastifyInstance } from 'fastify';

import { parseJsonMessage } from '../../shared/jsonTransport';
import type { StateDebugEvent } from '../../shared/debugState';
import {
  type TerminalClientSocketMessage,
  type TerminalServerSocketMessage,
  terminalClientSocketMessageSchema,
} from '../../shared/terminalSessions';
import type { StateDebugEventStore } from '../debug/stateDebugEventStore';
import {
  getWorkspaceDebugSessionId,
  logWorkspaceDebug,
  summarizeWorkspaceForDebug,
} from '../debug/workspaceDebug';
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

interface AuthenticatedWorkspaceSocketLease {
  frontendId: string;
  leaseToken: string;
  leaseEpoch: number;
}

export async function registerWorkspaceSocket(
  app: FastifyInstance,
  options: WorkspaceSocketOptions,
): Promise<void> {
  app.get('/ws', { websocket: true }, (socket, request) => {
    const debugSessionId = getWorkspaceDebugSessionId(request);
    const path = request.url.split('?')[0] ?? request.url;
    let leaseAuth: AuthenticatedWorkspaceSocketLease | null = null;
    let authTimeout: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      socket.close(4003, 'Workspace socket authentication required.');
    }, 5_000);
    authTimeout.unref?.();
    let unsubscribe = () => {};
    let unsubscribeAttention = () => {};
    let unsubscribeDocuments = () => {};
    let unsubscribeLinks = () => {};
    let unsubscribeWorkspace = () => {};

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
    const clearAuthTimeout = () => {
      if (!authTimeout) {
        return;
      }

      clearTimeout(authTimeout);
      authTimeout = null;
    };
    const initializeAuthenticatedSocket = (
      attachedLease: Parameters<typeof toFrontendLeaseOwner>[0] & {
        leaseToken: string;
      },
    ) => {
      clearAuthTimeout();
      sendDebugTrackedJson({
        type: 'frontend.lease',
        lease: toFrontendLeaseOwner(attachedLease),
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
          frontendId: attachedLease.frontendId,
          leaseEpoch: attachedLease.leaseEpoch,
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

      unsubscribe = options.runtimeManager.subscribeSession((message) => {
        sendDebugTrackedJson(message);
      });
      unsubscribeAttention = options.runtimeManager.subscribeAttention((event) => {
        sendDebugTrackedJson({
          type: 'attention.event',
          event,
        });
      });
      unsubscribeDocuments = options.markdownService.subscribeDocuments(
        (document) => {
          sendDebugTrackedJson({
            type: 'markdown.document',
            document,
          });
        },
      );
      unsubscribeLinks = options.markdownService.subscribeLinks((links) => {
        sendDebugTrackedJson({
          type: 'markdown.link',
          links,
        });
      });
      unsubscribeWorkspace = options.workspaceCommitPublisher.subscribe(
        (workspace) => {
          logWorkspaceDebug(
            app.log,
            debugSessionId,
            'workspace socket push workspace.updated',
            {
              frontendId: attachedLease.frontendId,
              leaseEpoch: attachedLease.leaseEpoch,
              workspace: summarizeWorkspaceForDebug(workspace),
            },
          );
          sendDebugTrackedJson({
            type: 'workspace.updated',
            workspace,
          });
        },
      );
    };

    logWorkspaceDebug(app.log, debugSessionId, 'workspace socket connected', {
      path,
    });
    appendServerDebugEvent('serverSocket', 'connected', {
      path,
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

      if (parsed.type === 'frontend.authenticate') {
        if (leaseAuth) {
          app.log.warn(
            {
              debugSessionId,
              frontendId: leaseAuth.frontendId,
              leaseEpoch: leaseAuth.leaseEpoch,
            },
            'Ignoring duplicate workspace websocket authentication message',
          );
          return;
        }

        const attachedLease = options.frontendLeaseManager.attachWorkspaceSocket(
          {
            frontendId: parsed.frontendId,
            leaseToken: parsed.leaseToken,
            leaseEpoch: parsed.leaseEpoch,
          },
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

        leaseAuth = {
          frontendId: attachedLease.lease.frontendId,
          leaseToken: parsed.leaseToken,
          leaseEpoch: attachedLease.lease.leaseEpoch,
        };
        logWorkspaceDebug(app.log, debugSessionId, 'workspace socket authenticated', {
          path,
          frontendId: leaseAuth.frontendId,
          leaseEpoch: leaseAuth.leaseEpoch,
        });
        appendServerDebugEvent('serverSocket', 'authenticated', {
          frontendId: leaseAuth.frontendId,
          leaseEpoch: leaseAuth.leaseEpoch,
        });
        initializeAuthenticatedSocket(attachedLease.lease);
        return;
      }

      if (!leaseAuth) {
        app.log.warn(
          {
            debugSessionId,
            messageType: parsed.type,
            path,
          },
          'Closing unauthenticated workspace websocket message',
        );
        socket.close(4003, 'Authenticate workspace socket first.');
        return;
      }

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
      clearAuthTimeout();
      logWorkspaceDebug(app.log, debugSessionId, 'workspace socket closed', {
        path,
        frontendId: leaseAuth?.frontendId ?? null,
        leaseEpoch: leaseAuth?.leaseEpoch ?? null,
      });
      appendServerDebugEvent('serverSocket', 'closed', {
        path,
        frontendId: leaseAuth?.frontendId ?? null,
        leaseEpoch: leaseAuth?.leaseEpoch ?? null,
      });

      if (leaseAuth) {
        options.frontendLeaseManager.detachWorkspaceSocket(socket);
      }

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
          path,
          frontendId: leaseAuth?.frontendId ?? null,
          leaseEpoch: leaseAuth?.leaseEpoch ?? null,
        },
        'Workspace websocket error',
      );
      appendServerDebugEvent('serverSocket', 'error', {
        path,
        frontendId: leaseAuth?.frontendId ?? null,
        leaseEpoch: leaseAuth?.leaseEpoch ?? null,
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
    leaseAuth: AuthenticatedWorkspaceSocketLease;
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
    case 'frontend.authenticate':
      return;
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
    case 'frontend.authenticate':
      return {
        type: message.type,
        frontendId: message.frontendId,
        leaseEpoch: message.leaseEpoch,
      };
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
