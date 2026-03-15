import { describe, expect, it } from 'vitest';

import { shouldAutoMarkRead } from './autoMarkRead';

describe('shouldAutoMarkRead', () => {
  it('only auto-marks selected non-overview terminals with unread output', () => {
    expect(shouldAutoMarkRead(true, 'focus', 3)).toBe(true);
    expect(shouldAutoMarkRead(true, 'inspect', 1)).toBe(true);
    expect(shouldAutoMarkRead(true, 'overview', 3)).toBe(false);
    expect(shouldAutoMarkRead(false, 'focus', 3)).toBe(false);
    expect(shouldAutoMarkRead(true, 'focus', 0)).toBe(false);
  });
});
