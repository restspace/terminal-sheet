import type { Edge, NodeChange } from '@xyflow/react';

import { updateById } from '../../shared/collections';
import type {
  MarkdownDocumentState,
  MarkdownLinkState,
} from '../../shared/markdown';
import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import type { SemanticZoomMode, Workspace } from '../../shared/workspace';
import type { BackendAccent } from './backendAccents';
import type { TerminalPresentationMode } from '../terminals/presentationMode';
import type { MarkdownFlowNode, TerminalFlowNode } from '../terminals/types';

export type CanvasNode = TerminalFlowNode | MarkdownFlowNode;

export function getSelectedNodeIdFromChanges(
  changes: NodeChange[],
): string | null | undefined {
  let sawSelectionChange = false;

  for (let index = changes.length - 1; index >= 0; index -= 1) {
    const change = changes[index];

    if (change?.type !== 'select') {
      continue;
    }

    sawSelectionChange = true;

    if (change.selected) {
      return change.id;
    }
  }

  return sawSelectionChange ? null : undefined;
}

interface BuildCanvasNodesOptions {
  workspace: Workspace;
  backendAccents: ReadonlyMap<string, BackendAccent>;
  selectedNodeId: string | null;
  renderedBoundsByNodeId: ReadonlyMap<
    string,
    Workspace['terminals'][number]['bounds']
  >;
  nodesDraggable: boolean;
  nodesResizable: boolean;
  livePreviewTerminalIds: ReadonlySet<string>;
  focusAutoFocusAtMs: number | null;
  viewportZoom: number;
  semanticZoomMode: SemanticZoomMode;
  terminalPresentationById: ReadonlyMap<string, TerminalPresentationMode>;
  sessions: Record<string, TerminalSessionSnapshot>;
  markdownDocuments: Record<string, MarkdownDocumentState>;
  activeMarkdownLinkByTerminalId: ReadonlyMap<string, MarkdownLinkState>;
  activeMarkdownLinksByNodeId: ReadonlyMap<string, readonly MarkdownLinkState[]>;
  socketState: 'connecting' | 'open' | 'closed' | 'error';
  onSelect: (nodeId: string) => void;
  onBoundsChange: (
    nodeId: string,
    bounds: Partial<Workspace['terminals'][number]['bounds']>,
  ) => void;
  onTerminalChange: (
    nodeId: string,
    patch: Partial<Pick<Workspace['terminals'][number], 'label' | 'cwd'>>,
  ) => void;
  onPathSelectRequest: (terminalId: string) => void;
  onRemove: (terminalId: string) => void;
  onInput: (sessionId: string, data: string) => void;
  onResize: (sessionId: string, cols: number, rows: number) => void;
  onRestart: (sessionId: string) => void;
  onMarkRead: (sessionId: string) => void;
  onMarkdownDrop: (markdownNodeId: string, terminalId: string) => void;
  onMarkdownFocusRequest: (nodeId: string) => void;
  onMarkdownRemove: (nodeId: string) => void;
  onDocumentLoad: (nodeId: string) => void;
  onDocumentChange: (nodeId: string, content: string) => void;
  onDocumentSave: (nodeId: string) => void;
  onResolveConflict: (
    nodeId: string,
    choice: 'reload-disk' | 'overwrite-disk' | 'keep-buffer',
  ) => void;
}

export function buildCanvasNodes({
  workspace,
  backendAccents,
  selectedNodeId,
  renderedBoundsByNodeId,
  nodesDraggable,
  nodesResizable,
  livePreviewTerminalIds,
  focusAutoFocusAtMs,
  viewportZoom,
  semanticZoomMode,
  terminalPresentationById,
  sessions,
  markdownDocuments,
  activeMarkdownLinkByTerminalId,
  activeMarkdownLinksByNodeId,
  socketState,
  onSelect,
  onBoundsChange,
  onTerminalChange,
  onPathSelectRequest,
  onRemove,
  onInput,
  onResize,
  onRestart,
  onMarkRead,
  onMarkdownDrop,
  onMarkdownFocusRequest,
  onMarkdownRemove,
  onDocumentLoad,
  onDocumentChange,
  onDocumentSave,
  onResolveConflict,
}: BuildCanvasNodesOptions): CanvasNode[] {
  const terminals = workspace.terminals.map((terminal) => {
    const presentationMode =
      terminalPresentationById.get(terminal.id) ?? 'overview';
    const isFocusTarget = presentationMode === 'focus';
    const renderedBounds = renderedBoundsByNodeId.get(terminal.id) ?? terminal.bounds;

    return {
      id: terminal.id,
      type: 'terminal' as const,
      position: {
        x: renderedBounds.x,
        y: renderedBounds.y,
      },
      width: renderedBounds.width,
      height: renderedBounds.height,
      data: {
        terminal,
        backendAccent: backendAccents.get(terminal.backendId ?? '') ?? null,
        session: sessions[terminal.id] ?? null,
        presentationMode,
        mountLivePreview: livePreviewTerminalIds.has(terminal.id),
        autoFocusAtMs: isFocusTarget ? focusAutoFocusAtMs : null,
        socketState,
        onSelect,
        onBoundsChange,
        onTerminalChange,
        onPathSelectRequest,
        onRemove,
        onInput,
        onResize,
        onRestart,
        onMarkRead,
        onMarkdownDrop,
        activeMarkdownLink:
          activeMarkdownLinkByTerminalId.get(terminal.id) ?? null,
        allowResize: nodesResizable,
        resizeZoom: selectedNodeId === terminal.id ? viewportZoom : 1,
      },
      style: {
        width: renderedBounds.width,
        height: renderedBounds.height,
      },
      className: isFocusTarget ? 'is-focus-target' : undefined,
      selected: selectedNodeId === terminal.id,
      selectable: true as const,
      draggable: nodesDraggable,
      dragHandle: '.node-drag-handle',
    };
  });

  const markdown = workspace.markdown.map((node) => {
    const renderedBounds = renderedBoundsByNodeId.get(node.id) ?? node.bounds;

    return {
      id: node.id,
      type: 'markdown' as const,
      position: {
        x: renderedBounds.x,
        y: renderedBounds.y,
      },
      width: renderedBounds.width,
      height: renderedBounds.height,
      data: {
        markdown: node,
        document: markdownDocuments[node.id] ?? null,
        activeLinks: activeMarkdownLinksByNodeId.get(node.id) ?? [],
        onSelect,
        onFocusRequest: onMarkdownFocusRequest,
        onRemove: onMarkdownRemove,
        onBoundsChange,
        onDocumentLoad,
        onDocumentChange,
        onDocumentSave,
        onResolveConflict,
        allowResize: nodesResizable,
        resizeZoom: selectedNodeId === node.id ? viewportZoom : 1,
        semanticZoomMode,
      },
      style: {
        width: renderedBounds.width,
        height: renderedBounds.height,
      },
      selected: selectedNodeId === node.id,
      selectable: true as const,
      draggable: nodesDraggable,
    };
  });

  return [...terminals, ...markdown];
}

export function buildCanvasEdges(
  workspace: Workspace,
  markdownLinks: readonly MarkdownLinkState[],
): Edge[] {
  const terminalIds = new Set(workspace.terminals.map((terminal) => terminal.id));
  const markdownIds = new Set(workspace.markdown.map((markdown) => markdown.id));

  return markdownLinks
    .filter(
      (link) =>
        terminalIds.has(link.terminalId) && markdownIds.has(link.markdownNodeId),
    )
    .map((link) => ({
      id: `link-${link.markdownNodeId}-${link.terminalId}`,
      source: link.markdownNodeId,
      target: link.terminalId,
      type: 'smoothstep',
      animated: link.phase === 'active',
      selectable: false,
      style: {
        stroke:
          link.phase === 'active'
            ? 'rgba(255, 180, 92, 0.9)'
            : 'rgba(136, 182, 221, 0.55)',
        strokeWidth: link.phase === 'active' ? 2 : 1.5,
      },
    }));
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
  const terminalResult = updateById(workspace.terminals, nodeId, (terminal) => {
    const nextBounds = {
      ...terminal.bounds,
      ...partialBounds,
    };

    if (sameNodeBounds(terminal.bounds, nextBounds)) {
      return terminal;
    }

    return {
      ...terminal,
      bounds: nextBounds,
    };
  });

  if (terminalResult.found && terminalResult.changed) {
    return {
      ...workspace,
      terminals: terminalResult.items,
    };
  }

  const markdownResult = updateById(workspace.markdown, nodeId, (markdown) => {
    const nextBounds = {
      ...markdown.bounds,
      ...partialBounds,
    };

    if (sameNodeBounds(markdown.bounds, nextBounds)) {
      return markdown;
    }

    return {
      ...markdown,
      bounds: nextBounds,
    };
  });

  if (markdownResult.found && markdownResult.changed) {
    return {
      ...workspace,
      markdown: markdownResult.items,
    };
  }

  return workspace;
}

function sameNodeBounds(
  left: Workspace['terminals'][number]['bounds'],
  right: Workspace['terminals'][number]['bounds'],
): boolean {
  return (
    left.x === right.x &&
    left.y === right.y &&
    left.width === right.width &&
    left.height === right.height
  );
}
