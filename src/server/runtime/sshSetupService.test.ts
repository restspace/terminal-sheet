import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import type { FastifyBaseLogger } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { parseTokenFromText, SshSetupService } from './sshSetupService';

const logger = {
  child: () => logger,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as FastifyBaseLogger;

describe('parseTokenFromText', () => {
  it('extracts token from install output format', () => {
    expect(parseTokenFromText('TSHEET_TOKEN=abc123')).toBe('abc123');
  });

  it('extracts token from machineToken key/value output', () => {
    expect(parseTokenFromText('serverId=xyz\nmachineToken=def456')).toBe('def456');
  });

  it('extracts token from JSON content', () => {
    expect(parseTokenFromText('{"machineToken":"ghi789"}')).toBe('ghi789');
  });

  it('falls back to first non-empty line', () => {
    expect(parseTokenFromText('\n  token-line \nsecond')).toBe('token-line');
  });

  it('does not treat installer log lines as tokens', () => {
    expect(
      parseTokenFromText(
        'Created symlink /home/ubuntu/.config/systemd/user/default.target.wants/terminal-sheet.service -> /home/ubuntu/.config/systemd/user/terminal-sheet.service.',
      ),
    ).toBeNull();
  });
});

describe('SshSetupService.resolveToken', () => {
  let tempDirectory: string | null = null;

  afterEach(async () => {
    if (tempDirectory) {
      await rm(tempDirectory, { recursive: true, force: true });
      tempDirectory = null;
    }
  });

  it('uses manual token mode directly', async () => {
    const service = new SshSetupService(logger, { contentRoot: process.cwd() });
    const token = await service.resolveToken({
      label: 'remote',
      sshTarget: 'user@example',
      remotePort: 4312,
      tokenMode: 'manual',
      token: ' manual-token ',
      runInstall: true,
    });

    expect(token).toBe('manual-token');
  });

  it('reads token from a local file path in file mode', async () => {
    tempDirectory = await mkdtemp(join(tmpdir(), 'terminal-canvas-ssh-token-'));
    const tokenFilePath = join(tempDirectory, 'remote-token.txt');
    await writeFile(tokenFilePath, 'machineToken=file-token-123\n', 'utf8');

    const service = new SshSetupService(logger, { contentRoot: tempDirectory });
    const token = await service.resolveToken({
      label: 'remote',
      sshTarget: 'user@example',
      remotePort: 4312,
      tokenMode: 'file',
      tokenPath: './remote-token.txt',
      runInstall: true,
    });

    expect(token).toBe('file-token-123');
  });
});

describe('SshSetupService.runInstall', () => {
  it('accepts non-zero install exit when token is emitted', async () => {
    const service = new SshSetupService(logger, { contentRoot: process.cwd() });
    const internals = service as unknown as {
      detectRemoteOs: (
        sshTarget: string,
        sshOptions: { sshPort?: number; sshIdentityFile?: string },
      ) => Promise<'linux' | 'windows'>;
      detectAvailableNodeVersion: (
        sshTarget: string,
        sshOptions: { sshPort?: number; sshIdentityFile?: string },
        detectedOs: 'linux' | 'windows',
      ) => Promise<string | null>;
      runSshCommand: (
        sshTarget: string,
        remoteCommand: string,
        sshOptions: { sshPort?: number; sshIdentityFile?: string },
      ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
    };

    internals.detectRemoteOs = async () => 'linux';
    internals.detectAvailableNodeVersion = async () => 'v12.16.0';
    internals.runSshCommand = async () => ({
      code: 255,
      stdout: 'TSHEET_TOKEN=token-from-install\n',
      stderr: '',
    });

    const result = await service.runInstall(
      'ubuntu@example',
      {},
      'http://127.0.0.1:4312',
      4312,
      true,
    );

    expect(result.detectedOs).toBe('linux');
    expect(result.capturedToken).toBe('token-from-install');
    expect(result.availableNodeVersion).toBe('v12.16.0');
  });

  it('includes the available Node.js version when install fails without token output', async () => {
    const service = new SshSetupService(logger, { contentRoot: process.cwd() });
    const internals = service as unknown as {
      detectRemoteOs: (
        sshTarget: string,
        sshOptions: { sshPort?: number; sshIdentityFile?: string },
      ) => Promise<'linux' | 'windows'>;
      detectAvailableNodeVersion: (
        sshTarget: string,
        sshOptions: { sshPort?: number; sshIdentityFile?: string },
        detectedOs: 'linux' | 'windows',
      ) => Promise<string | null>;
      runSshCommand: (
        sshTarget: string,
        remoteCommand: string,
        sshOptions: { sshPort?: number; sshIdentityFile?: string },
      ) => Promise<{ code: number | null; stdout: string; stderr: string }>;
    };

    internals.detectRemoteOs = async () => 'linux';
    internals.detectAvailableNodeVersion = async () => 'v12.16.0';
    internals.runSshCommand = async () => ({
      code: 1,
      stdout: 'Created symlink /tmp/service\n',
      stderr: 'ERROR: remote backend started but failed health check on port 4312.\n',
    });

    await expect(
      service.runInstall('ubuntu@example', {}, 'http://127.0.0.1:4312', 4312, true),
    ).rejects.toThrow(
      'Remote install failed (exit code 1): ERROR: remote backend started but failed health check on port 4312. Available Node.js in SSH session: v12.16.0. Terminal Sheet requires Node.js v20+ in the SSH session.',
    );
  });
});
