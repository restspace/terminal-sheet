export function readMachineToken(request: {
  headers: Record<string, unknown>;
  query?: unknown;
}): string | null {
  const headerToken = request.headers['x-terminal-canvas-token'];

  if (typeof headerToken === 'string' && headerToken.trim()) {
    return headerToken.trim();
  }

  if (Array.isArray(headerToken) && typeof headerToken[0] === 'string') {
    return headerToken[0];
  }

  if (
    request.query &&
    typeof request.query === 'object' &&
    'token' in request.query &&
    typeof (request.query as Record<string, unknown>).token === 'string'
  ) {
    return String((request.query as Record<string, unknown>).token);
  }

  return null;
}
