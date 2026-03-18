import { describe, expect, it } from 'vitest';

import {
  backendConnectionSchema,
  backendTerminalCreateRequestSchema,
  backendSshSetupRequestSchema,
} from './backends';

describe('backend schemas', () => {
  it('allows existing direct backend connections without SSH metadata', () => {
    const parsed = backendConnectionSchema.parse({
      id: 'remote-1',
      label: 'Remote 1',
      baseUrl: 'http://127.0.0.1:4312',
      token: 'abc123',
      enabled: true,
    });

    expect(parsed.transport).toBe('direct');
    expect(parsed.ssh).toBeUndefined();
  });

  it('requires SSH metadata when transport is ssh-tunnel', () => {
    expect(() =>
      backendConnectionSchema.parse({
        id: 'remote-1',
        label: 'Remote 1',
        baseUrl: 'http://127.0.0.1:5512',
        token: 'abc123',
        transport: 'ssh-tunnel',
        enabled: true,
      }),
    ).toThrow('SSH tunnel transport requires SSH configuration.');

    const parsed = backendConnectionSchema.parse({
      id: 'remote-1',
      label: 'Remote 1',
      baseUrl: 'http://127.0.0.1:5512',
      token: 'abc123',
      transport: 'ssh-tunnel',
      ssh: {
        target: 'user@example',
        localPort: 5512,
      },
      enabled: true,
    });

    expect(parsed.ssh?.target).toBe('user@example');
  });

  it('validates SSH setup token mode requirements', () => {
    expect(() =>
      backendSshSetupRequestSchema.parse({
        label: 'Remote SSH',
        sshTarget: 'user@example',
        remotePort: 4312,
        tokenMode: 'manual',
        runInstall: true,
      }),
    ).toThrow('Token is required for manual mode.');

    expect(() =>
      backendSshSetupRequestSchema.parse({
        label: 'Remote SSH',
        sshTarget: 'user@example',
        remotePort: 4312,
        tokenMode: 'file',
        runInstall: true,
      }),
    ).toThrow('Token path is required for file mode.');

    expect(() =>
      backendSshSetupRequestSchema.parse({
        label: 'Remote SSH',
        sshTarget: 'user@example',
        remotePort: 4312,
        tokenMode: 'install-output',
        runInstall: false,
      }),
    ).toThrow('Install-output token mode requires running the install script.');

    const parsed = backendSshSetupRequestSchema.parse({
      label: 'Remote SSH',
      sshTarget: 'user@example',
      sshPort: 2222,
      sshIdentityFile: '/home/user/.ssh/key.pem',
      remotePort: 4312,
      tokenMode: 'install-output',
      runInstall: true,
    });

    expect(parsed.tokenMode).toBe('install-output');
    expect(parsed.sshPort).toBe(2222);
    expect(parsed.sshIdentityFile).toBe('/home/user/.ssh/key.pem');
  });

  it('validates remote terminal creation payloads', () => {
    const parsed = backendTerminalCreateRequestSchema.parse({
      label: 'Build shell',
      shell: 'bash',
      cwd: '.',
      agentType: 'shell',
    });

    expect(parsed.tags).toEqual([]);

    expect(() =>
      backendTerminalCreateRequestSchema.parse({
        label: 'Invalid',
        shell: 'bash',
        cwd: '.',
        agentType: 'unknown',
      }),
    ).toThrow();
  });
});
