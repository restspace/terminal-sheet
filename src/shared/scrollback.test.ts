import { describe, expect, it } from 'vitest';

import { appendScrollback, MAX_SCROLLBACK_CHARS } from './scrollback';

describe('appendScrollback', () => {
  it('appends smaller chunks without truncation', () => {
    expect(appendScrollback('abc', 'def')).toBe('abcdef');
  });

  it('truncates from the front once the limit is exceeded', () => {
    const oversized = 'x'.repeat(MAX_SCROLLBACK_CHARS) + 'tail';

    const next = appendScrollback('', oversized);

    expect(next).toHaveLength(MAX_SCROLLBACK_CHARS);
    expect(next.endsWith('tail')).toBe(true);
  });
});
