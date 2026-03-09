export const MAX_SCROLLBACK_CHARS = 120_000;

export function appendScrollback(scrollback: string, chunk: string): string {
  const combined = scrollback + chunk;

  if (combined.length <= MAX_SCROLLBACK_CHARS) {
    return combined;
  }

  return combined.slice(combined.length - MAX_SCROLLBACK_CHARS);
}
