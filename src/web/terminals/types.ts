import type { Node } from '@xyflow/react';

import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import type { MarkdownNode, TerminalNode } from '../../shared/workspace';

export interface TerminalNodeData extends Record<string, unknown> {
  terminal: TerminalNode;
  session: TerminalSessionSnapshot | null;
  isInteractive: boolean;
  socketState: 'connecting' | 'open' | 'closed' | 'error';
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onRestart: (sessionId: string) => void;
  onMarkRead: (sessionId: string) => void;
}

export interface MarkdownNodeData extends Record<string, unknown> {
  markdown: MarkdownNode;
}

export type TerminalFlowNode = Node<TerminalNodeData, 'terminal'>;
export type MarkdownFlowNode = Node<MarkdownNodeData, 'markdown'>;
