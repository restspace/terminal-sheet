import { describe, expect, it } from 'vitest';

import { parseCommand } from './commandLine';

describe('parseCommand', () => {
  it('splits a command line into file and args', () => {
    expect(parseCommand('bash -lc "pwd"')).toEqual({
      file: process.platform === 'win32' ? 'bash.exe' : 'bash',
      args: ['-lc', 'pwd'],
    });
  });

  it('falls back to the default shell for blank commands', () => {
    expect(parseCommand('   ')).toEqual({
      file: process.platform === 'win32' ? 'powershell.exe' : 'bash',
      args: [],
    });
  });
});
