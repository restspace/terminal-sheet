import { describe, expect, it } from 'vitest';

import { getLayoutStrategy } from './strategyRegistry';

describe('layout strategy registry', () => {
  it('resolves strategies by layout mode', () => {
    expect(getLayoutStrategy('free').mode).toBe('free');
    expect(getLayoutStrategy('focus-tiles').mode).toBe('focus-tiles');
  });
});
