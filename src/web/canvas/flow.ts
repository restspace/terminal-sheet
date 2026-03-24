import type { Edge, NodeChange } from '@xyflow/react';

import { updateById } from '../../shared/collections';
import type {
  MarkdownDocumentState,
  MarkdownLinkState,
} from '../../shared/markdown';
import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import type { SemanticZoomMode, Workspace } from '../../shared/workspace';
import type { BackendAccent } from './backendAccents';
import type { TerminalSurfaceModel } from '../terminals/terminalSurfaceModel';
import type { MarkdownFlowNode, TerminalFlowNode } from '../terminals/types';

type CanvasNode = TerminalFlowNode | MarkdownFlowNode;

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
  terminals: Workspace['terminals'];
  markdown: Workspace['markdown'];
  backendAccents: ReadonlyMap<string, BackendAccent>;
  selectedNodeId: string | null;
  renderedBoundsByNodeId: ReadonlyMap<
    string,
    Workspace['terminals'][number]['bounds']
  >;
  nodesDraggable: boolean;
  nodesResizable: boolean;
  focusAutoFocusAtMs: number | null;
  viewportZoom: number;
  semanticZoomMode: SemanticZoomMode;
  terminalSurfaceModelById: ReadonlyMap<string, TerminalSurfaceModel>;
  sessions: Record<string, TerminalSessionSnapshot>;
  markdownDocuments: Record<string, MarkdownDocumentState>;
  activeMarkdownLinkByTerminalId: ReadonlyMap<string, MarkdownLinkState>;
  activeMarkdownLinksByNodeId: ReadonlyMap<string, readonly MarkdownLinkState[]>;
  socketState: 'connecting' | 'open' | 'closed' | 'error';
  freezeTerminalGeometry: boolean;
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
  onResize: (
    sessionId: string,
    cols: number,
    rows: number,
    generation: number,
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
  terminals,
  markdown,
  backendAccents,
  selectedNodeId,
  renderedBoundsByNodeId,
  nodesDraggable,
  nodesResizable,
  focusAutoFocusAtMs,
  viewportZoom,
  semanticZoomMode,
  terminalSurfaceModelById,
  sessions,
  markdownDocuments,
  activeMarkdownLinkByTerminalId,
  activeMarkdownLinksByNodeId,
  socketState,
  freezeTerminalGeometry,
  onBoundsChange,
  onTerminalChange,
  onPathSelectRequest,
  onRemove,
  onInput,
  onResize,
  onResizeSyncError,
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
  const terminalNodes = terminals.map((terminal) => {
    const surfaceModel = terminalSurfaceModelById.get(terminal.id) ?? {
      presentationMode: 'overview',
      surfaceKind: 'summary',
      acceptsInput: false,
    };
    const isFocusTarget = surfaceModel.presentationMode === 'focus';
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
        surfaceModel,
        autoFocusAtMs:
          surfaceModel.surfaceKind === 'live' && surfaceModel.acceptsInput
            ? focusAutoFocusAtMs
            : null,
        socketState,
        onBoundsChange,
        onTerminalChange,
        onPathSelectRequest,
        onRemove,
        onInput,
        onResize,
        onResizeSyncError,
        onRestart,
        onMarkRead,
        onMarkdownDrop,
        activeMarkdownLink:
          activeMarkdownLinkByTerminalId.get(terminal.id) ?? null,
        freezeTerminalGeometry,
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

  const markdownNodes = markdown.map((node) => {
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

  return [...terminalNodes, ...markdownNodes];
}

export function buildCanvasEdges(
  terminals: Workspace['terminals'],
  markdown: Workspace['markdown'],
  markdownLinks: readonly MarkdownLinkState[],
): Edge[] {
  const terminalIds = new Set(terminals.map((terminal) => terminal.id));
  const markdownIds = new Set(markdown.map((node) => node.id));

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
