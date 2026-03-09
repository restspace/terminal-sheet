import { describe, expect, it } from 'vitest';

import { getDefaultShell } from './platform';

describe('platform helpers', () => {
  it('uses PowerShell on Windows', () => {
    expect(getDefaultShell('windows')).toBe('powershell.exe');
  });

  it('uses bash on unix-like platforms', () => {
    expect(getDefaultShell('unix')).toBe('bash');
  });
});
