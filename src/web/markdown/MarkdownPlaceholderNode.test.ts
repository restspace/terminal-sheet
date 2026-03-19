/** @vitest-environment jsdom */

import { createElement, type ComponentProps } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../canvas/CanvasResizeHandles', () => ({
  CanvasResizeHandles: () => null,
}));

import type { MarkdownDocumentState } from '../../shared/markdown';
import { createPlaceholderMarkdown } from '../../shared/workspace';
import { MarkdownPlaceholderNode } from './MarkdownPlaceholderNode';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('MarkdownPlaceholderNode', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    document.body.innerHTML = '';
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    vi.clearAllMocks();
  });

  it('marks inspect-mode markdown preview bodies as nowheel regions', () => {
    const markdown = createPlaceholderMarkdown(0);

    act(() => {
      root.render(
        createElement(
          MarkdownPlaceholderNode,
          createNodeProps({
            markdown,
            document: createDocumentState(markdown.id, markdown.filePath),
            semanticZoomMode: 'inspect',
          }),
        ),
      );
    });

    const previewBody = container.querySelector(
      '.markdown-preview-card .markdown-panel-body',
    );

    expect(previewBody).not.toBeNull();
    expect(previewBody?.className).toContain('nowheel');
    expect(previewBody?.className).toContain('nopan');
    expect(previewBody?.className).toContain('nodrag');
  });

  it('marks focus-mode markdown editor and preview bodies as nowheel regions', () => {
    const markdown = createPlaceholderMarkdown(0);

    act(() => {
      root.render(
        createElement(
          MarkdownPlaceholderNode,
          createNodeProps({
            markdown,
            document: createDocumentState(markdown.id, markdown.filePath),
            semanticZoomMode: 'focus',
          }),
        ),
      );
    });

    const focusBodies = [
      ...container.querySelectorAll<HTMLDivElement>(
        '.markdown-focus-card .markdown-panel-body',
      ),
    ];

    expect(focusBodies).toHaveLength(2);
    for (const panelBody of focusBodies) {
      expect(panelBody.className).toContain('nowheel');
      expect(panelBody.className).toContain('nopan');
      expect(panelBody.className).toContain('nodrag');
    }
  });

  it('renders a close icon button with Close title text', () => {
    const markdown = createPlaceholderMarkdown(0);
    const onRemove = vi.fn();
    const props = createNodeProps({
      markdown,
      document: createDocumentState(markdown.id, markdown.filePath),
      semanticZoomMode: 'inspect',
    });
    props.data.onRemove = onRemove;

    act(() => {
      root.render(createElement(MarkdownPlaceholderNode, props));
    });

    const closeButton = container.querySelector(
      '.terminal-header-close-button',
    ) as HTMLButtonElement | null;

    expect(closeButton).not.toBeNull();
    expect(closeButton?.getAttribute('title')).toBe('Close');
    expect(closeButton?.textContent?.trim()).toBe('X');

    act(() => {
      closeButton?.click();
    });

    expect(onRemove).toHaveBeenCalledWith(markdown.id);
  });
});

function createNodeProps(options: {
  markdown: ReturnType<typeof createPlaceholderMarkdown>;
  document: MarkdownDocumentState;
  semanticZoomMode?: 'overview' | 'inspect' | 'focus';
}): ComponentProps<typeof MarkdownPlaceholderNode> {
  return {
    id: options.markdown.id,
    data: {
      markdown: options.markdown,
      document: options.document,
      activeLinks: [],
      onSelect: vi.fn(),
      onFocusRequest: vi.fn(),
      onRemove: vi.fn(),
      onBoundsChange: vi.fn(),
      onDocumentLoad: vi.fn(),
      onDocumentChange: vi.fn(),
      onDocumentSave: vi.fn(),
      onResolveConflict: vi.fn(),
      allowResize: true,
      resizeZoom: 1,
      semanticZoomMode: options.semanticZoomMode ?? 'inspect',
    },
    width: options.markdown.bounds.width,
    height: options.markdown.bounds.height,
    selected: false,
    dragging: false,
    zIndex: 1,
    isConnectable: false,
    type: 'markdown',
  } as unknown as ComponentProps<typeof MarkdownPlaceholderNode>;
}

function createDocumentState(
  nodeId: string,
  filePath: string,
): MarkdownDocumentState {
  return {
    nodeId,
    filePath,
    content: '# Title\n\nParagraph',
    savedContent: '# Title\n\nParagraph',
    status: 'ready',
    readOnly: false,
    externalVersion: 'v1',
    dirty: false,
    error: null,
    conflict: null,
  };
}
