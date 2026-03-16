import type { Node } from '@xyflow/react';

import type {
  MarkdownDocumentState,
  MarkdownLinkState,
} from '../../shared/markdown';
import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import type { MarkdownNode, TerminalNode } from '../../shared/workspace';
import type { TerminalPresentationMode } from './presentationMode';

export interface TerminalNodeData extends Record<string, unknown> {
  terminal: TerminalNode;
  session: TerminalSessionSnapshot | null;
  presentationMode: TerminalPresentationMode;
  mountLivePreview: boolean;
  socketState: 'connecting' | 'open' | 'closed' | 'error';
  onSelect: (nodeId: string) => void;
  onBoundsChange: (
    nodeId: string,
    bounds: Partial<TerminalNode['bounds']>,
  ) => void;
  onTerminalChange: (
    nodeId: string,
    patch: Partial<Pick<TerminalNode, 'label' | 'cwd'>>,
  ) => void;
  onRemove: (terminalId: string) => void;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onRestart: (sessionId: string) => void;
  onMarkRead: (sessionId: string) => void;
  onMarkdownDrop: (markdownNodeId: string, terminalId: string) => void;
  activeMarkdownLink: MarkdownLinkState | null;
  allowResize: boolean;
}

export interface MarkdownNodeData extends Record<string, unknown> {
  markdown: MarkdownNode;
  document: MarkdownDocumentState | null;
  activeLinks: MarkdownLinkState[];
  onSelect: (nodeId: string) => void;
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
}

export type TerminalFlowNode = Node<TerminalNodeData, 'terminal'>;
export type MarkdownFlowNode = Node<MarkdownNodeData, 'markdown'>;
