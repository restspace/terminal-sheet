import { type NodeProps, useViewport } from '@xyflow/react';

import { getSemanticZoomMode } from '../../shared/workspace';
import { CanvasResizeHandles } from '../canvas/CanvasResizeHandles';
import type { MarkdownFlowNode } from '../terminals/types';

export function MarkdownPlaceholderNode(
  props: NodeProps<MarkdownFlowNode>,
) {
  const { data, selected } = props;
  const { zoom } = useViewport();
  const mode = getSemanticZoomMode(zoom);
  const markdown = data.markdown;
  const { onSelect, onBoundsChange } = data;

  return (
    <div
      className={
        selected
          ? 'canvas-node markdown-node is-selected'
          : 'canvas-node markdown-node'
      }
      onPointerDown={(event) => {
        if (event.button !== 0) {
          return;
        }

        event.stopPropagation();
        onSelect(markdown.id);
      }}
    >
      <CanvasResizeHandles
        bounds={markdown.bounds}
        isVisible={selected}
        minWidth={240}
        minHeight={180}
        zoom={zoom}
        onBoundsChange={(bounds) => {
          onBoundsChange(markdown.id, bounds);
        }}
      />

      <div className="canvas-node-content">
        <div className="node-drag-handle canvas-node-header">
          <div>
            <p className="canvas-node-kicker">Markdown node</p>
            <strong>{markdown.label}</strong>
          </div>
          <span className="canvas-node-status is-markdown">
            {markdown.readOnly ? 'read-only' : 'editable'}
          </span>
        </div>

        <div className="canvas-node-meta">
          <span>{markdown.filePath}</span>
          <span>{markdown.linkedTerminalIds.length} links</span>
        </div>

        {mode === 'overview' ? (
          <div className="canvas-node-summary">
            <p>Overview card</p>
            <strong>Document pinned to the canvas.</strong>
            <span>Low-zoom summaries stay readable instead of shrinking text.</span>
          </div>
        ) : null}

        {mode === 'inspect' ? (
          <div className="canvas-node-summary">
            <p>Inspect preview</p>
            <strong>Medium zoom preview shell</strong>
            <span>
              Markdown preview and linking behavior will layer on top of this
              persistent node in Milestone 5.
            </span>
          </div>
        ) : null}

        {mode === 'focus' ? (
          <div className="canvas-node-summary">
            <p>Focus editor</p>
            <strong>Editor surface reserved.</strong>
            <span>
              This node is already moveable, resizeable, and persisted as part
              of the workspace file.
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
