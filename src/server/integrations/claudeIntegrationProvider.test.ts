import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import type { TerminalNode } from '../../shared/workspace';
import { ClaudeIntegrationProvider } from './claudeIntegrationProvider';

const terminal: TerminalNode = {
  id: 'terminal-claude',
  backendId: 'local',
  label: 'Claude 1',
  repoLabel: 'terminal-sheet',
  taskLabel: 'claude worker',
  shell: 'powershell.exe',
  cwd: '.',
  agentType: 'claude',
  status: 'idle',
  bounds: {
    x: 0,
    y: 0,
    width: 400,
    height: 280,
  },
  tags: [],
};

describe('ClaudeIntegrationProvider', () => {
  let tempDirectory: string | null = null;

  afterEach(async () => {
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
      tempDirectory = null;
    }
  });

  it('resolves the nearest repo root for nested directories', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-claude-provider-'));
    await mkdir(join(tempDirectory, '.git'));
    await mkdir(join(tempDirectory, 'packages', 'app'), { recursive: true });
    const provider = createProvider();

    const projectRoot = await provider.resolveProjectRoot(
      join(tempDirectory, 'packages', 'app'),
    );

    expect(projectRoot).toBe(tempDirectory);
  });

  it('treats an existing .claude directory as a project root', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-claude-provider-'));
    await mkdir(join(tempDirectory, '.claude'));
    await mkdir(join(tempDirectory, 'scratch'));
    const provider = createProvider();

    const projectRoot = await provider.resolveProjectRoot(
      join(tempDirectory, 'scratch'),
    );

    expect(projectRoot).toBe(tempDirectory);
  });

  it('bootstraps a managed Claude settings file for a fresh repo', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-claude-provider-'));
    await mkdir(join(tempDirectory, '.git'));
    const provider = createProvider();

    const result = await provider.prepareForProject({
      terminal,
      projectRoot: tempDirectory,
    });

    const settingsPath = join(tempDirectory, '.claude', 'settings.local.json');
    const raw = await readFile(settingsPath, 'utf8');

    expect(result.status).toBe('configured');
    expect(raw).toContain('http://127.0.0.1:4312/api/attention/claude');
  });

  it('does not rewrite the managed settings file when preparing the same repo twice', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-claude-provider-'));
    await mkdir(join(tempDirectory, '.git'));
    const provider = createProvider();

    await provider.prepareForProject({
      terminal,
      projectRoot: tempDirectory,
    });
    const settingsPath = join(tempDirectory, '.claude', 'settings.local.json');
    const firstStat = await stat(settingsPath);

    await provider.prepareForProject({
      terminal,
      projectRoot: tempDirectory,
    });
    const secondStat = await stat(settingsPath);

    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });
});

function createProvider(): ClaudeIntegrationProvider {
  return new ClaudeIntegrationProvider({
    attentionReceiverUrl: 'http://127.0.0.1:4312/api/attention',
  });
}
