import { type FastifyBaseLogger } from 'fastify';

import type { BackendConnection, BackendStatus, ServerRole } from '../../shared/backends';
import type { AttentionEvent } from '../../shared/events';
import { parseJsonMessage, serializeJsonMessage } from '../../shared/jsonTransport';
import {
  terminalServerSocketMessageSchema,
  type TerminalServerSocketMessage,
  type TerminalSessionSnapshot,
} from '../../shared/terminalSessions';
import type { TerminalNode, Workspace } from '../../shared/workspace';
import type { AttentionService } from '../integrations/attentionService';
import type { WorkspaceService } from '../persistence/workspaceService';
import type { PtySessionManager } from '../pty/ptySessionManager';

type SessionListener = (message: TerminalServerSocketMessage) => void;
type AttentionListener = (event: AttentionEvent) => void;

export class BackendRuntimeManager {
  private readonly sessionListeners = new Set<SessionListener>();

  private readonly attentionListeners = new Set<AttentionListener>();

  private readonly remoteClients = new Map<string, RemoteBackendClient>();

  private readonly sessionBackendIndex = new Map<string, string>();

  private workspace: Workspace | null = null;

  constructor(
    private readonly logger: FastifyBaseLogger,
    private readonly options: {
      role: ServerRole;
      localBackendId: string;
      localPtySessionManager: PtySessionManager;
      localAttentionService: AttentionService;
      workspaceService: WorkspaceService;
    },
  ) {
    options.localPtySessionManager.subscribe((message) => {
      this.indexSessionMessage(message);
      this.broadcastSession(message);
    });
    options.localAttentionService.subscribe((event) => {
      this.broadcastAttention(event);
    });
  }

  async syncWithWorkspace(workspace: Workspace): Promise<void> {
    this.workspace = workspace;
    this.sessionBackendIndex.clear();
    for (const [sessionId, backendId] of buildSessionBackendIndex(
      workspace,
      this.options.localBackendId,
    )) {
      this.sessionBackendIndex.set(sessionId, backendId);
    }
    await this.options.localPtySessionManager.syncWithWorkspace(workspace);

    if (this.options.role !== 'home') {
      for (const [backendId, client] of this.remoteClients) {
        client.close();
        this.remoteClients.delete(backendId);
      }
      return;
    }

    const activeBackendIds = new Set<string>();

    for (const backend of workspace.backends) {
      if (!backend.enabled) {
        continue;
      }

      activeBackendIds.add(backend.id);
      const existing = this.remoteClients.get(backend.id);

      if (existing) {
        existing.updateConnection(backend);
        existing.setKnownTerminals(
          workspace.terminals.filter((terminal) => terminal.backendId === backend.id),
        );
        continue;
      }

      const client = new RemoteBackendClient(
        this.logger.child({ backendId: backend.id }),
        backend,
        {
          onSessionMessage: (message) => {
            this.indexSessionMessage(message);
            this.broadcastSession(message);
          },
          onAttentionEvent: (event) => {
            this.broadcastAttention(event);
          },
        },
      );
      client.setKnownTerminals(
        workspace.terminals.filter((terminal) => terminal.backendId === backend.id),
      );
      this.remoteClients.set(backend.id, client);
      client.start();
    }

    for (const [backendId, client] of this.remoteClients) {
      if (activeBackendIds.has(backendId)) {
        continue;
      }

      client.close();
      this.remoteClients.delete(backendId);
    }
  }

  getSnapshots(): TerminalSessionSnapshot[] {
    return [
      ...this.options.localPtySessionManager.getSnapshots(),
      ...[...this.remoteClients.values()].flatMap((client) => client.getSnapshots()),
    ];
  }

  getAttentionEvents(): AttentionEvent[] {
    return [
      ...this.options.localAttentionService.getEvents(),
      ...[...this.remoteClients.values()].flatMap((client) => client.getAttentionEvents()),
    ].sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  }

  getBackendStatuses(): BackendStatus[] {
    return [...this.remoteClients.values()].map((client) => client.getStatus());
  }

  subscribeSession(listener: SessionListener): () => void {
    this.sessionListeners.add(listener);

    return () => {
      this.sessionListeners.delete(listener);
    };
  }

  subscribeAttention(listener: AttentionListener): () => void {
    this.attentionListeners.add(listener);

    return () => {
      this.attentionListeners.delete(listener);
    };
  }

  sendInput(sessionId: string, data: string): boolean {
    const backendId = this.findBackendIdForSession(sessionId);

    if (!backendId || backendId === this.options.localBackendId) {
      return this.options.localPtySessionManager.sendInput(sessionId, data);
    }

    return this.remoteClients.get(backendId)?.sendInput(sessionId, data) ?? false;
  }

  resizeSession(sessionId: string, cols: number, rows: number): boolean {
    const backendId = this.findBackendIdForSession(sessionId);

    if (!backendId || backendId === this.options.localBackendId) {
      return this.options.localPtySessionManager.resizeSession(sessionId, cols, rows);
    }

    return (
      this.remoteClients.get(backendId)?.resizeSession(sessionId, cols, rows) ?? false
    );
  }

  restartSession(sessionId: string): boolean {
    const backendId = this.findBackendIdForSession(sessionId);

    if (!backendId || backendId === this.options.localBackendId) {
      return this.options.localPtySessionManager.restartSession(sessionId);
    }

    return this.remoteClients.get(backendId)?.restartSession(sessionId) ?? false;
  }

  markRead(sessionId: string): boolean {
    const backendId = this.findBackendIdForSession(sessionId);

    if (!backendId || backendId === this.options.localBackendId) {
      return this.options.localPtySessionManager.markRead(sessionId);
    }

    return this.remoteClients.get(backendId)?.markRead(sessionId) ?? false;
  }

  async close(): Promise<void> {
    for (const client of this.remoteClients.values()) {
      client.close();
    }

    this.remoteClients.clear();
  }

  private findBackendIdForSession(sessionId: string): string | null {
    return this.sessionBackendIndex.get(sessionId) ?? null;
  }

  private indexSessionMessage(message: TerminalServerSocketMessage): void {
    switch (message.type) {
      case 'session.snapshot':
        this.sessionBackendIndex.set(
          message.session.sessionId,
          message.session.backendId,
        );
        return;
      case 'session.removed':
        this.sessionBackendIndex.delete(message.sessionId);
        return;
      case 'ready':
      case 'session.init':
      case 'session.output':
      case 'workspace.updated':
      case 'attention.init':
      case 'attention.event':
      case 'markdown.init':
      case 'markdown.document':
      case 'markdown.link.init':
      case 'markdown.link':
        return;
    }
  }

  private broadcastSession(message: TerminalServerSocketMessage): void {
    for (const listener of this.sessionListeners) {
      listener(message);
    }
  }

  private broadcastAttention(event: AttentionEvent): void {
    for (const listener of this.attentionListeners) {
      listener(event);
    }
  }
}

class RemoteBackendClient {
  private connection: BackendConnection;

  private readonly sessions = new Map<string, TerminalSessionSnapshot>();

  private attentionEvents: AttentionEvent[] = [];

  private socket: WebSocket | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private knownTerminals = new Set<string>();

  private status: BackendStatus;

  constructor(
    private readonly logger: FastifyBaseLogger,
    connection: BackendConnection,
    private readonly listeners: {
      onSessionMessage: (message: TerminalServerSocketMessage) => void;
      onAttentionEvent: (event: AttentionEvent) => void;
    },
  ) {
    this.connection = connection;
    this.status = createBackendStatus(connection, 'connecting', null, null);
  }

  start(): void {
    void this.connect();
  }

  updateConnection(connection: BackendConnection): void {
    const changed =
      this.connection.baseUrl !== connection.baseUrl ||
      this.connection.token !== connection.token;
    this.connection = connection;
    this.status = {
      ...this.status,
      label: connection.label,
      baseUrl: connection.baseUrl,
      updatedAt: new Date().toISOString(),
    };

    if (changed) {
      this.closeSocket();
      void this.connect();
    }
  }

  setKnownTerminals(terminals: TerminalNode[]): void {
    this.knownTerminals = new Set(terminals.map((terminal) => terminal.id));
    this.pruneUnknownSnapshots();
  }

  getSnapshots(): TerminalSessionSnapshot[] {
    return [...this.sessions.values()];
  }

  getAttentionEvents(): AttentionEvent[] {
    return this.attentionEvents;
  }

  getStatus(): BackendStatus {
    return this.status;
  }

  sendInput(sessionId: string, data: string): boolean {
    void this.post(`/api/backend/sessions/${encodeURIComponent(sessionId)}/input`, {
      data,
    });
    return true;
  }

  resizeSession(sessionId: string, cols: number, rows: number): boolean {
    void this.post(`/api/backend/sessions/${encodeURIComponent(sessionId)}/resize`, {
      cols,
      rows,
    });
    return true;
  }

  restartSession(sessionId: string): boolean {
    void this.post(`/api/backend/sessions/${encodeURIComponent(sessionId)}/restart`, {});
    return true;
  }

  markRead(sessionId: string): boolean {
    void this.post(`/api/backend/sessions/${encodeURIComponent(sessionId)}/mark-read`, {});
    return true;
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.closeSocket();
  }

  private async connect(): Promise<void> {
    if (this.socket) {
      return;
    }

    const wsUrl = toWebSocketUrl(this.connection.baseUrl, '/ws/backend', this.connection.token);
    this.status = createBackendStatus(this.connection, 'connecting', null, null);
    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.status = createBackendStatus(
        this.connection,
        'connected',
        null,
        new Date().toISOString(),
      );
      this.logger.info({ baseUrl: this.connection.baseUrl }, 'Connected remote backend socket');
    });

    socket.addEventListener('message', (event) => {
      const parsed = parseJsonMessage(
        String(event.data),
        terminalServerSocketMessageSchema,
      );

      if (!parsed) {
        return;
      }

      this.handleMessage(parsed);
    });

    socket.addEventListener('error', () => {
      this.status = createBackendStatus(
        this.connection,
        'error',
        'Remote backend socket failed.',
        null,
      );
    });

    socket.addEventListener('close', () => {
      this.socket = null;
      this.markDisconnected('Remote backend connection closed.');
      this.scheduleReconnect();
    });
  }

  private handleMessage(message: TerminalServerSocketMessage): void {
    switch (message.type) {
      case 'ready':
        return;
      case 'session.init': {
        this.sessions.clear();

        for (const session of message.sessions) {
          const rewritten = this.rewriteSnapshot(session);

          if (!this.shouldTrackSession(rewritten.sessionId)) {
            continue;
          }

          this.sessions.set(rewritten.sessionId, rewritten);
          this.listeners.onSessionMessage({
            type: 'session.snapshot',
            session: rewritten,
          });
        }
        return;
      }
      case 'session.snapshot': {
        const rewritten = this.rewriteSnapshot(message.session);

        if (!this.shouldTrackSession(rewritten.sessionId)) {
          return;
        }

        this.sessions.set(rewritten.sessionId, rewritten);
        this.listeners.onSessionMessage({
          type: 'session.snapshot',
          session: rewritten,
        });
        return;
      }
      case 'session.output': {
        if (!this.shouldTrackSession(message.sessionId)) {
          return;
        }

        this.listeners.onSessionMessage({
          ...message,
          backendId: this.connection.id,
        });
        return;
      }
      case 'session.removed': {
        this.sessions.delete(message.sessionId);

        if (!this.shouldTrackSession(message.sessionId)) {
          return;
        }

        this.listeners.onSessionMessage({
          ...message,
          backendId: this.connection.id,
        });
        return;
      }
      case 'attention.init':
        this.attentionEvents = message.events
          .map((event) => this.rewriteAttentionEvent(event))
          .filter((event) => this.shouldTrackSession(event.sessionId));
        return;
      case 'attention.event': {
        const rewritten = this.rewriteAttentionEvent(message.event);

        if (!this.shouldTrackSession(rewritten.sessionId)) {
          return;
        }

        this.attentionEvents = [rewritten, ...this.attentionEvents].slice(0, 48);
        this.listeners.onAttentionEvent(rewritten);
        return;
      }
      case 'markdown.init':
      case 'markdown.document':
      case 'markdown.link.init':
      case 'markdown.link':
        return;
    }
  }

  private rewriteSnapshot(snapshot: TerminalSessionSnapshot): TerminalSessionSnapshot {
    return {
      ...snapshot,
      backendId: this.connection.id,
    };
  }

  private rewriteAttentionEvent(event: AttentionEvent): AttentionEvent {
    return {
      ...event,
      backendId: this.connection.id,
    };
  }

  private shouldTrackSession(sessionId: string): boolean {
    return !this.knownTerminals.size || this.knownTerminals.has(sessionId);
  }

  private pruneUnknownSnapshots(): void {
    if (!this.knownTerminals.size) {
      return;
    }

    for (const sessionId of this.sessions.keys()) {
      if (this.knownTerminals.has(sessionId)) {
        continue;
      }

      this.sessions.delete(sessionId);
    }

    this.attentionEvents = this.attentionEvents.filter((event) =>
      this.knownTerminals.has(event.sessionId),
    );
  }

  private markDisconnected(reason: string): void {
    const timestamp = new Date().toISOString();
    this.status = createBackendStatus(this.connection, 'disconnected', reason, null);

    for (const [sessionId, snapshot] of this.sessions) {
      const disconnected: TerminalSessionSnapshot = {
        ...snapshot,
        status: 'disconnected',
        connected: false,
        disconnectReason: reason,
        lastActivityAt: timestamp,
      };
      this.sessions.set(sessionId, disconnected);
      this.listeners.onSessionMessage({
        type: 'session.snapshot',
        session: disconnected,
      });
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, 1_000);
  }

  private closeSocket(): void {
    if (!this.socket) {
      return;
    }

    try {
      this.socket.close();
    } catch {
      // Ignore shutdown races.
    }

    this.socket = null;
  }

  private async post(path: string, body: object): Promise<void> {
    try {
      const response = await fetch(resolveUrl(this.connection.baseUrl, path), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-terminal-canvas-token': this.connection.token,
        },
        body: serializeJsonMessage(body),
      });

      if (response.status === 401) {
        this.status = createBackendStatus(
          this.connection,
          'auth-failed',
          'Remote backend rejected the token.',
          null,
        );
      }
    } catch (error) {
      this.logger.warn(
        { error: error instanceof Error ? error.message : String(error), path },
        'Remote backend request failed',
      );
    }
  }
}

function createBackendStatus(
  connection: BackendConnection,
  state: BackendStatus['state'],
  lastError: string | null,
  connectedAt: string | null,
): BackendStatus {
  return {
    id: connection.id,
    label: connection.label,
    baseUrl: connection.baseUrl,
    state,
    lastError,
    connectedAt,
    updatedAt: new Date().toISOString(),
    tunnel: null,
  };
}

function resolveUrl(baseUrl: string, path: string): string {
  return new URL(path, appendTrailingSlash(baseUrl)).toString();
}

function toWebSocketUrl(baseUrl: string, path: string, token: string): string {
  const url = new URL(path, appendTrailingSlash(baseUrl));
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  return url.toString();
}

function appendTrailingSlash(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

export function buildSessionBackendIndex(
  workspace: Workspace,
  localBackendId: string,
): Map<string, string> {
  return new Map(
    workspace.terminals.map((terminal) => [
      terminal.id,
      terminal.backendId ?? localBackendId,
    ]),
  );
}
