const TAIL_PROBE_LENGTH = 1_024;

export interface ScrollbackRef {
  length: number;
  tail: string;
}

export function captureScrollbackRef(scrollback: string): ScrollbackRef {
  return {
    length: scrollback.length,
    tail:
      scrollback.length <= TAIL_PROBE_LENGTH
        ? scrollback
        : scrollback.slice(scrollback.length - TAIL_PROBE_LENGTH),
  };
}

/**
 * Compute the incremental text that needs to be written to xterm, or `null` if
 * a full reset is required.
 *
 * The common append case is O(1). If the app-level scrollback cap trims from
 * the front, xterm still has its parsed buffer state, so keep writing
 * incrementally when the previous tail is still present in the capped window.
 */
export function getIncrementalWrite(
  previous: ScrollbackRef,
  nextScrollback: string,
): string | null {
  if (nextScrollback.length < previous.length) {
    return null;
  }

  if (previous.tail.length === 0) {
    return nextScrollback.slice(previous.length);
  }

  const expectedTailStart = previous.length - previous.tail.length;
  const actualTail = nextScrollback.slice(
    expectedTailStart,
    expectedTailStart + previous.tail.length,
  );

  if (actualTail === previous.tail) {
    return nextScrollback.slice(previous.length);
  }

  const cappedTailStart = nextScrollback.lastIndexOf(
    previous.tail,
    expectedTailStart,
  );

  if (cappedTailStart < 0) {
    return null;
  }

  return nextScrollback.slice(cappedTailStart + previous.tail.length);
}
