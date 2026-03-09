import type { Edge, NodeChange } from '@xyflow/react';

import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import type { Workspace } from '../../shared/workspace';
import type { MarkdownFlowNode, TerminalFlowNode } from '../terminals/types';

export type CanvasNode = TerminalFlowNode | MarkdownFlowNode;

interface BuildCanvasNodesOptions {
  workspace: Workspace;
  selectedNodeId: string | null;
  sessions: Record<string, TerminalSessionSnapshot>;
  socketState: 'connecting' | 'open' | 'closed' | 'error';
  onSelect: (nodeId: string) => void;
  onBoundsChange: (
    nodeId: string,
    bounds: Partial<Workspace['terminals'][number]['bounds']>,
  ) => void;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onRestart: (sessionId: string) => void;
  onMarkRead: (sessionId: string) => void;
}

export function buildCanvasNodes({
  workspace,
  selectedNodeId,
  sessions,
  socketState,
  onSelect,
  onBoundsChange,
  onInput,
  onResize,
  onRestart,
  onMarkRead,
}: BuildCanvasNodesOptions): CanvasNode[] {
  const terminals = workspace.terminals.map((terminal) => ({
    id: terminal.id,
    type: 'terminal' as const,
    position: {
      x: terminal.bounds.x,
      y: terminal.bounds.y,
    },
    width: terminal.bounds.width,
    height: terminal.bounds.height,
    data: {
      terminal,
      session: sessions[terminal.id] ?? null,
      isInteractive: selectedNodeId === terminal.id,
      socketState,
      onSelect,
      onBoundsChange,
      onInput,
      onResize,
      onRestart,
      onMarkRead,
    },
    style: {
      width: terminal.bounds.width,
      height: terminal.bounds.height,
    },
    dragHandle: '.node-drag-handle',
    selected: selectedNodeId === terminal.id,
    selectable: true as const,
  }));

  const markdown = workspace.markdown.map((node) => ({
    id: node.id,
    type: 'markdown' as const,
    position: {
      x: node.bounds.x,
      y: node.bounds.y,
    },
    width: node.bounds.width,
    height: node.bounds.height,
    data: {
      markdown: node,
      onSelect,
      onBoundsChange,
    },
    style: {
      width: node.bounds.width,
      height: node.bounds.height,
    },
    dragHandle: '.node-drag-handle',
    selected: selectedNodeId === node.id,
    selectable: true as const,
  }));

  return [...terminals, ...markdown];
}

export function buildCanvasEdges(workspace: Workspace): Edge[] {
  return workspace.markdown.flatMap((markdown) =>
    markdown.linkedTerminalIds
      .filter((terminalId) =>
        workspace.terminals.some((terminal) => terminal.id === terminalId),
      )
      .map((terminalId) => ({
        id: `link-${markdown.id}-${terminalId}`,
        source: markdown.id,
        target: terminalId,
        type: 'smoothstep',
        animated: false,
        selectable: false,
        style: {
          stroke: 'rgba(136, 182, 221, 0.45)',
          strokeWidth: 1.5,
        },
      })),
  );
}

export function applyNodeChangesToWorkspace(
  workspace: Workspace,
  changes: NodeChange[],
): Workspace {
  let nextWorkspace = workspace;

  for (const change of changes) {
    if (change.type === 'position' && change.position) {
      nextWorkspace = updateNodeBounds(nextWorkspace, change.id, {
        x: change.position.x,
        y: change.position.y,
      });
    }

    if (change.type === 'dimensions' && change.dimensions) {
      nextWorkspace = updateNodeBounds(nextWorkspace, change.id, {
        width: change.dimensions.width,
        height: change.dimensions.height,
      });
    }

    if (change.type === 'remove') {
      nextWorkspace = {
        ...nextWorkspace,
        terminals: nextWorkspace.terminals.filter(
          (terminal) => terminal.id !== change.id,
        ),
        markdown: nextWorkspace.markdown.filter(
          (markdown) => markdown.id !== change.id,
        ),
      };
    }
  }

  return nextWorkspace;
}

export function updateNodeBounds(
  workspace: Workspace,
  nodeId: string,
  partialBounds: Partial<Workspace['terminals'][number]['bounds']>,
): Workspace {
  const terminalIndex = workspace.terminals.findIndex(
    (terminal) => terminal.id === nodeId,
  );

  if (terminalIndex !== -1) {
    return {
      ...workspace,
      terminals: workspace.terminals.map((terminal, index) =>
        index === terminalIndex
          ? {
              ...terminal,
              bounds: {
                ...terminal.bounds,
                ...partialBounds,
              },
            }
          : terminal,
      ),
    };
  }

  const markdownIndex = workspace.markdown.findIndex(
    (markdown) => markdown.id === nodeId,
  );

  if (markdownIndex !== -1) {
    return {
      ...workspace,
      markdown: workspace.markdown.map((markdown, index) =>
        index === markdownIndex
          ? {
              ...markdown,
              bounds: {
                ...markdown.bounds,
                ...partialBounds,
              },
            }
          : markdown,
      ),
    };
  }

  return workspace;
}
