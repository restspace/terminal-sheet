export interface RemoteJsonResult {
  ok: boolean;
  status: number;
  response: Response;
}

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '');
}

export function resolveUrl(baseUrl: string, path: string): string {
  return new URL(path, `${normalizeBaseUrl(baseUrl)}/`).toString();
}

export function describeNetworkError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = (error as Error & { cause?: unknown }).cause;

  if (!cause || typeof cause !== 'object') {
    return error.message;
  }

  const causeCode =
    'code' in cause && typeof (cause as { code?: unknown }).code === 'string'
      ? (cause as { code: string }).code
      : null;
  const causeMessage =
    'message' in cause && typeof (cause as { message?: unknown }).message === 'string'
      ? (cause as { message: string }).message
      : null;

  if (causeCode && causeMessage) {
    return `${error.message} (${causeCode}: ${causeMessage})`;
  }

  if (causeMessage) {
    return `${error.message} (${causeMessage})`;
  }

  if (causeCode) {
    return `${error.message} (${causeCode})`;
  }

  return error.message;
}

export async function fetchRemoteJson(
  url: string,
  token: string,
  method = 'GET',
  body?: unknown,
): Promise<RemoteJsonResult> {
  const headers: Record<string, string> = {
    'x-terminal-canvas-token': token,
  };
  const requestInit: RequestInit = { method, headers };

  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    requestInit.body = JSON.stringify(body);
  }

  const response = await fetch(url, requestInit);
  return { ok: response.ok, status: response.status, response };
}
