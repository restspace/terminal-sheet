import { describe, expect, it } from 'vitest';

import { buildCwdSwitchCommand, getShellPresets, isBashShell, isCmdShell, isPowerShellShell } from './shells';

describe('shells', () => {
  it('returns shell presets with the platform default first', () => {
    expect(getShellPresets('windows')).toEqual([
      { value: 'powershell.exe', label: 'PowerShell' },
      { value: 'bash', label: 'Bash' },
    ]);
    expect(getShellPresets('unix')).toEqual([
      { value: 'bash', label: 'Bash' },
      { value: 'powershell.exe', label: 'PowerShell' },
    ]);
  });

  it('detects shell families', () => {
    expect(isPowerShellShell('powershell.exe')).toBe(true);
    expect(isPowerShellShell('pwsh')).toBe(true);
    expect(isPowerShellShell('pwsh -NoLogo')).toBe(true);
    expect(isPowerShellShell('/usr/bin/bash')).toBe(false);

    expect(isCmdShell('cmd')).toBe(true);
    expect(isCmdShell('cmd /k')).toBe(true);
    expect(isCmdShell('C:\\Windows\\System32\\cmd.exe')).toBe(true);
    expect(isCmdShell('bash')).toBe(false);

    expect(isBashShell('bash')).toBe(true);
    expect(isBashShell('bash -l')).toBe(true);
    expect(isBashShell('/usr/bin/bash')).toBe(true);
    expect(isBashShell('C:\\Program Files\\Git\\bin\\bash.exe')).toBe(true);
    expect(isBashShell('powershell.exe')).toBe(false);
  });

  it('builds shell-specific cwd switch commands', () => {
    expect(buildCwdSwitchCommand('powershell.exe', "C:\\Users\\it's-me")).toBe(
      "Set-Location -LiteralPath 'C:\\Users\\it''s-me'\r",
    );
    expect(buildCwdSwitchCommand('cmd.exe', 'C:\\Program Files\\repo')).toBe(
      'cd /d "C:\\Program Files\\repo"\r',
    );
    expect(buildCwdSwitchCommand('bash', "/tmp/it's-me")).toBe(
      "cd -- '/tmp/it'\"'\"'s-me'\n",
    );
  });
});
