import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { type NodeProps } from '@xyflow/react';

import { CanvasResizeHandles } from '../canvas/CanvasResizeHandles';
import type { MarkdownFlowNode } from '../terminals/types';
import { CodeMirrorMarkdownEditor } from './CodeMirrorMarkdownEditor';
import { MarkdownRenderer } from './MarkdownRenderer';

type FocusPanel = 'edit' | 'split' | 'preview';

function MarkdownPlaceholderNodeComponent(props: NodeProps<MarkdownFlowNode>) {
  const { data, selected } = props;
  const mode = data.semanticZoomMode;
  const markdown = data.markdown;
  const document = data.document;
  const { onBoundsChange, onDocumentLoad } = data;
  const [focusPanel, setFocusPanel] = useState<FocusPanel>('split');
  const editorRef = useRef<HTMLTextAreaElement | null>(null);
  const previewScrollRef = useRef<HTMLDivElement | null>(null);
  const pendingTopLineRef = useRef<number | null>(null);

  useEffect(() => {
    onDocumentLoad(markdown.id);
  }, [onDocumentLoad, markdown.id]);

  const rememberVisibleTopLine = useCallback(() => {
    const editor = editorRef.current;
    const preview = previewScrollRef.current;
    const topLine =
      focusPanel === 'edit'
        ? readEditorTopLine(editor)
        : focusPanel === 'preview'
          ? readPreviewTopLine(preview)
          : (readEditorTopLine(editor) ?? readPreviewTopLine(preview));

    if (!topLine) {
      return;
    }

    pendingTopLineRef.current = topLine;
  }, [focusPanel]);

  const showFocusPanel = useCallback(
    (panel: FocusPanel) => {
      if (panel === focusPanel) {
        return;
      }

      rememberVisibleTopLine();
      setFocusPanel(panel);
    },
    [focusPanel, rememberVisibleTopLine],
  );

  useLayoutEffect(() => {
    const topLine = pendingTopLineRef.current;

    if (!topLine) {
      return;
    }

    if (focusPanel !== 'preview') {
      scrollEditorToLine(editorRef.current, topLine);
    }

    if (focusPanel !== 'edit') {
      scrollPreviewToLine(previewScrollRef.current, topLine);
    }

    pendingTopLineRef.current = null;
  }, [document?.content, focusPanel]);

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
        isVisible={selected && data.allowResize}
        minWidth={260}
        minHeight={200}
        zoom={data.resizeZoom}
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
            {document?.dirty ? (
              <span className="canvas-node-status is-markdown">unsaved</span>
            ) : null}
            {document?.status === 'conflict' ? (
              <span className="canvas-node-status is-attention">conflict</span>
            ) : null}
            <span className="canvas-node-status is-markdown">
              {markdown.readOnly
                ? 'read-only'
                : (document?.status ?? 'loading')}
            </span>
            <button
              className="terminal-header-close-button nodrag nopan"
              type="button"
              title="Close"
              aria-label={`Close ${markdown.label}`}
              onPointerDown={stopPointerEventPropagation}
              onClick={(event) => {
                stopEventPropagation(event);
                data.onRemove(markdown.id);
              }}
            >
              <span className="terminal-header-close-icon" aria-hidden="true">
                X
              </span>
            </button>
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
              <span className="terminal-focus-label">
                {focusPanel === 'edit' ? 'Inspect editor' : 'Inspect preview'}
              </span>
              <div className="markdown-panel-actions">
                {document?.dirty ? <strong>Unsaved changes</strong> : null}
                {focusPanel === 'edit' ? (
                  <>
                    <button
                      className="nodrag nopan"
                      type="button"
                      onPointerDown={stopPointerPropagation}
                      onClick={(event) => {
                        stopEventPropagation(event);
                        data.onDocumentSave(markdown.id);
                      }}
                      disabled={
                        !document || !document.dirty || markdown.readOnly
                      }
                    >
                      Save
                    </button>
                    <button
                      className="nodrag nopan"
                      type="button"
                      onPointerDown={stopPointerPropagation}
                      onClick={(event) => {
                        stopEventPropagation(event);
                        showFocusPanel('preview');
                      }}
                    >
                      Preview
                    </button>
                  </>
                ) : (
                  <button
                    className="nodrag nopan"
                    type="button"
                    onPointerDown={stopPointerPropagation}
                    onClick={(event) => {
                      stopEventPropagation(event);
                      showFocusPanel('edit');
                      data.onFocusRequest(markdown.id);
                    }}
                  >
                    Open editor
                  </button>
                )}
              </div>
            </div>
            <div
              className={
                focusPanel === 'edit'
                  ? 'markdown-panel-body is-editor nodrag nopan nowheel'
                  : 'markdown-panel-body nodrag nopan nowheel'
              }
              ref={focusPanel === 'edit' ? undefined : previewScrollRef}
              onWheel={stopEventPropagation}
            >
              {focusPanel === 'edit' ? (
                document ? (
                  <CodeMirrorMarkdownEditor
                    ref={editorRef}
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
                )
              ) : (
                <MarkdownRenderer content={document?.content ?? ''} />
              )}
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
                      showFocusPanel(panel);
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
                <div
                  className="markdown-panel-body is-editor nodrag nopan nowheel"
                  onWheel={stopEventPropagation}
                >
                  {document ? (
                    <CodeMirrorMarkdownEditor
                      ref={editorRef}
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
                <div
                  className="markdown-panel-body nodrag nopan nowheel"
                  ref={previewScrollRef}
                  onWheel={stopEventPropagation}
                >
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

export const MarkdownPlaceholderNode = memo(
  MarkdownPlaceholderNodeComponent,
  areMarkdownNodePropsEqual,
);
MarkdownPlaceholderNode.displayName = 'MarkdownPlaceholderNode';

function getSnippet(content: string): string {
  const normalized = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return normalized?.slice(0, 120) ?? '';
}

function describeLink(link: {
  terminalId: string;
  phase: 'queued' | 'active';
}): string {
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

function stopPointerPropagation(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}

function readEditorTopLine(editor: HTMLTextAreaElement | null): number | null {
  if (!editor) {
    return null;
  }

  return Math.max(
    1,
    Math.floor(editor.scrollTop / getEditorLineHeight(editor)) + 1,
  );
}

function scrollEditorToLine(
  editor: HTMLTextAreaElement | null,
  line: number,
): void {
  if (!editor) {
    return;
  }

  editor.scrollTop = Math.max(0, (line - 1) * getEditorLineHeight(editor));
}

function readPreviewTopLine(container: HTMLDivElement | null): number | null {
  if (!container) {
    return null;
  }

  const anchors = getPreviewLineAnchors(container);

  if (!anchors.length) {
    return null;
  }

  const scrollTop = container.scrollTop;
  let visibleAnchor = anchors[0] ?? null;

  for (const anchor of anchors) {
    if (getPreviewAnchorScrollTop(container, anchor.element) > scrollTop + 1) {
      break;
    }

    visibleAnchor = anchor;
  }

  return visibleAnchor?.line ?? null;
}

function scrollPreviewToLine(
  container: HTMLDivElement | null,
  line: number,
): void {
  if (!container) {
    return;
  }

  const anchors = getPreviewLineAnchors(container);
  const target = anchors.reduce<(typeof anchors)[number] | null>(
    (closest, anchor) => {
      if (anchor.line > line) {
        return closest;
      }

      return anchor;
    },
    anchors[0] ?? null,
  );

  if (!target) {
    return;
  }

  container.scrollTop = Math.max(
    0,
    getPreviewAnchorScrollTop(container, target.element),
  );
}

function getPreviewLineAnchors(
  container: HTMLDivElement,
): Array<{ element: HTMLElement; line: number }> {
  return [
    ...container.querySelectorAll<HTMLElement>('[data-markdown-source-line]'),
  ]
    .map((element) => ({
      element,
      line: Number(element.dataset.markdownSourceLine),
    }))
    .filter((anchor) => Number.isFinite(anchor.line) && anchor.line >= 1)
    .sort((left, right) => {
      if (left.line !== right.line) {
        return left.line - right.line;
      }

      return (
        getPreviewAnchorScrollTop(container, left.element) -
        getPreviewAnchorScrollTop(container, right.element)
      );
    });
}

function getPreviewAnchorScrollTop(
  container: HTMLDivElement,
  element: HTMLElement,
): number {
  const containerRect = container.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();

  if (containerRect.top !== 0 || elementRect.top !== 0) {
    return elementRect.top - containerRect.top + container.scrollTop;
  }

  return element.offsetTop;
}

function getEditorLineHeight(editor: HTMLTextAreaElement): number {
  const computedStyle = window.getComputedStyle(editor);
  const lineHeight = Number.parseFloat(computedStyle.lineHeight);

  if (Number.isFinite(lineHeight) && lineHeight > 0) {
    return lineHeight;
  }

  const fontSize = Number.parseFloat(computedStyle.fontSize);

  if (Number.isFinite(fontSize) && fontSize > 0) {
    return fontSize * 1.55;
  }

  return 20;
}

function areMarkdownNodePropsEqual(
  previous: NodeProps<MarkdownFlowNode>,
  next: NodeProps<MarkdownFlowNode>,
): boolean {
  const previousData = previous.data;
  const nextData = next.data;

  return (
    previous.selected === next.selected &&
    previous.dragging === next.dragging &&
    previous.width === next.width &&
    previous.height === next.height &&
    previousData.markdown === nextData.markdown &&
    previousData.document === nextData.document &&
    previousData.activeLinks === nextData.activeLinks &&
    previousData.allowResize === nextData.allowResize &&
    previousData.resizeZoom === nextData.resizeZoom &&
    previousData.semanticZoomMode === nextData.semanticZoomMode &&
    previousData.onFocusRequest === nextData.onFocusRequest &&
    previousData.onRemove === nextData.onRemove &&
    previousData.onBoundsChange === nextData.onBoundsChange &&
    previousData.onDocumentLoad === nextData.onDocumentLoad &&
    previousData.onDocumentChange === nextData.onDocumentChange &&
    previousData.onDocumentSave === nextData.onDocumentSave &&
    previousData.onResolveConflict === nextData.onResolveConflict
  );
}
