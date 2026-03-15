import { useEffect, useMemo, useState } from 'react';

import { type NodeProps, useViewport } from '@xyflow/react';

import { getSemanticZoomMode } from '../../shared/workspace';
import { CanvasResizeHandles } from '../canvas/CanvasResizeHandles';
import type { MarkdownFlowNode } from '../terminals/types';
import { CodeMirrorMarkdownEditor } from './CodeMirrorMarkdownEditor';
import { MarkdownRenderer } from './MarkdownRenderer';

type FocusPanel = 'edit' | 'split' | 'preview';

export function MarkdownPlaceholderNode(props: NodeProps<MarkdownFlowNode>) {
  const { data, selected } = props;
  const { zoom } = useViewport();
  const mode = getSemanticZoomMode(zoom);
  const markdown = data.markdown;
  const document = data.document;
  const { onBoundsChange } = data;
  const [focusPanel, setFocusPanel] = useState<FocusPanel>('split');

  useEffect(() => {
    data.onDocumentLoad(markdown.id);
  }, [data, markdown.id]);

  const snippet = useMemo(
    () => getSnippet(document?.content ?? ''),
    [document?.content],
  );
  const firstLink = data.activeLinks[0] ?? null;
  const linkSummary =
    data.activeLinks.length === 0
      ? 'No terminal links'
      : data.activeLinks.length === 1 && firstLink
        ? `${describeLink(firstLink)}`
        : `${data.activeLinks.length} terminal links`;

  return (
    <div
      className={
        selected
          ? 'canvas-node markdown-node is-selected'
          : 'canvas-node markdown-node'
      }
    >
      <CanvasResizeHandles
        bounds={markdown.bounds}
        isVisible={selected}
        minWidth={260}
        minHeight={200}
        zoom={zoom}
        onBoundsChange={(bounds) => {
          onBoundsChange(markdown.id, bounds);
        }}
      />

      <div className="canvas-node-content">
        <div
          className="node-drag-handle canvas-node-header markdown-window-header"
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData(
              'application/x-terminal-canvas-markdown',
              markdown.id,
            );
            event.dataTransfer.effectAllowed = 'link';
          }}
        >
          <div>
            <strong>{markdown.label}</strong>
            <div className="markdown-node-path" title={markdown.filePath}>
              {markdown.filePath}
            </div>
          </div>
          <div className="markdown-header-badges">
            <button
              className="terminal-header-close-button nodrag nopan"
              type="button"
              aria-label={`Close ${markdown.label}`}
              onPointerDown={stopPointerEventPropagation}
              onClick={(event) => {
                stopEventPropagation(event);
                data.onRemove(markdown.id);
              }}
            >
              Close
            </button>
            {document?.dirty ? (
              <span className="canvas-node-status is-markdown">unsaved</span>
            ) : null}
            {document?.status === 'conflict' ? (
              <span className="canvas-node-status is-attention">conflict</span>
            ) : null}
            <span className="canvas-node-status is-markdown">
              {markdown.readOnly ? 'read-only' : document?.status ?? 'loading'}
            </span>
          </div>
        </div>

        <div className="canvas-node-meta">
          <span>{linkSummary}</span>
          <span>{document?.externalVersion ? 'disk-backed' : 'loading'}</span>
        </div>

        {mode === 'overview' ? (
          <div className="canvas-node-summary markdown-overview-card">
            <p>Overview card</p>
            <strong>{snippet || 'Empty Markdown file'}</strong>
            <span>
              {document?.conflict?.message ??
                'Place plans, notes, and specs beside active terminals.'}
            </span>
          </div>
        ) : null}

        {mode === 'inspect' ? (
          <div className="canvas-node-summary markdown-preview-card">
            <div className="markdown-panel-toolbar">
              <span className="terminal-focus-label">Inspect preview</span>
              <div className="markdown-panel-actions">
                {document?.dirty ? <strong>Unsaved changes</strong> : null}
                <button
                  className="nodrag nopan"
                  type="button"
                  onClick={() => {
                    data.onFocusRequest(markdown.id);
                  }}
                >
                  Open editor
                </button>
              </div>
            </div>
            <div className="markdown-panel-body">
              <MarkdownRenderer content={document?.content ?? ''} />
            </div>
          </div>
        ) : null}

        {mode === 'focus' ? (
          <div className="canvas-node-summary markdown-focus-card">
            <div className="markdown-panel-toolbar">
              <div className="markdown-panel-tabs">
                {(['edit', 'split', 'preview'] as FocusPanel[]).map((panel) => (
                  <button
                    key={panel}
                    className={
                      focusPanel === panel
                        ? 'markdown-tab is-active nodrag nopan'
                        : 'markdown-tab nodrag nopan'
                    }
                    type="button"
                    onClick={() => {
                      setFocusPanel(panel);
                    }}
                  >
                    {panel}
                  </button>
                ))}
              </div>
              <div className="markdown-panel-actions">
                <button
                  className="nodrag nopan"
                  type="button"
                  onClick={() => {
                    data.onDocumentSave(markdown.id);
                  }}
                  disabled={!document || !document.dirty || markdown.readOnly}
                >
                  Save
                </button>
              </div>
            </div>

            {document?.status === 'conflict' && document.conflict ? (
              <div className="markdown-conflict-banner">
                <strong>{document.conflict.message}</strong>
                <div className="markdown-conflict-actions">
                  <button
                    className="nodrag nopan"
                    type="button"
                    onClick={() => {
                      data.onResolveConflict(markdown.id, 'reload-disk');
                    }}
                  >
                    Reload disk
                  </button>
                  <button
                    className="nodrag nopan"
                    type="button"
                    onClick={() => {
                      data.onResolveConflict(markdown.id, 'overwrite-disk');
                    }}
                    disabled={markdown.readOnly}
                  >
                    Overwrite disk
                  </button>
                  <button
                    className="nodrag nopan"
                    type="button"
                    onClick={() => {
                      data.onResolveConflict(markdown.id, 'keep-buffer');
                    }}
                  >
                    Keep buffer
                  </button>
                </div>
              </div>
            ) : null}

            <div
              className={
                focusPanel === 'split'
                  ? 'markdown-focus-layout is-split'
                  : 'markdown-focus-layout'
              }
            >
              {focusPanel !== 'preview' ? (
                <div className="markdown-panel-body is-editor">
                  {document ? (
                    <CodeMirrorMarkdownEditor
                      value={document.content}
                      readOnly={markdown.readOnly}
                      onChange={(content) => {
                        data.onDocumentChange(markdown.id, content);
                      }}
                    />
                  ) : (
                    <div className="markdown-loading-state">
                      <strong>Loading document...</strong>
                      <span>
                        Waiting for the server to load{' '}
                        <code>{markdown.filePath}</code>.
                      </span>
                    </div>
                  )}
                </div>
              ) : null}

              {focusPanel !== 'edit' ? (
                <div className="markdown-panel-body">
                  <MarkdownRenderer content={document?.content ?? ''} />
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function getSnippet(content: string): string {
  const normalized = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return normalized?.slice(0, 120) ?? '';
}

function describeLink(link: { terminalId: string; phase: 'queued' | 'active' }): string {
  return link.phase === 'active'
    ? `Active in ${link.terminalId}`
    : `Queued for ${link.terminalId}`;
}

function stopEventPropagation(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}

function stopPointerEventPropagation(event: {
  stopPropagation: () => void;
  preventDefault: () => void;
}): void {
  event.preventDefault();
  event.stopPropagation();
}
