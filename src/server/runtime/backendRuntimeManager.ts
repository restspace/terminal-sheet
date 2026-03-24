import { type FastifyBaseLogger } from 'fastify';

import type { BackendStatus, ServerRole } from '../../shared/backends';
import type { AttentionEvent } from '../../shared/events';
import type {
  TerminalServerSocketMessage,
  TerminalSessionSnapshot,
} from '../../shared/terminalSessions';
import type { Workspace } from '../../shared/workspace';
import type { AttentionService } from '../integrations/attentionService';
import type { WorkspaceService } from '../persistence/workspaceService';
import type { PtySessionManager } from '../pty/ptySessionManager';
import {
  type AttentionListener,
  type BackendAdapter,
  isConnectionAwareBackendAdapter,
  type SessionListener,
} from './backendAdapter';
import { LocalBackendAdapter } from './localBackendAdapter';
import { RemoteBackendAdapter } from './remoteBackendAdapter';

export class BackendRuntimeManager {
  private readonly sessionListeners = new Set<SessionListener>();

  private readonly attentionListeners = new Set<AttentionListener>();

  private readonly adapters = new Map<string, BackendAdapter>();

  private readonly adapterSubscriptions = new Map<string, () => void>();

  private readonly sessionBackendIndex = new Map<string, string>();

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
    this.registerAdapter(
      new LocalBackendAdapter(
        options.localBackendId,
        options.localPtySessionManager,
        options.localAttentionService,
        this.logger.child({ backendId: options.localBackendId }),
      ),
    );
  }

  async syncWithWorkspace(workspace: Workspace): Promise<void> {
    this.sessionBackendIndex.clear();
    for (const [sessionId, backendId] of buildSessionBackendIndex(
      workspace,
      this.options.localBackendId,
    )) {
      this.sessionBackendIndex.set(sessionId, backendId);
    }

    await this.getLocalAdapter().syncWithWorkspace(workspace);

    if (this.options.role !== 'home') {
      await this.pruneRemoteAdapters(new Set<string>());
      return;
    }

    const activeBackendIds = new Set<string>();

    for (const backend of workspace.backends) {
      if (!backend.enabled) {
        continue;
      }

      activeBackendIds.add(backend.id);
      const existing = this.adapters.get(backend.id);
      const adapter =
        existing ??
        this.registerAdapter(
          new RemoteBackendAdapter(
            this.logger.child({ backendId: backend.id }),
            backend,
          ),
        );

      if (existing && isConnectionAwareBackendAdapter(existing)) {
        existing.updateConnection(backend);
      }

      await adapter.syncWithWorkspace(workspace);
    }

    await this.pruneRemoteAdapters(activeBackendIds);
  }

  getSnapshots(): TerminalSessionSnapshot[] {
    return [...this.adapters.values()].flatMap((adapter) => adapter.getSnapshots());
  }

  getAttentionEvents(): AttentionEvent[] {
    return [...this.adapters.values()]
      .flatMap((adapter) => adapter.getAttentionEvents())
      .sort((left, right) => right.timestamp.localeCompare(left.timestamp));
  }

  getBackendStatuses(): BackendStatus[] {
    return [...this.adapters.values()]
      .map((adapter) => adapter.getStatus())
      .filter((status): status is BackendStatus => status !== null);
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
    return this.getAdapterForSession(sessionId).sendInput(sessionId, data);
  }

  resizeSession(
    sessionId: string,
    cols: number,
    rows: number,
    generation: number,
  ): boolean {
    return this.getAdapterForSession(sessionId).resizeSession(
      sessionId,
      cols,
      rows,
      generation,
    );
  }

  restartSession(sessionId: string): boolean {
    return this.getAdapterForSession(sessionId).restartSession(sessionId);
  }

  markRead(sessionId: string): boolean {
    return this.getAdapterForSession(sessionId).markRead(sessionId);
  }

  async close(): Promise<void> {
    for (const unsubscribe of this.adapterSubscriptions.values()) {
      unsubscribe();
    }
    this.adapterSubscriptions.clear();

    for (const adapter of this.adapters.values()) {
      await adapter.close();
    }
    this.adapters.clear();
  }

  private getLocalAdapter(): BackendAdapter {
    return this.adapters.get(this.options.localBackendId) as BackendAdapter;
  }

  private getAdapterForSession(sessionId: string): BackendAdapter {
    const backendId =
      this.sessionBackendIndex.get(sessionId) ?? this.options.localBackendId;

    return this.adapters.get(backendId) ?? this.getLocalAdapter();
  }

  private registerAdapter(adapter: BackendAdapter): BackendAdapter {
    this.adapters.set(adapter.backendId, adapter);
    this.adapterSubscriptions.set(
      adapter.backendId,
      this.attachAdapterListeners(adapter),
    );
    return adapter;
  }

  private attachAdapterListeners(adapter: BackendAdapter): () => void {
    const unsubscribeSession = adapter.subscribeSession((message) => {
      this.indexSessionMessage(message);
      this.broadcastSession(message);
    });
    const unsubscribeAttention = adapter.subscribeAttention((event) => {
      this.broadcastAttention(event);
    });

    return () => {
      unsubscribeSession();
      unsubscribeAttention();
    };
  }

  private async pruneRemoteAdapters(
    activeBackendIds: ReadonlySet<string>,
  ): Promise<void> {
    for (const [backendId, adapter] of this.adapters) {
      if (
        backendId === this.options.localBackendId ||
        activeBackendIds.has(backendId)
      ) {
        continue;
      }

      this.adapterSubscriptions.get(backendId)?.();
      this.adapterSubscriptions.delete(backendId);
      this.adapters.delete(backendId);
      await adapter.close();
    }
  }

  private indexSessionMessage(message: TerminalServerSocketMessage): void {
    switch (message.type) {
      case 'frontend.lease':
      case 'frontend.locked':
        return;
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
      try {
        listener(message);
      } catch (error) {
        this.logger.warn(
          {
            messageType: message.type,
            error: error instanceof Error ? error.message : String(error),
          },
          'Runtime session listener failed',
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
            sessionId: event.sessionId,
            backendId: event.backendId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Runtime attention listener failed',
        );
      }
    }
  }
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
