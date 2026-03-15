import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import { createDefaultWorkspace, createMarkdownNode } from '../../shared/workspace';
import { MarkdownService } from './markdownService';

describe('MarkdownService', () => {
  let tempDirectory: string | null = null;

  afterEach(async () => {
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
      tempDirectory = null;
    }
  });

  it('loads markdown documents from disk for synced workspace nodes', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-markdown-'));
    await writeFile(join(tempDirectory, 'notes-1.md'), '# Plan\n\n- ship it\n', 'utf8');

    const service = new MarkdownService(tempDirectory);
    const workspace = {
      ...createDefaultWorkspace(),
      markdown: [
        createMarkdownNode(
          {
            label: 'Plan',
            filePath: './notes-1.md',
          },
          0,
        ),
      ],
    };

    await service.syncWithWorkspace(workspace);

    const document = service.getDocument(workspace.markdown[0]!.id);

    expect(document?.content).toContain('# Plan');
    expect(document?.status).toBe('ready');
    service.close();
  });

  it('surfaces conflicts when the disk version changes before save', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-markdown-'));
    const filePath = join(tempDirectory, 'notes-1.md');
    await writeFile(filePath, 'alpha\n', 'utf8');

    const service = new MarkdownService(tempDirectory);
    const workspace = {
      ...createDefaultWorkspace(),
      markdown: [
        createMarkdownNode(
          {
            label: 'Plan',
            filePath: './notes-1.md',
          },
          0,
        ),
      ],
    };

    await service.syncWithWorkspace(workspace);
    const firstVersion = service.getDocument(workspace.markdown[0]!.id)!.externalVersion;
    await writeFile(filePath, 'beta\n', 'utf8');

    const result = await service.saveDocument(
      workspace.markdown[0]!.id,
      'alpha updated\n',
      firstVersion,
    );

    expect(result.status).toBe('conflict');
    expect(result.conflict?.diskContent).toBe('beta\n');
    service.close();
  });

  it('tracks queued and active markdown links per terminal', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-markdown-'));
    await writeFile(join(tempDirectory, 'notes-1.md'), '# Notes', 'utf8');

    const service = new MarkdownService(tempDirectory);
    const workspace = {
      ...createDefaultWorkspace(),
      markdown: [
        createMarkdownNode(
          {
            label: 'Notes',
            filePath: './notes-1.md',
          },
          0,
        ),
      ],
    };

    await service.syncWithWorkspace(workspace);
    const markdownNodeId = workspace.markdown[0]!.id;

    service.queueLink(markdownNodeId, 'terminal-1');
    expect(service.getLinks()).toEqual([
      {
        markdownNodeId,
        terminalId: 'terminal-1',
        phase: 'queued',
      },
    ]);

    service.activateQueuedLink('terminal-1');
    expect(service.getLinks()[0]?.phase).toBe('active');

    service.clearTerminalLink('terminal-1');
    expect(service.getLinks()).toEqual([]);
    service.close();
  });

  it('falls back to legacy workspace-relative files for existing markdown nodes', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-markdown-'));
    const contentRoot = join(tempDirectory, 'project');
    const legacyRoot = join(tempDirectory, '.terminal-canvas');
    await mkdir(contentRoot, { recursive: true });
    await mkdir(legacyRoot, { recursive: true });
    await writeFile(join(legacyRoot, 'DISCOVERY.md'), 'abc\n', 'utf8');

    const service = new MarkdownService(contentRoot, legacyRoot);
    const workspace = {
      ...createDefaultWorkspace(),
      markdown: [
        createMarkdownNode(
          {
            label: 'Discovery',
            filePath: './DISCOVERY.md',
          },
          0,
        ),
      ],
    };

    await service.syncWithWorkspace(workspace);

    expect(service.getDocument(workspace.markdown[0]!.id)?.content).toBe('abc\n');
    service.close();
  });
});
