import { type FastifyBaseLogger } from 'fastify';

import type { BackendConnection, BackendStatus } from '../../shared/backends';
import type { AttentionEvent } from '../../shared/events';
import { parseJsonMessage, serializeJsonMessage } from '../../shared/jsonTransport';
import { appendScrollback } from '../../shared/scrollback';
import {
  terminalServerSocketMessageSchema,
  type TerminalServerSocketMessage,
  type TerminalSessionOutputState,
  type TerminalSessionSnapshot,
} from '../../shared/terminalSessions';
import type { TerminalNode, Workspace } from '../../shared/workspace';
import type {
  AttentionListener,
  ConnectionAwareBackendAdapter,
  SessionListener,
} from './backendAdapter';

export class RemoteBackendAdapter implements ConnectionAwareBackendAdapter {
  private connection: BackendConnection;

  private readonly sessions = new Map<string, TerminalSessionSnapshot>();

  private attentionEvents: AttentionEvent[] = [];

  private readonly sessionListeners = new Set<SessionListener>();

  private readonly attentionListeners = new Set<AttentionListener>();

  private socket: WebSocket | null = null;

  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private isDisposed = false;

  private reconnectAttempts = 0;
  private isAuthFailed = false;

  private knownTerminals = new Set<string>();

  private status: BackendStatus;

  constructor(
    private readonly logger: FastifyBaseLogger,
    connection: BackendConnection,
  ) {
    this.connection = connection;
    this.status = createBackendStatus(connection, 'connecting', null, null);
  }

  get backendId(): string {
    return this.connection.id;
  }

  async syncWithWorkspace(workspace: Workspace): Promise<void> {
    this.setKnownTerminals(
      workspace.terminals.filter(
        (terminal) => terminal.backendId === this.connection.id,
      ),
    );
    this.start();
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
      this.isAuthFailed = false;
      this.reconnectAttempts = 0;
      this.closeSocket();
      void this.connect();
    }
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
    void this.post(`/api/backend/sessions/${encodeURIComponent(sessionId)}/input`, {
      data,
    });
    return true;
  }

  resizeSession(
    sessionId: string,
    cols: number,
    rows: number,
    generation: number,
  ): boolean {
    void this.post(`/api/backend/sessions/${encodeURIComponent(sessionId)}/resize`, {
      cols,
      rows,
      generation,
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
    this.isDisposed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    this.closeSocket();
  }

  private start(): void {
    void this.connect();
  }

  private setKnownTerminals(terminals: TerminalNode[]): void {
    this.knownTerminals = new Set(terminals.map((terminal) => terminal.id));
    this.pruneUnknownSnapshots();
  }

  private async connect(): Promise<void> {
    if (this.socket || this.isDisposed) {
      return;
    }

    const wsUrl = toWebSocketUrl(
      this.connection.baseUrl,
      '/ws/backend',
      this.connection.token,
    );
    this.status = createBackendStatus(this.connection, 'connecting', null, null);
    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    socket.addEventListener('open', () => {
      this.reconnectAttempts = 0;
      this.isAuthFailed = false;
      this.status = createBackendStatus(
        this.connection,
        'connected',
        null,
        new Date().toISOString(),
      );
      this.logger.info(
        { baseUrl: this.connection.baseUrl },
        'Connected remote backend socket',
      );
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

      if (this.isDisposed) {
        return;
      }

      this.markDisconnected('Remote backend connection closed.');
      this.scheduleReconnect();
    });
  }

  private handleMessage(message: TerminalServerSocketMessage): void {
    switch (message.type) {
      case 'frontend.lease':
      case 'frontend.locked':
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
          this.broadcastSession({
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
        this.broadcastSession({
          type: 'session.snapshot',
          session: rewritten,
        });
        return;
      }
      case 'session.output': {
        if (!this.shouldTrackSession(message.sessionId)) {
          return;
        }

        const existing = this.sessions.get(message.sessionId);
        const nextSnapshot = mergeRemoteSessionOutput(
          existing,
          this.connection.id,
          message.sessionId,
          message.data,
          message.state,
        );
        this.sessions.set(message.sessionId, nextSnapshot);

        this.broadcastSession({
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

        this.broadcastSession({
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
        this.broadcastAttention(rewritten);
        return;
      }
      case 'workspace.updated':
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
      this.broadcastSession({
        type: 'session.snapshot',
        session: disconnected,
      });
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.isAuthFailed) {
      return;
    }

    const delayMs = Math.min(30_000, 1_000 * 2 ** this.reconnectAttempts);
    this.reconnectAttempts += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, delayMs);
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

  private broadcastSession(message: TerminalServerSocketMessage): void {
    for (const listener of this.sessionListeners) {
      try {
        listener(message);
      } catch (error) {
        this.logger.warn(
          {
            backendId: this.connection.id,
            messageType: message.type,
            error: error instanceof Error ? error.message : String(error),
          },
          'Remote backend session listener failed',
        );
      }
    }
  }

  private broadcastAttention(event: AttentionEvent): void {
    for (const listener of this.attentionListeners) {
      try {
        listener(event);
      } catch (error) {
        this.logger.warn(
          {
            backendId: this.connection.id,
            sessionId: event.sessionId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Remote backend attention listener failed',
        );
      }
    }
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
        this.isAuthFailed = true;
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

function mergeRemoteSessionOutput(
  existing: TerminalSessionSnapshot | undefined,
  backendId: string,
  sessionId: string,
  data: string,
  state: TerminalSessionOutputState,
): TerminalSessionSnapshot {
  const scrollback = appendScrollback(existing?.scrollback ?? '', data);

  if (!existing) {
    return {
      sessionId,
      backendId,
      scrollback,
      ...state,
    };
  }

  return {
    ...existing,
    ...state,
    backendId,
    scrollback,
  };
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
