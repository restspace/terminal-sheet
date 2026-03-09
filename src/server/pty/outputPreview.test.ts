import { describe, expect, it } from 'vitest';

import { extractPreviewLines, renderTerminalText } from './outputPreview';

describe('renderTerminalText', () => {
  it('coalesces carriage-return prompt redraws instead of duplicating input', () => {
    const prompt = 'PS C:\\dev\\terminal-sheet> ';
    const raw =
      `${prompt}` +
      `\u001b[?25l\r\u001b[2K${prompt}g\u001b[?25h` +
      `\u001b[?25l\r\u001b[2K${prompt}gi\u001b[?25h` +
      `\u001b[?25l\r\u001b[2K${prompt}git\u001b[?25h`;

    expect(renderTerminalText(raw)).toBe(`${prompt}git`.trimEnd());
  });

  it('keeps committed lines while preserving the current prompt line', () => {
    const prompt = 'PS C:\\repo> ';
    const raw =
      'Booting shell\r\n' +
      `${prompt}` +
      `\u001b[?25l\r\u001b[2K${prompt}dir\u001b[?25h`;

    expect(extractPreviewLines(renderTerminalText(raw))).toEqual([
      'Booting shell',
      `${prompt}dir`.trimEnd(),
    ]);
  });

  it('applies backspace-like deletes within the current line', () => {
    const raw = 'abc\b\bZ';

    expect(renderTerminalText(raw)).toBe('aZ');
  });

  it('honors absolute cursor moves used by PowerShell prompt repainting', () => {
    const prompt = 'PS C:\\dev\\terminal-sheet> ';
    const raw =
      `\u001b[6;1H${prompt}` +
      '\u001b[93mgi' +
      `\u001b[m\u001b[93m\u001b[6;27Hgit\u001b[?25h`;

    expect(extractPreviewLines(renderTerminalText(raw))).toEqual([
      `${prompt}git`.trimEnd(),
    ]);
  });
});
