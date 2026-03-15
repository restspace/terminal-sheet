import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { afterEach, describe, expect, it } from 'vitest';

import type { TerminalNode } from '../../shared/workspace';
import { CodexIntegrationProvider } from './codexIntegrationProvider';

const terminal: TerminalNode = {
  id: 'terminal-codex',
  backendId: 'local',
  label: 'Codex 1',
  repoLabel: 'terminal-sheet',
  taskLabel: 'codex worker',
  shell: 'powershell.exe',
  cwd: '.',
  agentType: 'codex',
  status: 'idle',
  bounds: {
    x: 0,
    y: 0,
    width: 400,
    height: 280,
  },
  tags: [],
};

describe('CodexIntegrationProvider', () => {
  let tempDirectory: string | null = null;

  afterEach(async () => {
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
      tempDirectory = null;
    }
  });

  it('resolves the nearest repo root for nested directories', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-codex-provider-'));
    await mkdir(join(tempDirectory, '.git'));
    await mkdir(join(tempDirectory, 'packages', 'app'), { recursive: true });
    const provider = createProvider();

    const projectRoot = await provider.resolveProjectRoot(
      join(tempDirectory, 'packages', 'app'),
    );

    expect(projectRoot).toBe(tempDirectory);
  });

  it('treats an existing .codex directory as a project root', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-codex-provider-'));
    await mkdir(join(tempDirectory, '.codex'));
    await mkdir(join(tempDirectory, 'scratch'));
    const provider = createProvider();

    const projectRoot = await provider.resolveProjectRoot(
      join(tempDirectory, 'scratch'),
    );

    expect(projectRoot).toBe(tempDirectory);
  });

  it('bootstraps a managed Codex config file for a fresh repo', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-codex-provider-'));
    await mkdir(join(tempDirectory, '.git'));
    const provider = createProvider();

    const result = await provider.prepareForProject({
      terminal,
      projectRoot: tempDirectory,
    });

    const configPath = join(tempDirectory, '.codex', 'config.toml');
    const raw = await readFile(configPath, 'utf8');

    expect(result.status).toBe('configured');
    expect(raw).toContain('notify = [');
    expect(raw).toContain('TERMINAL_CANVAS_SESSION_ID');
    expect(raw).toContain('TERMINAL_CANVAS_ATTENTION_URL/codex');
  });

  it('adds a managed notify command without disturbing unrelated Codex config', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-codex-provider-'));
    await mkdir(join(tempDirectory, '.git'));
    await mkdir(join(tempDirectory, '.codex'));
    const configPath = join(tempDirectory, '.codex', 'config.toml');
    await writeFile(
      configPath,
      'model = "gpt-5.4"\n\n[projects."C:/dev/example"]\ntrust_level = "trusted"\n',
      'utf8',
    );
    const provider = createProvider();

    const result = await provider.prepareForProject({
      terminal,
      projectRoot: tempDirectory,
    });
    const raw = await readFile(configPath, 'utf8');

    expect(result.status).toBe('configured');
    expect(raw).toContain('model = "gpt-5.4"');
    expect(raw).toContain('trust_level = "trusted"');
    expect(raw).toContain('notify = [');
  });

  it('reports a conflict when the repo already defines a different notify command', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-codex-provider-'));
    await mkdir(join(tempDirectory, '.git'));
    await mkdir(join(tempDirectory, '.codex'));
    const configPath = join(tempDirectory, '.codex', 'config.toml');
    await writeFile(
      configPath,
      'notify = ["custom-notify", "--flag"]\n',
      'utf8',
    );
    const provider = createProvider();

    const result = await provider.prepareForProject({
      terminal,
      projectRoot: tempDirectory,
    });
    const raw = await readFile(configPath, 'utf8');

    expect(result.status).toBe('conflict');
    expect(raw).toBe('notify = ["custom-notify", "--flag"]\n');
  });

  it('does not rewrite the managed config file when preparing the same repo twice', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-codex-provider-'));
    await mkdir(join(tempDirectory, '.git'));
    const provider = createProvider();

    await provider.prepareForProject({
      terminal,
      projectRoot: tempDirectory,
    });
    const configPath = join(tempDirectory, '.codex', 'config.toml');
    const firstStat = await stat(configPath);

    await provider.prepareForProject({
      terminal,
      projectRoot: tempDirectory,
    });
    const secondStat = await stat(configPath);

    expect(secondStat.mtimeMs).toBe(firstStat.mtimeMs);
  });
});

function createProvider(): CodexIntegrationProvider {
  return new CodexIntegrationProvider();
}
