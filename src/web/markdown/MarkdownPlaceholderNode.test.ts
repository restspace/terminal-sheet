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

  it('opens the inspect-mode editor when the Open editor button is clicked', () => {
    const markdown = createPlaceholderMarkdown(0);
    const onFocusRequest = vi.fn();
    const props = createNodeProps({
      markdown,
      document: createDocumentState(markdown.id, markdown.filePath),
      semanticZoomMode: 'inspect',
    });
    props.data.onFocusRequest = onFocusRequest;

    act(() => {
      root.render(createElement(MarkdownPlaceholderNode, props));
    });

    const openEditorButton = getButtonByText(container, 'Open editor');

    act(() => {
      openEditorButton.click();
    });

    const editor = container.querySelector('textarea');

    expect(onFocusRequest).toHaveBeenCalledWith(markdown.id);
    expect(editor).not.toBeNull();
    expect(editor?.value).toContain('# Title');
    expect(editor?.readOnly).toBe(false);
    expect(container.querySelector('.markdown-rendered-content')).toBeNull();
  });

  it('keeps the visible top source line when switching inspect editor and preview modes', () => {
    const offsetTopSpy = vi
      .spyOn(HTMLElement.prototype, 'offsetTop', 'get')
      .mockImplementation(function getOffsetTop(this: HTMLElement) {
        const line = Number(this.dataset.markdownSourceLine);

        return Number.isFinite(line) ? (line - 1) * 20 : 0;
      });
    const markdown = createPlaceholderMarkdown(0);
    const props = createNodeProps({
      markdown,
      document: {
        ...createDocumentState(markdown.id, markdown.filePath),
        content: '# Title\n\nFirst paragraph\n\nSecond paragraph',
      },
      semanticZoomMode: 'inspect',
    });

    try {
      act(() => {
        root.render(createElement(MarkdownPlaceholderNode, props));
      });

      act(() => {
        getButtonByText(container, 'Open editor').click();
      });

      const editor = container.querySelector('textarea');

      if (!editor) {
        throw new Error('Expected Markdown editor to render.');
      }

      act(() => {
        editor.scrollTop = 40;
        getButtonByText(container, 'Preview').click();
      });

      const previewBody = container.querySelector<HTMLDivElement>(
        '.markdown-preview-card .markdown-panel-body',
      );

      expect(previewBody).not.toBeNull();
      expect(previewBody?.scrollTop).toBe(40);

      act(() => {
        if (!previewBody) {
          throw new Error('Expected Markdown preview body to render.');
        }

        previewBody.scrollTop = 80;
        getButtonByText(container, 'Open editor').click();
      });

      expect(container.querySelector('textarea')?.scrollTop).toBe(80);
    } finally {
      offsetTopSpy.mockRestore();
    }
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

function getButtonByText(
  container: HTMLElement,
  text: string,
): HTMLButtonElement {
  const button = [...container.querySelectorAll('button')].find(
    (candidate) => candidate.textContent?.trim() === text,
  );

  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Expected button with text "${text}" to render.`);
  }

  return button;
}
