import type { Node } from '@xyflow/react';

import type {
  MarkdownDocumentState,
  MarkdownLinkState,
} from '../../shared/markdown';
import type { SemanticZoomMode } from '../../shared/workspace';
import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import type { MarkdownNode, TerminalNode } from '../../shared/workspace';
import type { BackendAccent } from '../canvas/backendAccents';
import type { TerminalSurfaceModel } from './terminalSurfaceModel';

export interface TerminalNodeData extends Record<string, unknown> {
  terminal: TerminalNode;
  backendAccent: BackendAccent | null;
  session: TerminalSessionSnapshot | null;
  surfaceModel: TerminalSurfaceModel;
  autoFocusAtMs: number | null;
  socketState: 'connecting' | 'open' | 'closed' | 'error';
  onBoundsChange: (
    nodeId: string,
    bounds: Partial<TerminalNode['bounds']>,
  ) => void;
  onTerminalChange: (
    nodeId: string,
    patch: Partial<Pick<TerminalNode, 'label' | 'cwd'>>,
  ) => void;
  onPathSelectRequest: (terminalId: string) => void;
  onRemove: (terminalId: string) => void;
  onInput: (sessionId: string, data: string) => void;
  onResize: (
    sessionId: string,
    cols: number,
    rows: number,
  ) => boolean | void;
  onResizeSyncError?: (details: {
    sessionId: string;
    cols: number;
    rows: number;
    timeoutMs: number;
  }) => void;
  onRestart: (sessionId: string) => void;
  onMarkRead: (sessionId: string) => void;
  onMarkdownDrop: (markdownNodeId: string, terminalId: string) => void;
  activeMarkdownLink: MarkdownLinkState | null;
  deferResizeSync: boolean;
  allowResize: boolean;
  resizeZoom: number;
}

export interface MarkdownNodeData extends Record<string, unknown> {
  markdown: MarkdownNode;
  document: MarkdownDocumentState | null;
  activeLinks: readonly MarkdownLinkState[];
  onFocusRequest: (nodeId: string) => void;
  onRemove: (nodeId: string) => void;
  onBoundsChange: (
    nodeId: string,
    bounds: Partial<MarkdownNode['bounds']>,
  ) => void;
  onDocumentLoad: (nodeId: string) => void;
  onDocumentChange: (nodeId: string, content: string) => void;
  onDocumentSave: (nodeId: string) => void;
  onResolveConflict: (
    nodeId: string,
    choice: 'reload-disk' | 'overwrite-disk' | 'keep-buffer',
  ) => void;
  allowResize: boolean;
  resizeZoom: number;
  semanticZoomMode: SemanticZoomMode;
}

export type TerminalFlowNode = Node<TerminalNodeData, 'terminal'>;
export type MarkdownFlowNode = Node<MarkdownNodeData, 'markdown'>;
