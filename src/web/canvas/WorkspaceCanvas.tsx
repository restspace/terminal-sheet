import { useMemo } from 'react';

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
} from '@xyflow/react';

import {
  getReadOnlyPreviewTerminalIds,
  getSemanticZoomMode,
  type CameraViewport,
  type TerminalNode,
  type Workspace,
} from '../../shared/workspace';
import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import { MarkdownPlaceholderNode } from '../markdown/MarkdownPlaceholderNode';
import { FocusedTerminalOverlay } from '../terminals/FocusedTerminalOverlay';
import { TerminalPlaceholderNode } from '../terminals/TerminalPlaceholderNode';
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
  sessions: Record<string, TerminalSessionSnapshot>;
  socketState: 'connecting' | 'open' | 'closed' | 'error';
  onTerminalInput: (sessionId: string, data: string) => void;
  onTerminalResize: (sessionId: string, cols: number, rows: number) => void;
  onTerminalRestart: (sessionId: string) => void;
  onTerminalChange: (
    nodeId: string,
    patch: Partial<Pick<TerminalNode, 'label' | 'cwd'>>,
  ) => void;
  onMarkTerminalRead: (sessionId: string) => void;
  onSelectedNodeChange: (nodeId: string | null) => void;
  onTerminalFocusRequest: (terminalId: string) => void;
  onWorkspaceChange: (updater: (workspace: Workspace) => Workspace) => void;
  onViewportChange: (viewport: CameraViewport) => void;
  focusAutoFocusAtMs: number | null;
}

const nodeTypes = {
  terminal: TerminalPlaceholderNode,
  markdown: MarkdownPlaceholderNode,
};

export function WorkspaceCanvas({
  workspace,
  selectedNodeId,
  sessions,
  socketState,
  onTerminalInput,
  onTerminalResize,
  onTerminalRestart,
  onTerminalChange,
  onMarkTerminalRead,
  onSelectedNodeChange,
  onTerminalFocusRequest,
  onWorkspaceChange,
  onViewportChange,
  focusAutoFocusAtMs,
}: WorkspaceCanvasProps) {
  const semanticMode = getSemanticZoomMode(workspace.currentViewport.zoom);
  const livePreviewTerminalIds = useMemo(
    () =>
      new Set(
        getReadOnlyPreviewTerminalIds(
          workspace.terminals,
          selectedNodeId,
          semanticMode,
        ),
      ),
    [semanticMode, selectedNodeId, workspace.terminals],
  );
  const selectedTerminal = useMemo(
    () =>
      semanticMode === 'focus' && selectedNodeId
        ? (workspace.terminals.find(
            (terminal) => terminal.id === selectedNodeId,
          ) ?? null)
        : null,
    [semanticMode, selectedNodeId, workspace.terminals],
  );
  const selectedSession = selectedTerminal
    ? (sessions[selectedTerminal.id] ?? null)
    : null;
  const nodes = useMemo(
    () =>
      buildCanvasNodes({
        workspace,
        selectedNodeId,
        livePreviewTerminalIds,
        focusTerminalId: selectedTerminal?.id ?? null,
        sessions,
        socketState,
        onSelect: onSelectedNodeChange,
        onBoundsChange: (nodeId, bounds) => {
          onWorkspaceChange((current) => updateNodeBounds(current, nodeId, bounds));
        },
        onTerminalChange,
        onInput: onTerminalInput,
        onResize: onTerminalResize,
        onRestart: onTerminalRestart,
        onMarkRead: onMarkTerminalRead,
      }),
    [
      livePreviewTerminalIds,
      onMarkTerminalRead,
      onSelectedNodeChange,
      onTerminalChange,
      onTerminalInput,
      onTerminalResize,
      onTerminalRestart,
      onWorkspaceChange,
      selectedNodeId,
      selectedTerminal?.id,
      sessions,
      socketState,
      workspace,
    ],
  );
  const edges = useMemo(() => buildCanvasEdges(workspace), [workspace]);

  return (
    <div className="canvas-frame">
      <ReactFlowProvider>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          viewport={workspace.currentViewport}
          onViewportChange={onViewportChange}
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
            if (node.type === 'terminal') {
              onTerminalFocusRequest(node.id);
            }
          }}
          proOptions={{ hideAttribution: true }}
          minZoom={0.3}
          maxZoom={1.8}
          fitView={false}
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
            nodeColor={(node) =>
              node.type === 'markdown'
                ? 'rgba(255, 207, 132, 0.75)'
                : 'rgba(138, 180, 216, 0.78)'
            }
          />
          <Controls position="top-right" showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>

      {selectedTerminal ? (
        <FocusedTerminalOverlay
          terminal={selectedTerminal}
          session={selectedSession}
          viewport={workspace.currentViewport}
          autoFocusAtMs={focusAutoFocusAtMs}
          onInput={onTerminalInput}
          onResize={onTerminalResize}
          onBoundsChange={(nodeId, bounds) => {
            onWorkspaceChange((current) =>
              updateNodeBounds(current, nodeId, bounds),
            );
          }}
          onTerminalChange={onTerminalChange}
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
