/** @vitest-environment jsdom */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CodeMirrorMarkdownEditor } from './CodeMirrorMarkdownEditor';

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('CodeMirrorMarkdownEditor', () => {
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
    vi.restoreAllMocks();
  });

  it('renders the provided markdown text into the editor DOM', async () => {
    await act(async () => {
      root.render(
        createElement(CodeMirrorMarkdownEditor, {
          value: '# Title\n\nabc',
          readOnly: false,
          onChange: () => {},
        }),
      );
    });

    const content = container.querySelector('textarea');

    expect(content?.value).toContain('Title');
    expect(content?.value).toContain('abc');
  });

  it('updates the editor content when the value prop changes', async () => {
    await act(async () => {
      root.render(
        createElement(CodeMirrorMarkdownEditor, {
          value: 'first',
          readOnly: false,
          onChange: () => {},
        }),
      );
    });

    await act(async () => {
      root.render(
        createElement(CodeMirrorMarkdownEditor, {
          value: 'second',
          readOnly: false,
          onChange: () => {},
        }),
      );
    });

    const content = container.querySelector('textarea');

    expect(content?.value).toContain('second');
  });
});
