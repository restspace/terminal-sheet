const TAIL_PROBE_LENGTH = 1_024;

export interface ScrollbackRef {
  length: number;
  tail: string;
}

export function captureScrollbackRef(scrollback: string): ScrollbackRef {
  return {
    length: scrollback.length,
    tail: scrollback.length <= TAIL_PROBE_LENGTH
      ? scrollback
      : scrollback.slice(scrollback.length - TAIL_PROBE_LENGTH),
  };
}

/**
 * Compute the incremental text that needs to be written to xterm, or `null` if
 * a full reset is required.
 *
 * The common case (new data appended, no truncation) is O(1) — a single
 * `slice` call.  Truncation (scrollback cap reached) triggers a full reset,
 * which is the correct behaviour since xterm needs to re-render from scratch.
 */
export function getIncrementalWrite(
  previous: ScrollbackRef,
  nextScrollback: string,
): string | null {
  // Scrollback only grows unless the 120K cap triggered a trim from the front.
  if (nextScrollback.length < previous.length) {
    return null;
  }

  // Fast path: verify the tail of the previous scrollback is still in the
  // expected position.  This catches the truncation case where length grew but
  // the beginning was sliced off.
  if (previous.tail.length > 0) {
    const expectedTailStart = previous.length - previous.tail.length;
    const actualTail = nextScrollback.slice(
      expectedTailStart,
      expectedTailStart + previous.tail.length,
    );

    if (actualTail !== previous.tail) {
      return null;
    }
  }

  return nextScrollback.slice(previous.length);
}
