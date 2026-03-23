import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type NodeChange,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';

import {
  getSemanticZoomMode,
  type CameraViewport,
  type WorkspaceLayoutMode,
  type TerminalNode,
  type Workspace,
} from '../../shared/workspace';
import type {
  MarkdownDocumentState,
  MarkdownLinkState,
} from '../../shared/markdown';
import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import { isAttentionRequiredStatus } from '../../shared/events';
import { MarkdownPlaceholderNode } from '../markdown/MarkdownPlaceholderNode';
import { deriveTerminalSurfaceModelState } from '../terminals/terminalSurfaceModel';
import { TerminalPlaceholderNode } from '../terminals/TerminalPlaceholderNode';
import { getTerminalDisplayStatus } from '../terminals/presentation';
import { buildBackendAccentsMap } from './backendAccents';
import { getLayoutStrategy } from './layout/strategyRegistry';
import type { NodeBounds } from './layout/types';
import { logStateDebug } from '../debug/stateDebug';
import { useCanvasViewportController } from './useCanvasViewportController';
import {
  buildCanvasEdges,
  buildCanvasNodes,
  getSelectedNodeIdFromChanges,
} from './flow';

interface WorkspaceCanvasProps {
  workspace: Workspace;
  selectedNodeId: string | null;
  nodeInteractionAtMs: Readonly<Record<string, number>>;
  sessions: Record<string, TerminalSessionSnapshot>;
  markdownDocuments: Record<string, MarkdownDocumentState>;
  markdownLinks: MarkdownLinkState[];
  socketState: 'connecting' | 'open' | 'closed' | 'error';
  onTerminalInput: (sessionId: string, data: string) => void;
  onTerminalResize: (sessionId: string, cols: number, rows: number) => void;
  onTerminalRestart: (sessionId: string) => void;
  onTerminalChange: (
    nodeId: string,
    patch: Partial<Pick<TerminalNode, 'label' | 'cwd'>>,
  ) => void;
  onPathSelectRequest: (terminalId: string) => void;
  onTerminalRemove: (terminalId: string) => void;
  onMarkTerminalRead: (sessionId: string) => void;
  onMarkdownDrop: (markdownNodeId: string, terminalId: string) => void;
  onMarkdownFocusRequest: (nodeId: string) => void;
  onMarkdownRemove: (nodeId: string) => void;
  onSelectedNodeChange: (nodeId: string | null) => void;
  onTerminalFocusRequest: (terminalId: string) => void;
  onNodeBoundsChange: (
    nodeId: string,
    bounds: Workspace['terminals'][number]['bounds'],
  ) => void;
  onViewportChange: (viewport: CameraViewport) => void;
  onViewportSizeChange: (size: { width: number; height: number }) => void;
  focusAutoFocusAtMs: number | null;
  onDocumentLoad: (nodeId: string) => void;
  onDocumentChange: (nodeId: string, content: string) => void;
  onDocumentSave: (nodeId: string) => void;
  onResolveConflict: (
    nodeId: string,
    choice: 'reload-disk' | 'overwrite-disk' | 'keep-buffer',
  ) => void;
}

const nodeTypes = {
  terminal: TerminalPlaceholderNode,
  markdown: MarkdownPlaceholderNode,
};
const ENABLE_REACT_FLOW_MINIMAP = false;
const LAYOUT_INTERACTION_DEBOUNCE_MS = 96;

export function WorkspaceCanvas({
  workspace,
  selectedNodeId,
  nodeInteractionAtMs,
  sessions,
  markdownDocuments,
  markdownLinks,
  socketState,
  onTerminalInput,
  onTerminalResize,
  onTerminalRestart,
  onTerminalChange,
  onPathSelectRequest,
  onTerminalRemove,
  onMarkTerminalRead,
  onMarkdownDrop,
  onMarkdownFocusRequest,
  onMarkdownRemove,
  onSelectedNodeChange,
  onTerminalFocusRequest,
  onNodeBoundsChange,
  onViewportChange,
  onViewportSizeChange,
  focusAutoFocusAtMs,
  onDocumentLoad,
  onDocumentChange,
  onDocumentSave,
  onResolveConflict,
}: WorkspaceCanvasProps) {
  const canvasFrameRef = useRef<HTMLDivElement | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const layoutStateByModeRef = useRef<
    Partial<Record<WorkspaceLayoutMode, unknown>>
  >({});
  const previousLayoutModeRef = useRef<WorkspaceLayoutMode | null>(null);
  const [layoutAnimationClassName, setLayoutAnimationClassName] = useState('');
  const layoutAnimationTimerRef = useRef<number | null>(null);
  const debouncedLayoutInteractionTimerRef = useRef<number | null>(null);
  const lastLayoutAnimationKeyRef = useRef<string | null>(null);
  const [debouncedNodeInteractionAtMs, setDebouncedNodeInteractionAtMs] =
    useState(nodeInteractionAtMs);
  const [renderedBoundsByNodeId, setRenderedBoundsByNodeId] = useState<
    Map<string, NodeBounds>
  >(() => createInitialRenderedBoundsByNodeId(workspace));
  const workspaceRef = useRef(workspace);
  const renderedBoundsByNodeIdRef = useRef<ReadonlyMap<string, NodeBounds>>(
    renderedBoundsByNodeId,
  );
  const onNodeBoundsChangeRef = useRef(onNodeBoundsChange);
  const onTerminalChangeRef = useRef(onTerminalChange);
  const onPathSelectRequestRef = useRef(onPathSelectRequest);
  const onTerminalRemoveRef = useRef(onTerminalRemove);
  const onTerminalInputRef = useRef(onTerminalInput);
  const onTerminalResizeRef = useRef(onTerminalResize);
  const onTerminalRestartRef = useRef(onTerminalRestart);
  const onMarkTerminalReadRef = useRef(onMarkTerminalRead);
  const onMarkdownDropRef = useRef(onMarkdownDrop);
  workspaceRef.current = workspace;
  renderedBoundsByNodeIdRef.current = renderedBoundsByNodeId;
  onNodeBoundsChangeRef.current = onNodeBoundsChange;
  onTerminalChangeRef.current = onTerminalChange;
  onPathSelectRequestRef.current = onPathSelectRequest;
  onTerminalRemoveRef.current = onTerminalRemove;
  onTerminalInputRef.current = onTerminalInput;
  onTerminalResizeRef.current = onTerminalResize;
  onTerminalRestartRef.current = onTerminalRestart;
  onMarkTerminalReadRef.current = onMarkTerminalRead;
  onMarkdownDropRef.current = onMarkdownDrop;
  const [interactionPolicy, setInteractionPolicy] = useState({
    nodesDraggable: true,
    nodesResizable: true,
  });
  const handleNodeBoundsChange = useCallback(
    (nodeId: string, bounds: Partial<NodeBounds>) => {
      const currentWorkspace = workspaceRef.current;
      const nextBounds = resolveNextRenderedBounds(
        renderedBoundsByNodeIdRef.current,
        currentWorkspace,
        nodeId,
        bounds,
      );

      if (!nextBounds) {
        return;
      }

      setRenderedBoundsByNodeId((current) =>
        applyRenderedBoundsUpdate(current, currentWorkspace, nodeId, bounds),
      );
      onNodeBoundsChangeRef.current(nodeId, nextBounds);
    },
    [],
  );
  const handleTerminalChange = useCallback<
    WorkspaceCanvasProps['onTerminalChange']
  >((nodeId, patch) => {
    onTerminalChangeRef.current(nodeId, patch);
  }, []);
  const handlePathSelectRequest = useCallback<
    WorkspaceCanvasProps['onPathSelectRequest']
  >((terminalId) => {
    onPathSelectRequestRef.current(terminalId);
  }, []);
  const handleTerminalRemove = useCallback<
    WorkspaceCanvasProps['onTerminalRemove']
  >((terminalId) => {
    onTerminalRemoveRef.current(terminalId);
  }, []);
  const handleTerminalInput = useCallback<
    WorkspaceCanvasProps['onTerminalInput']
  >((sessionId, data) => {
    onTerminalInputRef.current(sessionId, data);
  }, []);
  const handleTerminalResize = useCallback<
    WorkspaceCanvasProps['onTerminalResize']
  >((sessionId, cols, rows) => {
    onTerminalResizeRef.current(sessionId, cols, rows);
  }, []);
  const handleTerminalRestart = useCallback<
    WorkspaceCanvasProps['onTerminalRestart']
  >((sessionId) => {
    onTerminalRestartRef.current(sessionId);
  }, []);
  const handleMarkTerminalRead = useCallback<
    WorkspaceCanvasProps['onMarkTerminalRead']
  >((sessionId) => {
    onMarkTerminalReadRef.current(sessionId);
  }, []);
  const handleMarkdownDrop = useCallback<WorkspaceCanvasProps['onMarkdownDrop']>(
    (markdownNodeId, terminalId) => {
      onMarkdownDropRef.current(markdownNodeId, terminalId);
    },
    [],
  );
  const {
    activeViewport,
    isViewportInteracting,
    onMoveStart,
    onMoveEnd,
    onReactFlowViewportChange,
  } = useCanvasViewportController({
    workspaceViewport: workspace.currentViewport,
    onViewportCommit: onViewportChange,
  });
  const focusedTerminalId = useMemo(
    () =>
      selectedNodeId && workspace.terminals.some((terminal) => terminal.id === selectedNodeId)
        ? selectedNodeId
        : null,
    [selectedNodeId, workspace.terminals],
  );
  const layoutViewport =
    workspace.layoutMode === 'focus-tiles'
      ? activeViewport
      : workspace.currentViewport;

  useEffect(() => {
    const container = canvasFrameRef.current;

    if (!container) {
      return;
    }

    if (typeof ResizeObserver === 'undefined') {
      setViewportSize({
        width: Math.round(container.clientWidth),
        height: Math.round(container.clientHeight),
      });
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];

      if (!entry) {
        return;
      }

      setViewportSize({
        width: Math.round(entry.contentRect.width),
        height: Math.round(entry.contentRect.height),
      });
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, []);

  useEffect(() => {
    if (viewportSize.width <= 0 || viewportSize.height <= 0) {
      return;
    }

    onViewportSizeChange(viewportSize);
  }, [onViewportSizeChange, viewportSize]);

  useEffect(() => {
    if (areInteractionTimestampsEqual(debouncedNodeInteractionAtMs, nodeInteractionAtMs)) {
      return;
    }

    if (debouncedLayoutInteractionTimerRef.current !== null) {
      window.clearTimeout(debouncedLayoutInteractionTimerRef.current);
    }

    debouncedLayoutInteractionTimerRef.current = window.setTimeout(() => {
      debouncedLayoutInteractionTimerRef.current = null;
      setDebouncedNodeInteractionAtMs(nodeInteractionAtMs);
    }, LAYOUT_INTERACTION_DEBOUNCE_MS);
  }, [debouncedNodeInteractionAtMs, nodeInteractionAtMs]);

  useEffect(() => {
    const layoutStrategy = getLayoutStrategy(workspace.layoutMode);
    const layoutResult = layoutStrategy.compute({
      mode: workspace.layoutMode,
      nodes: [
        ...workspace.terminals.map((terminal, index) => ({
          id: terminal.id,
          bounds: terminal.bounds,
          order: index,
        })),
        ...workspace.markdown.map((node, index) => ({
          id: node.id,
          bounds: node.bounds,
          order: workspace.terminals.length + index,
        })),
      ],
      selectedNodeId,
      interactionAtByNodeId: debouncedNodeInteractionAtMs,
      viewport: layoutViewport,
      viewportSize,
      safeAreaInsets: getLayoutSafeAreaInsets(viewportSize),
      previousState: layoutStateByModeRef.current[workspace.layoutMode] ?? null,
      previousMode: previousLayoutModeRef.current,
    });

    layoutStateByModeRef.current[workspace.layoutMode] = layoutResult.nextState;
    previousLayoutModeRef.current = workspace.layoutMode;

    if (workspace.layoutMode === 'focus-tiles') {
      const focusTilesState = readFocusTilesDebugState(layoutResult.nextState);
      logStateDebug('focusTiles', 'layoutComputed', {
        selectedNodeId,
        focusedTerminalId,
        viewportSize,
        layoutViewport,
        animationKey: layoutResult.animation?.key ?? null,
        animationDurationMs: layoutResult.animation?.durationMs ?? null,
        state: focusTilesState,
      });
    }

    const nextBoundsByNodeId = new Map(layoutResult.boundsByNodeId);

    setRenderedBoundsByNodeId((current) =>
      sameBoundsByNodeId(current, nextBoundsByNodeId) ? current : nextBoundsByNodeId,
    );
    setInteractionPolicy((current) =>
      current.nodesDraggable === layoutResult.interactionPolicy.nodesDraggable &&
      current.nodesResizable === layoutResult.interactionPolicy.nodesResizable
        ? current
        : layoutResult.interactionPolicy,
    );

    if (!layoutResult.animation) {
      return;
    }

    if (layoutResult.animation.key === lastLayoutAnimationKeyRef.current) {
      return;
    }

    lastLayoutAnimationKeyRef.current = layoutResult.animation.key;
    setLayoutAnimationClassName(
      layoutResult.animation.durationMs >= 1_000
        ? 'is-layout-animating-enter'
        : 'is-layout-animating-swap',
    );

    if (layoutAnimationTimerRef.current !== null) {
      window.clearTimeout(layoutAnimationTimerRef.current);
    }

    layoutAnimationTimerRef.current = window.setTimeout(() => {
      layoutAnimationTimerRef.current = null;
      setLayoutAnimationClassName('');
    }, layoutResult.animation.durationMs);
  }, [
    debouncedNodeInteractionAtMs,
    focusedTerminalId,
    selectedNodeId,
    viewportSize,
    layoutViewport,
    workspace.layoutMode,
    workspace.markdown,
    workspace.terminals,
  ]);

  useEffect(() => {
    return () => {
      if (layoutAnimationTimerRef.current !== null) {
        window.clearTimeout(layoutAnimationTimerRef.current);
      }
      if (debouncedLayoutInteractionTimerRef.current !== null) {
        window.clearTimeout(debouncedLayoutInteractionTimerRef.current);
      }
    };
  }, []);

  const backendAccents = useMemo(
    () => buildBackendAccentsMap(workspace.backends),
    [workspace.backends],
  );
  const terminalSurfaceModelState = useMemo(
    () =>
      deriveTerminalSurfaceModelState({
        terminals: workspace.terminals,
        selectedNodeId,
        sessions,
        interactionAtByTerminalId: nodeInteractionAtMs,
        layoutMode: workspace.layoutMode,
      }),
    [
      nodeInteractionAtMs,
      selectedNodeId,
      sessions,
      workspace.layoutMode,
      workspace.terminals,
    ],
  );
  const semanticZoomMode = useMemo(
    () => getSemanticZoomMode(activeViewport.zoom),
    [activeViewport.zoom],
  );
  const activeMarkdownLinkByTerminalId = useMemo(() => {
    const linksByTerminalId = new Map<string, MarkdownLinkState>();

    for (const link of markdownLinks) {
      if (!linksByTerminalId.has(link.terminalId)) {
        linksByTerminalId.set(link.terminalId, link);
      }
    }

    return linksByTerminalId;
  }, [markdownLinks]);
  const activeMarkdownLinksByNodeId = useMemo(() => {
    const linksByNodeId = new Map<string, MarkdownLinkState[]>();

    for (const link of markdownLinks) {
      const existing = linksByNodeId.get(link.markdownNodeId);

      if (existing) {
        existing.push(link);
      } else {
        linksByNodeId.set(link.markdownNodeId, [link]);
      }
    }

    return linksByNodeId;
  }, [markdownLinks]);
  const terminalStatusById = useMemo(
    () =>
      new Map(
        workspace.terminals.map((terminal) => [
          terminal.id,
          getTerminalDisplayStatus(terminal, sessions[terminal.id] ?? null),
        ]),
      ),
    [sessions, workspace.terminals],
  );
  const nodes = useMemo(
    () =>
      buildCanvasNodes({
        workspace,
        backendAccents,
        selectedNodeId,
        renderedBoundsByNodeId,
        nodesDraggable: interactionPolicy.nodesDraggable,
        nodesResizable: interactionPolicy.nodesResizable,
        focusAutoFocusAtMs,
        viewportZoom: activeViewport.zoom,
        semanticZoomMode,
        terminalSurfaceModelById: terminalSurfaceModelState.modelById,
        sessions,
        markdownDocuments,
        activeMarkdownLinkByTerminalId,
        activeMarkdownLinksByNodeId,
        socketState,
        onSelect: onSelectedNodeChange,
        onBoundsChange: handleNodeBoundsChange,
        onTerminalChange: handleTerminalChange,
        onPathSelectRequest: handlePathSelectRequest,
        onRemove: handleTerminalRemove,
        onInput: handleTerminalInput,
        onResize: handleTerminalResize,
        onRestart: handleTerminalRestart,
        onMarkRead: handleMarkTerminalRead,
        onMarkdownDrop: handleMarkdownDrop,
        onMarkdownFocusRequest,
        onMarkdownRemove,
        onDocumentLoad,
        onDocumentChange,
        onDocumentSave,
        onResolveConflict,
      }),
    [
      backendAccents,
      activeViewport.zoom,
      focusAutoFocusAtMs,
      handleMarkTerminalRead,
      handleMarkdownDrop,
      handleNodeBoundsChange,
      handlePathSelectRequest,
      handleTerminalChange,
      handleTerminalInput,
      handleTerminalRemove,
      handleTerminalResize,
      handleTerminalRestart,
      onMarkdownFocusRequest,
      onMarkdownRemove,
      onDocumentChange,
      onDocumentLoad,
      onDocumentSave,
      onSelectedNodeChange,
      selectedNodeId,
      renderedBoundsByNodeId,
      interactionPolicy.nodesDraggable,
      interactionPolicy.nodesResizable,
      sessions,
      markdownDocuments,
      activeMarkdownLinkByTerminalId,
      activeMarkdownLinksByNodeId,
      socketState,
      semanticZoomMode,
      terminalSurfaceModelState.modelById,
      workspace,
      onResolveConflict,
    ],
  );
  const edges = useMemo(
    () => buildCanvasEdges(workspace, markdownLinks),
    [markdownLinks, workspace],
  );

  return (
    <div
      ref={canvasFrameRef}
      className={
        [
          'canvas-frame',
          layoutAnimationClassName,
          isViewportInteracting ? 'is-viewport-interacting' : '',
        ]
          .filter(Boolean)
          .join(' ')
      }
    >
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          viewport={activeViewport}
          onViewportChange={onReactFlowViewportChange}
          onMoveStart={onMoveStart}
          onMoveEnd={onMoveEnd}
          onNodesChange={(changes) => {
            logStateDebug('canvas', 'reactFlowNodesChange', {
              isViewportInteracting,
              changes: summarizeNodeChangesForDebug(changes),
            });
            const nextSelectedNodeId = getSelectedNodeIdFromChanges(changes);

            if (nextSelectedNodeId !== undefined) {
              onSelectedNodeChange(nextSelectedNodeId);
            }

            const boundsChanges = getNodeBoundsChanges(changes);

            if (!boundsChanges.length) {
              return;
            }

            setRenderedBoundsByNodeId((current) =>
              applyRenderedBoundsUpdates(current, workspace, boundsChanges),
            );

            for (const boundsChange of boundsChanges) {
              const nextBounds = resolveNextRenderedBounds(
                renderedBoundsByNodeId,
                workspace,
                boundsChange.nodeId,
                boundsChange.bounds,
              );

              if (!nextBounds) {
                continue;
              }

              onNodeBoundsChange(boundsChange.nodeId, nextBounds);
            }
          }}
          onPaneClick={(event) => {
            const target = event.target;

            if (
              target instanceof Element &&
              target.closest('.react-flow__node, .react-flow__panel')
            ) {
              return;
            }

            onSelectedNodeChange(null);
          }}
          onNodeClick={(_event, node) => {
            onSelectedNodeChange(node.id);
          }}
          onNodeDoubleClick={(_event, node) => {
            if (workspace.layoutMode === 'focus-tiles') {
              onSelectedNodeChange(node.id);
              return;
            }

            if (node.type === 'terminal') {
              onTerminalFocusRequest(node.id);
              return;
            }

            if (node.type === 'markdown') {
              onMarkdownFocusRequest(node.id);
            }
          }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.3}
          maxZoom={1.8}
          fitView={false}
          nodesDraggable={interactionPolicy.nodesDraggable}
          snapToGrid
          snapGrid={[20, 20]}
          selectionOnDrag={false}
          panOnScroll
          panOnScrollSpeed={0.7}
          panOnDrag={false}
          panActivationKeyCode="Space"
          deleteKeyCode={null}
          onlyRenderVisibleElements
        >
          <Background
            variant={BackgroundVariant.Dots}
            gap={24}
            size={1}
            color="rgba(91, 110, 130, 0.35)"
          />
          {ENABLE_REACT_FLOW_MINIMAP ? (
            <MiniMap
              position="bottom-right"
              pannable
              zoomable
              style={{
                width: 160,
                height: 120,
              }}
              nodeColor={(node) => {
                if (node.type === 'markdown') {
                  return 'rgba(255, 207, 132, 0.75)';
                }

                const status = terminalStatusById.get(node.id);

                if (!status) {
                  const accent = backendAccents.get(
                    (node.data as { terminal?: { backendId?: string } })
                      ?.terminal?.backendId ?? '',
                  );
                  return accent?.color ?? 'rgba(138, 180, 216, 0.78)';
                }

                if (isAttentionRequiredStatus(status)) {
                  return status === 'approval-needed' || status === 'needs-input'
                    ? 'rgba(255, 194, 102, 0.9)'
                    : 'rgba(255, 123, 114, 0.9)';
                }

                if (status === 'completed') {
                  return 'rgba(94, 196, 139, 0.82)';
                }

                const accent = backendAccents.get(
                  (node.data as { terminal?: { backendId?: string } })
                    ?.terminal?.backendId ?? '',
                );
                return accent?.color ?? 'rgba(138, 180, 216, 0.78)';
              }}
            />
          ) : null}
          <Controls position="top-right" showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>

      {!workspace.terminals.length && !workspace.markdown.length ? (
        <div className="canvas-empty-state">
          <p className="eyebrow">Blank Canvas</p>
          <h2>Start placing supervision nodes.</h2>
          <p>
            Launch a terminal or add a Markdown node, drag it into position,
            then reload the app to confirm the workspace and live session IDs
            reconnect cleanly.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function getLayoutSafeAreaInsets(viewportSize: {
  width: number;
  height: number;
}): {
  top: number;
  right: number;
  bottom: number;
  left: number;
} {
  if (viewportSize.width <= 980) {
    return {
      top: 190,
      right: 0,
      bottom: 118,
      left: 0,
    };
  }

  return {
    top: 96,
    right: 0,
    bottom: 84,
    left: 0,
  };
}

function createInitialRenderedBoundsByNodeId(
  workspace: Workspace,
): Map<string, NodeBounds> {
  return new Map(
    [...workspace.terminals, ...workspace.markdown].map((node) => [
      node.id,
      node.bounds,
    ]),
  );
}

function sameBounds(left: NodeBounds, right: NodeBounds): boolean {
  return (
    Math.abs(left.x - right.x) < 0.5 &&
    Math.abs(left.y - right.y) < 0.5 &&
    Math.abs(left.width - right.width) < 0.5 &&
    Math.abs(left.height - right.height) < 0.5
  );
}

function sameBoundsByNodeId(
  left: ReadonlyMap<string, NodeBounds>,
  right: ReadonlyMap<string, NodeBounds>,
): boolean {
  if (left.size !== right.size) {
    return false;
  }

  for (const [nodeId, leftBounds] of left) {
    const rightBounds = right.get(nodeId);

    if (!rightBounds || !sameBounds(leftBounds, rightBounds)) {
      return false;
    }
  }

  return true;
}

function applyRenderedBoundsUpdates(
  current: ReadonlyMap<string, NodeBounds>,
  workspace: Workspace,
  changes: ReadonlyArray<{
    nodeId: string;
    bounds: Partial<NodeBounds>;
  }>,
): Map<string, NodeBounds> {
  let next = current as Map<string, NodeBounds>;

  for (const change of changes) {
    next = applyRenderedBoundsUpdate(next, workspace, change.nodeId, change.bounds);
  }

  return next;
}

function applyRenderedBoundsUpdate(
  current: ReadonlyMap<string, NodeBounds>,
  workspace: Workspace,
  nodeId: string,
  bounds: Partial<NodeBounds>,
): Map<string, NodeBounds> {
  const currentBounds =
    current.get(nodeId) ??
    readWorkspaceNodeBounds(workspace, nodeId);

  if (!currentBounds) {
    return current as Map<string, NodeBounds>;
  }

  const nextBounds = {
    ...currentBounds,
    ...bounds,
  };

  if (sameBounds(currentBounds, nextBounds)) {
    return current as Map<string, NodeBounds>;
  }

  const next = new Map(current);
  next.set(nodeId, nextBounds);
  return next;
}

function resolveNextRenderedBounds(
  current: ReadonlyMap<string, NodeBounds>,
  workspace: Workspace,
  nodeId: string,
  bounds: Partial<NodeBounds>,
): NodeBounds | null {
  const currentBounds =
    current.get(nodeId) ??
    readWorkspaceNodeBounds(workspace, nodeId);

  if (!currentBounds) {
    return null;
  }

  return {
    ...currentBounds,
    ...bounds,
  };
}

function readWorkspaceNodeBounds(
  workspace: Workspace,
  nodeId: string,
): NodeBounds | null {
  const terminal = workspace.terminals.find((candidate) => candidate.id === nodeId);

  if (terminal) {
    return terminal.bounds;
  }

  const markdown = workspace.markdown.find((candidate) => candidate.id === nodeId);
  return markdown?.bounds ?? null;
}

function getNodeBoundsChanges(
  changes: NodeChange[],
): Array<{
  nodeId: string;
  bounds: Partial<NodeBounds>;
}> {
  const next: Array<{
    nodeId: string;
    bounds: Partial<NodeBounds>;
  }> = [];

  for (const change of changes) {
    if (change.type === 'position' && change.position) {
      next.push({
        nodeId: change.id,
        bounds: {
          x: change.position.x,
          y: change.position.y,
        },
      });
      continue;
    }

    if (change.type === 'dimensions' && change.dimensions) {
      next.push({
        nodeId: change.id,
        bounds: {
          width: change.dimensions.width,
          height: change.dimensions.height,
        },
      });
    }
  }

  return next;
}

function readFocusTilesDebugState(value: unknown): {
  centerNodeId: string | null;
  sideNodeIds: string[];
} | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as {
    centerNodeId?: unknown;
    sideNodeIds?: unknown;
  };

  return {
    centerNodeId:
      typeof candidate.centerNodeId === 'string'
        ? candidate.centerNodeId
        : null,
    sideNodeIds: Array.isArray(candidate.sideNodeIds)
      ? candidate.sideNodeIds.filter(
          (nodeId): nodeId is string => typeof nodeId === 'string',
        )
      : [],
  };
}

function summarizeNodeChangesForDebug(
  changes: NodeChange[],
): Array<Record<string, unknown>> {
  return changes.map((change) => {
    switch (change.type) {
      case 'position':
        return {
          id: change.id,
          type: change.type,
          dragging: change.dragging ?? null,
          position: change.position
            ? {
                x: roundForEventDebug(change.position.x),
                y: roundForEventDebug(change.position.y),
              }
            : null,
        };
      case 'dimensions':
        return {
          id: change.id,
          type: change.type,
          dimensions: change.dimensions
            ? {
                width: roundForEventDebug(change.dimensions.width),
                height: roundForEventDebug(change.dimensions.height),
              }
            : null,
          resizing: change.resizing ?? null,
        };
      case 'select':
        return {
          id: change.id,
          type: change.type,
          selected: change.selected,
        };
      default:
        return {
          id: 'id' in change ? change.id : null,
          type: change.type,
        };
    }
  });
}

function roundForEventDebug(value: number): number {
  return Number(value.toFixed(3));
}

function areInteractionTimestampsEqual(
  left: Readonly<Record<string, number>>,
  right: Readonly<Record<string, number>>,
): boolean {
  if (left === right) {
    return true;
  }

  const leftNodeIds = Object.keys(left);
  const rightNodeIds = Object.keys(right);

  if (leftNodeIds.length !== rightNodeIds.length) {
    return false;
  }

  for (const nodeId of leftNodeIds) {
    if (left[nodeId] !== right[nodeId]) {
      return false;
    }
  }

  return true;
}
