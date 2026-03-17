const SLIDING_SCROLLBACK_PROBE_CHARS = 1_024;

export function getIncrementalWrite(
  previousScrollback: string,
  nextScrollback: string,
): string | null {
  if (nextScrollback.startsWith(previousScrollback)) {
    return nextScrollback.slice(previousScrollback.length);
  }

  const overlap = getSlidingScrollbackOverlap(previousScrollback, nextScrollback);

  if (overlap === 0) {
    return null;
  }

  return nextScrollback.slice(overlap);
}

function getSlidingScrollbackOverlap(
  previousScrollback: string,
  nextScrollback: string,
): number {
  const maxOverlap = Math.min(previousScrollback.length, nextScrollback.length);

  if (maxOverlap === 0) {
    return 0;
  }

  const probeLength = Math.min(SLIDING_SCROLLBACK_PROBE_CHARS, maxOverlap);
  const probe = nextScrollback.slice(0, probeLength);
  let candidateStart = previousScrollback.lastIndexOf(probe);

  while (candidateStart !== -1) {
    const overlap = previousScrollback.length - candidateStart;

    if (
      overlap <= nextScrollback.length &&
      nextScrollback.startsWith(previousScrollback.slice(candidateStart))
    ) {
      return overlap;
    }

    if (candidateStart === 0) {
      break;
    }

    candidateStart = previousScrollback.lastIndexOf(probe, candidateStart - 1);
  }

  return 0;
}
