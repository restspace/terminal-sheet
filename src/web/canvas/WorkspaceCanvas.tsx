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
  type Workspace,
} from '../../shared/workspace';
import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import { MarkdownPlaceholderNode } from '../markdown/MarkdownPlaceholderNode';
import { TerminalPlaceholderNode } from '../terminals/TerminalPlaceholderNode';
import {
  applyNodeChangesToWorkspace,
  buildCanvasEdges,
  buildCanvasNodes,
} from './flow';

interface WorkspaceCanvasProps {
  workspace: Workspace;
  healthError: string | null;
  selectedNodeId: string | null;
  sessions: Record<string, TerminalSessionSnapshot>;
  socketState: 'connecting' | 'open' | 'closed' | 'error';
  onTerminalInput: (sessionId: string, data: string) => void;
  onTerminalResize: (sessionId: string, cols: number, rows: number) => void;
  onTerminalRestart: (sessionId: string) => void;
  onMarkTerminalRead: (sessionId: string) => void;
  onSelectedNodeChange: (nodeId: string | null) => void;
  onTerminalFocusRequest: (terminalId: string) => void;
  onWorkspaceChange: (updater: (workspace: Workspace) => Workspace) => void;
  onViewportChange: (viewport: CameraViewport) => void;
}

const nodeTypes = {
  terminal: TerminalPlaceholderNode,
  markdown: MarkdownPlaceholderNode,
};

export function WorkspaceCanvas({
  workspace,
  healthError,
  selectedNodeId,
  sessions,
  socketState,
  onTerminalInput,
  onTerminalResize,
  onTerminalRestart,
  onMarkTerminalRead,
  onSelectedNodeChange,
  onTerminalFocusRequest,
  onWorkspaceChange,
  onViewportChange,
}: WorkspaceCanvasProps) {
  const semanticMode = getSemanticZoomMode(workspace.currentViewport.zoom);

  return (
    <div className="canvas-frame">
      <ReactFlowProvider>
        <ReactFlow
          nodes={buildCanvasNodes({
            workspace,
            selectedNodeId,
            sessions,
            socketState,
            onInput: onTerminalInput,
            onResize: onTerminalResize,
            onRestart: onTerminalRestart,
            onMarkRead: onMarkTerminalRead,
          })}
          edges={buildCanvasEdges(workspace)}
          nodeTypes={nodeTypes}
          viewport={workspace.currentViewport}
          onViewportChange={onViewportChange}
          onNodesChange={(changes) => {
            onWorkspaceChange((current) =>
              applyNodeChangesToWorkspace(current, changes),
            );
          }}
          onPaneClick={() => {
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
          selectionOnDrag
          panOnScroll
          panOnScrollSpeed={0.7}
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
            pannable
            zoomable
            style={{
              background: 'rgba(5, 11, 18, 0.86)',
              border: '1px solid rgba(138, 180, 216, 0.18)',
            }}
            nodeColor={(node) =>
              node.type === 'markdown'
                ? 'rgba(255, 207, 132, 0.75)'
                : 'rgba(138, 180, 216, 0.78)'
            }
          />
          <Controls showInteractive={false} />
        </ReactFlow>
      </ReactFlowProvider>

      <div className="canvas-overlay">
        <div className="canvas-overlay-chip">
          <span className="meta-label">Semantic zoom</span>
          <strong>{semanticMode}</strong>
        </div>
        <div className="canvas-overlay-chip">
          <span className="meta-label">Selected</span>
          <strong>{selectedNodeId ?? 'none'}</strong>
        </div>
        <div className="canvas-overlay-chip">
          <span className="meta-label">Terminal socket</span>
          <strong>{healthError ? 'backend degraded' : socketState}</strong>
        </div>
      </div>

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
