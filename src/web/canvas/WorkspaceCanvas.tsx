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
  type CameraViewport,
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
  terminalInteractionAtMs: Readonly<Record<string, number>>;
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

export function WorkspaceCanvas({
  workspace,
  selectedNodeId,
  terminalInteractionAtMs,
  sessions,
  markdownDocuments,
  markdownLinks,
  socketState,
  onTerminalInput,
  onTerminalResize,
  onTerminalRestart,
  onTerminalChange,
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
  const terminalPresentationState = useMemo(
    () =>
      deriveTerminalPresentationState({
        terminals: workspace.terminals,
        selectedNodeId,
        sessions,
        interactionAtByTerminalId: terminalInteractionAtMs,
      }),
    [selectedNodeId, sessions, terminalInteractionAtMs, workspace.terminals],
  );
  const livePreviewTerminalIds = useMemo(
    () => new Set(terminalPresentationState.inspectTerminalIds),
    [terminalPresentationState.inspectTerminalIds],
  );
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
        selectedNodeId,
        livePreviewTerminalIds,
        focusTerminalId: selectedTerminal?.id ?? null,
        terminalPresentationById: terminalPresentationState.presentationById,
        sessions,
        markdownDocuments,
        markdownLinks,
        socketState,
        onSelect: onSelectedNodeChange,
        onBoundsChange: (nodeId, bounds) => {
          onWorkspaceChange((current) => updateNodeBounds(current, nodeId, bounds));
        },
        onTerminalChange,
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
      livePreviewTerminalIds,
      onMarkTerminalRead,
      onMarkdownDrop,
      onMarkdownFocusRequest,
      onMarkdownRemove,
      onDocumentChange,
      onDocumentLoad,
      onDocumentSave,
      onSelectedNodeChange,
      onTerminalChange,
      onTerminalInput,
      onTerminalRemove,
      onTerminalResize,
      onTerminalRestart,
      onWorkspaceChange,
      selectedNodeId,
      selectedTerminal?.id,
      sessions,
      markdownDocuments,
      markdownLinks,
      socketState,
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
                return 'rgba(138, 180, 216, 0.78)';
              }

              if (isAttentionRequiredStatus(status)) {
                return status === 'approval-needed' || status === 'needs-input'
                  ? 'rgba(255, 194, 102, 0.9)'
                  : 'rgba(255, 123, 114, 0.9)';
              }

              if (status === 'completed') {
                return 'rgba(94, 196, 139, 0.82)';
              }

              return 'rgba(138, 180, 216, 0.78)';
            }}
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
