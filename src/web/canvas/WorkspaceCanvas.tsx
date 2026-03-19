import { useEffect, useMemo, useRef, useState } from 'react';

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
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
import { FocusedTerminalOverlay } from '../terminals/FocusedTerminalOverlay';
import { deriveTerminalPresentationState } from '../terminals/presentationMode';
import { TerminalPlaceholderNode } from '../terminals/TerminalPlaceholderNode';
import { getTerminalDisplayStatus } from '../terminals/presentation';
import { buildBackendAccentsMap } from './backendAccents';
import { getLayoutStrategy } from './layout/strategyRegistry';
import type { NodeBounds } from './layout/types';
import {
  applyNodeChangesToWorkspace,
  buildCanvasEdges,
  buildCanvasNodes,
  getSelectedNodeIdFromChanges,
  updateNodeBounds,
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
  onWorkspaceChange: (updater: (workspace: Workspace) => Workspace) => void;
  onViewportChange: (viewport: CameraViewport) => void;
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

interface OverlaySwapState {
  key: string;
  fromTerminalId: string;
  toTerminalId: string;
  durationMs: number;
}

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
  onWorkspaceChange,
  onViewportChange,
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
  const previousRenderedLayoutModeRef = useRef<WorkspaceLayoutMode>(
    workspace.layoutMode,
  );
  const [layoutAnimationClassName, setLayoutAnimationClassName] = useState('');
  const layoutAnimationTimerRef = useRef<number | null>(null);
  const lastLayoutAnimationKeyRef = useRef<string | null>(null);
  const overlaySwapTimerRef = useRef<number | null>(null);
  const pendingViewportCommitRef = useRef<CameraViewport | null>(null);
  const [lastCommittedViewport, setLastCommittedViewport] = useState<CameraViewport>(
    workspace.currentViewport,
  );
  const [isAwaitingViewportCommit, setIsAwaitingViewportCommit] = useState(false);
  const lastOverlaySwapKeyRef = useRef<string | null>(null);
  const lastFocusTilesBoundsRef = useRef<Map<string, NodeBounds>>(new Map());
  const [canvasViewport, setCanvasViewport] = useState<CameraViewport>(
    workspace.currentViewport,
  );
  const [isViewportInteracting, setIsViewportInteracting] = useState(false);
  const [renderedBoundsByNodeId, setRenderedBoundsByNodeId] = useState<
    Map<string, NodeBounds>
  >(() => createInitialRenderedBoundsByNodeId(workspace));
  const [interactionPolicy, setInteractionPolicy] = useState({
    nodesDraggable: true,
    nodesResizable: true,
  });
  const [overlaySwapState, setOverlaySwapState] = useState<OverlaySwapState | null>(
    null,
  );
  const hasPendingViewportCommit =
    isAwaitingViewportCommit &&
    !sameViewport(workspace.currentViewport, lastCommittedViewport);
  const shouldUseCanvasViewport =
    isViewportInteracting || hasPendingViewportCommit;
  const activeViewport = shouldUseCanvasViewport
    ? canvasViewport
    : workspace.currentViewport;
  const focusedTerminalId = useMemo(
    () =>
      selectedNodeId && workspace.terminals.some((terminal) => terminal.id === selectedNodeId)
        ? selectedNodeId
        : null,
    [selectedNodeId, workspace.terminals],
  );
  const previousFocusedTerminalIdRef = useRef<string | null>(focusedTerminalId);
  const layoutViewport =
    workspace.layoutMode === 'focus-tiles'
      ? activeViewport
      : workspace.currentViewport;

  useEffect(() => {
    if (
      !isAwaitingViewportCommit ||
      !sameViewport(workspace.currentViewport, lastCommittedViewport)
    ) {
      return;
    }

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsAwaitingViewportCommit(false);
  }, [isAwaitingViewportCommit, lastCommittedViewport, workspace.currentViewport]);

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
      interactionAtByNodeId: nodeInteractionAtMs,
      viewport: layoutViewport,
      viewportSize,
      safeAreaInsets: getLayoutSafeAreaInsets(viewportSize),
      previousState: layoutStateByModeRef.current[workspace.layoutMode] ?? null,
      previousMode: previousLayoutModeRef.current,
    });

    layoutStateByModeRef.current[workspace.layoutMode] = layoutResult.nextState;
    previousLayoutModeRef.current = workspace.layoutMode;

    if (workspace.layoutMode === 'focus-tiles') {
      lastFocusTilesBoundsRef.current = new Map(layoutResult.boundsByNodeId);
    }

    let nextBoundsByNodeId = new Map(layoutResult.boundsByNodeId);

    if (
      workspace.layoutMode === 'free' &&
      previousRenderedLayoutModeRef.current === 'focus-tiles' &&
      lastFocusTilesBoundsRef.current.size > 0
    ) {
      nextBoundsByNodeId = new Map(lastFocusTilesBoundsRef.current);
      onWorkspaceChange((current) =>
        applyRenderedBoundsToWorkspace(current, nextBoundsByNodeId),
      );
    }

    previousRenderedLayoutModeRef.current = workspace.layoutMode;

    setRenderedBoundsByNodeId((current) =>
      sameBoundsByNodeId(current, nextBoundsByNodeId) ? current : nextBoundsByNodeId,
    );
    setInteractionPolicy((current) =>
      current.nodesDraggable === layoutResult.interactionPolicy.nodesDraggable &&
      current.nodesResizable === layoutResult.interactionPolicy.nodesResizable
        ? current
        : layoutResult.interactionPolicy,
    );

    if (
      shouldStartOverlaySwapTransition({
        layoutMode: workspace.layoutMode,
        animationKey: layoutResult.animation?.key ?? null,
        previousFocusedTerminalId: previousFocusedTerminalIdRef.current,
        nextFocusedTerminalId: focusedTerminalId,
      }) &&
      layoutResult.animation &&
      layoutResult.animation.key !== lastOverlaySwapKeyRef.current
    ) {
      const nextOverlaySwapState: OverlaySwapState = {
        key: layoutResult.animation.key,
        fromTerminalId: previousFocusedTerminalIdRef.current as string,
        toTerminalId: focusedTerminalId as string,
        durationMs: layoutResult.animation.durationMs,
      };

      lastOverlaySwapKeyRef.current = nextOverlaySwapState.key;
      setOverlaySwapState(nextOverlaySwapState);

      if (overlaySwapTimerRef.current !== null) {
        window.clearTimeout(overlaySwapTimerRef.current);
      }

      overlaySwapTimerRef.current = window.setTimeout(() => {
        overlaySwapTimerRef.current = null;
        setOverlaySwapState((current) =>
          current?.key === nextOverlaySwapState.key ? null : current,
        );
      }, nextOverlaySwapState.durationMs);
    } else if (workspace.layoutMode !== 'focus-tiles') {
      setOverlaySwapState(null);
      lastOverlaySwapKeyRef.current = null;
    }

    previousFocusedTerminalIdRef.current = focusedTerminalId;

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
    focusedTerminalId,
    nodeInteractionAtMs,
    onWorkspaceChange,
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

      if (overlaySwapTimerRef.current !== null) {
        window.clearTimeout(overlaySwapTimerRef.current);
      }
    };
  }, []);

  const backendAccents = useMemo(
    () => buildBackendAccentsMap(workspace.backends),
    [workspace.backends],
  );
  const terminalPresentationState = useMemo(
    () =>
      deriveTerminalPresentationState({
        terminals: workspace.terminals,
        selectedNodeId,
        sessions,
        interactionAtByTerminalId: nodeInteractionAtMs,
      }),
    [selectedNodeId, sessions, nodeInteractionAtMs, workspace.terminals],
  );
  const semanticZoomMode = useMemo(
    () => getSemanticZoomMode(activeViewport.zoom),
    [activeViewport.zoom],
  );
  const livePreviewTerminalIds = useMemo(
    () => new Set(terminalPresentationState.inspectTerminalIds),
    [terminalPresentationState.inspectTerminalIds],
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
  const selectedTerminal = useMemo(
    () =>
      terminalPresentationState.focusedTerminalId
        ? (workspace.terminals.find(
            (terminal) =>
              terminal.id === terminalPresentationState.focusedTerminalId,
          ) ?? null)
        : null,
    [terminalPresentationState.focusedTerminalId, workspace.terminals],
  );
  const selectedSession = selectedTerminal
    ? (sessions[selectedTerminal.id] ?? null)
    : null;
  const terminalById = useMemo(
    () => new Map(workspace.terminals.map((terminal) => [terminal.id, terminal])),
    [workspace.terminals],
  );
  const outgoingSwapTerminal = overlaySwapState
    ? (terminalById.get(overlaySwapState.fromTerminalId) ?? null)
    : null;
  const incomingSwapTerminal = overlaySwapState
    ? (terminalById.get(overlaySwapState.toTerminalId) ?? null)
    : null;
  const outgoingSwapSession = outgoingSwapTerminal
    ? (sessions[outgoingSwapTerminal.id] ?? null)
    : null;
  const incomingSwapSession = incomingSwapTerminal
    ? (sessions[incomingSwapTerminal.id] ?? null)
    : null;
  const selectedTerminalAccent = selectedTerminal
    ? (backendAccents.get(selectedTerminal.backendId ?? '') ?? null)
    : null;
  const outgoingSwapTerminalAccent = outgoingSwapTerminal
    ? (backendAccents.get(outgoingSwapTerminal.backendId ?? '') ?? null)
    : null;
  const incomingSwapTerminalAccent = incomingSwapTerminal
    ? (backendAccents.get(incomingSwapTerminal.backendId ?? '') ?? null)
    : null;
  const shouldRenderDualSwapOverlay =
    workspace.layoutMode === 'focus-tiles' &&
    overlaySwapState !== null &&
    incomingSwapTerminal !== null &&
    overlaySwapState.toTerminalId === focusedTerminalId;
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
        livePreviewTerminalIds,
        focusTerminalId: selectedTerminal?.id ?? null,
        viewportZoom: activeViewport.zoom,
        semanticZoomMode,
        terminalPresentationById: terminalPresentationState.presentationById,
        sessions,
        markdownDocuments,
        activeMarkdownLinkByTerminalId,
        activeMarkdownLinksByNodeId,
        socketState,
        onSelect: onSelectedNodeChange,
        onBoundsChange: (nodeId, bounds) => {
          onWorkspaceChange((current) => updateNodeBounds(current, nodeId, bounds));
        },
        onTerminalChange,
        onPathSelectRequest,
        onRemove: onTerminalRemove,
        onInput: onTerminalInput,
        onResize: onTerminalResize,
        onRestart: onTerminalRestart,
        onMarkRead: onMarkTerminalRead,
        onMarkdownDrop,
        onMarkdownFocusRequest,
        onMarkdownRemove,
        onDocumentLoad,
        onDocumentChange,
        onDocumentSave,
        onResolveConflict,
      }),
    [
      backendAccents,
      livePreviewTerminalIds,
      activeViewport.zoom,
      onMarkTerminalRead,
      onMarkdownDrop,
      onMarkdownFocusRequest,
      onMarkdownRemove,
      onDocumentChange,
      onDocumentLoad,
      onDocumentSave,
      onSelectedNodeChange,
      onTerminalChange,
      onPathSelectRequest,
      onTerminalInput,
      onTerminalRemove,
      onTerminalResize,
      onTerminalRestart,
      onWorkspaceChange,
      selectedNodeId,
      selectedTerminal?.id,
      renderedBoundsByNodeId,
      interactionPolicy.nodesDraggable,
      interactionPolicy.nodesResizable,
      sessions,
      markdownDocuments,
      activeMarkdownLinkByTerminalId,
      activeMarkdownLinksByNodeId,
      socketState,
      semanticZoomMode,
      terminalPresentationState.presentationById,
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
          onViewportChange={(nextViewport) => {
            setCanvasViewport((current) =>
              sameViewport(current, nextViewport) ? current : nextViewport,
            );
            pendingViewportCommitRef.current = nextViewport;
          }}
          onMoveStart={() => {
            setLastCommittedViewport(workspace.currentViewport);
            setIsAwaitingViewportCommit(false);
            setIsViewportInteracting(true);
          }}
          onMoveEnd={(_event, maybeViewport) => {
            setIsViewportInteracting(false);

            const finalViewport = isCameraViewport(maybeViewport)
              ? maybeViewport
              : (pendingViewportCommitRef.current ?? canvasViewport);
            pendingViewportCommitRef.current = null;

            if (!finalViewport) {
              return;
            }

            setCanvasViewport((current) =>
              sameViewport(current, finalViewport) ? current : finalViewport,
            );
            if (!sameViewport(lastCommittedViewport, finalViewport)) {
              setIsAwaitingViewportCommit(true);
              setLastCommittedViewport(finalViewport);
              onViewportChange(finalViewport);
            }
          }}
          onNodesChange={(changes) => {
            const nextSelectedNodeId = getSelectedNodeIdFromChanges(changes);

            if (nextSelectedNodeId !== undefined) {
              onSelectedNodeChange(nextSelectedNodeId);
            }

            onWorkspaceChange((current) =>
              applyNodeChangesToWorkspace(current, changes),
            );
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
          <Controls position="top-right" showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>

      {shouldRenderDualSwapOverlay ? (
        <>
          {outgoingSwapTerminal ? (
            <FocusedTerminalOverlay
              key={`swap-out-${overlaySwapState.key}`}
              terminal={applyRenderedBoundsToTerminal(
                outgoingSwapTerminal,
                renderedBoundsByNodeId,
              )}
              backendAccent={outgoingSwapTerminalAccent}
              session={outgoingSwapSession}
              viewport={activeViewport}
              autoFocusAtMs={null}
              visualVariant="swap-out"
              interactive={false}
              onInput={onTerminalInput}
              onResize={onTerminalResize}
              onBoundsChange={(nodeId, bounds) => {
                onWorkspaceChange((current) =>
                  updateNodeBounds(current, nodeId, bounds),
                );
              }}
              onTerminalChange={onTerminalChange}
              onPathSelectRequest={onPathSelectRequest}
              onRemove={onTerminalRemove}
              onRestart={onTerminalRestart}
            />
          ) : null}
          <FocusedTerminalOverlay
            key={`swap-in-${overlaySwapState.key}`}
            terminal={applyRenderedBoundsToTerminal(
              incomingSwapTerminal,
              renderedBoundsByNodeId,
            )}
            backendAccent={incomingSwapTerminalAccent}
            session={incomingSwapSession}
            viewport={activeViewport}
            autoFocusAtMs={focusAutoFocusAtMs}
            visualVariant="swap-in"
            interactive
            onInput={onTerminalInput}
            onResize={onTerminalResize}
            onBoundsChange={(nodeId, bounds) => {
              onWorkspaceChange((current) =>
                updateNodeBounds(current, nodeId, bounds),
              );
            }}
            onTerminalChange={onTerminalChange}
            onPathSelectRequest={onPathSelectRequest}
            onRemove={onTerminalRemove}
            onRestart={onTerminalRestart}
          />
        </>
      ) : selectedTerminal ? (
        <FocusedTerminalOverlay
          terminal={applyRenderedBoundsToTerminal(
            selectedTerminal,
            renderedBoundsByNodeId,
          )}
          backendAccent={selectedTerminalAccent}
          session={selectedSession}
          viewport={activeViewport}
          autoFocusAtMs={focusAutoFocusAtMs}
          onInput={onTerminalInput}
          onResize={onTerminalResize}
          onBoundsChange={(nodeId, bounds) => {
            onWorkspaceChange((current) =>
              updateNodeBounds(current, nodeId, bounds),
            );
          }}
          onTerminalChange={onTerminalChange}
          onPathSelectRequest={onPathSelectRequest}
          onRemove={onTerminalRemove}
          onRestart={onTerminalRestart}
        />
      ) : null}

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

function applyRenderedBoundsToTerminal(
  terminal: TerminalNode,
  renderedBoundsByNodeId: ReadonlyMap<string, NodeBounds>,
): TerminalNode {
  const renderedBounds = renderedBoundsByNodeId.get(terminal.id);

  if (!renderedBounds || sameBounds(renderedBounds, terminal.bounds)) {
    return terminal;
  }

  return {
    ...terminal,
    bounds: renderedBounds,
  };
}

function applyRenderedBoundsToWorkspace(
  workspace: Workspace,
  renderedBoundsByNodeId: ReadonlyMap<string, NodeBounds>,
): Workspace {
  let changed = false;
  const terminals = workspace.terminals.map((terminal) => {
    const renderedBounds = renderedBoundsByNodeId.get(terminal.id);

    if (!renderedBounds || sameBounds(renderedBounds, terminal.bounds)) {
      return terminal;
    }

    changed = true;
    return {
      ...terminal,
      bounds: renderedBounds,
    };
  });
  const markdown = workspace.markdown.map((node) => {
    const renderedBounds = renderedBoundsByNodeId.get(node.id);

    if (!renderedBounds || sameBounds(renderedBounds, node.bounds)) {
      return node;
    }

    changed = true;
    return {
      ...node,
      bounds: renderedBounds,
    };
  });

  if (!changed) {
    return workspace;
  }

  return {
    ...workspace,
    terminals,
    markdown,
  };
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

function shouldStartOverlaySwapTransition(options: {
  layoutMode: WorkspaceLayoutMode;
  animationKey: string | null;
  previousFocusedTerminalId: string | null;
  nextFocusedTerminalId: string | null;
}): boolean {
  const {
    layoutMode,
    animationKey,
    previousFocusedTerminalId,
    nextFocusedTerminalId,
  } = options;

  if (layoutMode !== 'focus-tiles') {
    return false;
  }

  if (!animationKey?.startsWith('swap:')) {
    return false;
  }

  return (
    Boolean(previousFocusedTerminalId) &&
    Boolean(nextFocusedTerminalId) &&
    previousFocusedTerminalId !== nextFocusedTerminalId
  );
}

function isCameraViewport(value: unknown): value is CameraViewport {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<CameraViewport>;
  return (
    typeof candidate.x === 'number' &&
    typeof candidate.y === 'number' &&
    typeof candidate.zoom === 'number'
  );
}

function sameViewport(left: CameraViewport, right: CameraViewport): boolean {
  return (
    almostEqual(left.x, right.x) &&
    almostEqual(left.y, right.y) &&
    almostEqual(left.zoom, right.zoom)
  );
}

function almostEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}
