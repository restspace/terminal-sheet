import type { Node } from '@xyflow/react';

import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import type { MarkdownNode, TerminalNode } from '../../shared/workspace';

export interface TerminalNodeData extends Record<string, unknown> {
  terminal: TerminalNode;
  session: TerminalSessionSnapshot | null;
  isInteractive: boolean;
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
}

export interface MarkdownNodeData extends Record<string, unknown> {
  markdown: MarkdownNode;
  onSelect: (nodeId: string) => void;
  onBoundsChange: (
    nodeId: string,
    bounds: Partial<MarkdownNode['bounds']>,
  ) => void;
}

export type TerminalFlowNode = Node<TerminalNodeData, 'terminal'>;
export type MarkdownFlowNode = Node<MarkdownNodeData, 'markdown'>;
