import type { AttentionService } from '../integrations/attentionService';
import type { PtySessionManager } from '../pty/ptySessionManager';
import type {
  AttentionListener,
  BackendAdapter,
  SessionListener,
} from './backendAdapter';
import type { Workspace } from '../../shared/workspace';

export class LocalBackendAdapter implements BackendAdapter {
  private readonly sessionListeners = new Set<SessionListener>();

  private readonly attentionListeners = new Set<AttentionListener>();

  private readonly unsubscribeSession: () => void;

  private readonly unsubscribeAttention: () => void;

  constructor(
    readonly backendId: string,
    private readonly ptySessionManager: PtySessionManager,
    private readonly attentionService: AttentionService,
  ) {
    this.unsubscribeSession = this.ptySessionManager.subscribe((message) => {
      for (const listener of this.sessionListeners) {
        listener(message);
      }
    });
    this.unsubscribeAttention = this.attentionService.subscribe((event) => {
      for (const listener of this.attentionListeners) {
        listener(event);
      }
    });
  }

  async syncWithWorkspace(workspace: Workspace): Promise<void> {
    await this.ptySessionManager.syncWithWorkspace(workspace);
  }

  getSnapshots() {
    return this.ptySessionManager.getSnapshots();
  }

  getAttentionEvents() {
    return this.attentionService.getEvents();
  }

  getStatus() {
    return null;
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
    return this.ptySessionManager.sendInput(sessionId, data);
  }

  resizeSession(sessionId: string, cols: number, rows: number): boolean {
    return this.ptySessionManager.resizeSession(sessionId, cols, rows);
  }

  restartSession(sessionId: string): boolean {
    return this.ptySessionManager.restartSession(sessionId);
  }

  markRead(sessionId: string): boolean {
    return this.ptySessionManager.markRead(sessionId);
  }

  close(): void {
    this.unsubscribeSession();
    this.unsubscribeAttention();
    this.sessionListeners.clear();
    this.attentionListeners.clear();
  }
}
