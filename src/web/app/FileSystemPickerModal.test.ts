/** @vitest-environment jsdom */

import { createElement } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FileSystemPickerModal } from './FileSystemPickerModal';
import { fetchFileSystemDirectory } from '../state/fileSystemClient';

vi.mock('../state/fileSystemClient', () => ({
  fetchFileSystemDirectory: vi.fn(),
}));

const reactActEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};

describe('FileSystemPickerModal', () => {
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
    reactActEnvironment.IS_REACT_ACT_ENVIRONMENT = false;
    document.body.innerHTML = '';
    vi.clearAllMocks();
  });

  it('opens a clicked directory in a new column to the right', async () => {
    const onConfirm = vi.fn(async () => {});
    const onClose = vi.fn();
    const mockFetch = vi.mocked(fetchFileSystemDirectory);
    mockFetch
      .mockResolvedValueOnce({
        server: 'local',
        directoryPath: '/workspace',
        parentDirectoryPath: '/',
        entries: [
          { name: 'apps', path: '/workspace/apps', kind: 'directory' },
        ],
      })
      .mockResolvedValueOnce({
        server: 'local',
        directoryPath: '/workspace/apps',
        parentDirectoryPath: '/workspace',
        entries: [],
      });

    await act(async () => {
      root.render(
        createElement(FileSystemPickerModal, {
          title: 'Select folder',
          server: 'local',
          mode: 'directory',
          initialDirectoryPath: '/workspace',
          confirmLabel: 'Select folder',
          onConfirm,
          onClose,
        }),
      );
    });
    await flushPromises();

    const directoryButton = findEntryButtonByName(container, 'apps');
    expect(directoryButton).not.toBeNull();

    await act(async () => {
      directoryButton?.click();
    });
    await flushPromises();

    expect(mockFetch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        server: 'local',
        directoryPath: '/workspace/apps',
        includeFiles: false,
      }),
    );
    expect(container.querySelectorAll('.file-picker-column').length).toBe(2);
  });

  it('passes markdown extensions and confirms selected file path', async () => {
    const onConfirm = vi.fn(async () => {});
    const onClose = vi.fn();
    const mockFetch = vi.mocked(fetchFileSystemDirectory);
    mockFetch.mockResolvedValueOnce({
      server: 'local',
      directoryPath: '/workspace',
      parentDirectoryPath: '/',
      entries: [
        { name: 'README.md', path: '/workspace/README.md', kind: 'file' },
      ],
    });

    await act(async () => {
      root.render(
        createElement(FileSystemPickerModal, {
          title: 'Open markdown',
          server: 'local',
          mode: 'file',
          initialDirectoryPath: '/workspace',
          extensions: ['.md', '.markdown'],
          confirmLabel: 'Open',
          onConfirm,
          onClose,
        }),
      );
    });
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        includeFiles: true,
        extensions: ['.md', '.markdown'],
      }),
    );

    const fileButton = findEntryButtonByName(container, 'README.md');
    expect(fileButton).not.toBeNull();

    await act(async () => {
      fileButton?.click();
    });
    await flushPromises();

    const openButton = findButtonByText(container, 'Open');
    expect(openButton).not.toBeNull();

    await act(async () => {
      openButton?.click();
    });
    await flushPromises();

    expect(onConfirm).toHaveBeenCalledWith('/workspace/README.md');
  });
});

async function flushPromises(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function findButtonByText(
  container: ParentNode,
  label: string,
): HTMLButtonElement | null {
  return [...container.querySelectorAll('button')].find(
    (button) => button.textContent?.trim() === label,
  ) as HTMLButtonElement | null;
}

function findEntryButtonByName(
  container: ParentNode,
  entryName: string,
): HTMLButtonElement | null {
  const labelNode = [...container.querySelectorAll('.file-picker-entry-name')].find(
    (candidate) => candidate.textContent?.trim() === entryName,
  );

  return labelNode?.closest('button') as HTMLButtonElement | null;
}
