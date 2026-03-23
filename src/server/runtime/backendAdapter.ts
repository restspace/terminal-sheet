import type { BackendConnection, BackendStatus } from '../../shared/backends';
import type { AttentionEvent } from '../../shared/events';
import type {
  TerminalServerSocketMessage,
  TerminalSessionSnapshot,
} from '../../shared/terminalSessions';
import type { Workspace } from '../../shared/workspace';

export type SessionListener = (message: TerminalServerSocketMessage) => void;
export type AttentionListener = (event: AttentionEvent) => void;

export interface BackendAdapter {
  readonly backendId: string;
  syncWithWorkspace(workspace: Workspace): Promise<void>;
  getSnapshots(): TerminalSessionSnapshot[];
  getAttentionEvents(): AttentionEvent[];
  getStatus(): BackendStatus | null;
  subscribeSession(listener: SessionListener): () => void;
  subscribeAttention(listener: AttentionListener): () => void;
  sendInput(sessionId: string, data: string): boolean;
  resizeSession(sessionId: string, cols: number, rows: number): boolean;
  restartSession(sessionId: string): boolean;
  markRead(sessionId: string): boolean;
  close(): Promise<void> | void;
}

export interface ConnectionAwareBackendAdapter extends BackendAdapter {
  updateConnection(connection: BackendConnection): void;
}

export function isConnectionAwareBackendAdapter(
  adapter: BackendAdapter,
): adapter is ConnectionAwareBackendAdapter {
  return typeof (adapter as Partial<ConnectionAwareBackendAdapter>).updateConnection === 'function';
}
