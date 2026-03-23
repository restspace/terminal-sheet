import { afterEach, describe, expect, it, vi } from 'vitest';

import { getDefaultShell, getRuntimePlatform } from './platform';

describe('platform helpers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses PowerShell on Windows', () => {
    expect(getDefaultShell('windows')).toBe('powershell.exe');
  });

  it('uses bash on unix-like platforms', () => {
    expect(getDefaultShell('unix')).toBe('bash');
  });

  it('detects windows from browser user agent', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    });

    expect(getRuntimePlatform()).toBe('windows');
  });

  it('falls back to runtime platform when browser is not windows', () => {
    vi.stubGlobal('navigator', {
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64)',
    });

    expect(getRuntimePlatform()).toBe(
      process.platform === 'win32' ? 'windows' : 'unix',
    );
  });
});
