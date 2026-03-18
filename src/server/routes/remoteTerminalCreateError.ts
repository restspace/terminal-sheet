const MAX_REMOTE_ERROR_MESSAGE_LENGTH = 220;

export async function extractRemoteErrorMessage(
  response: Response,
): Promise<string | null> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';

  try {
    if (contentType.includes('application/json')) {
      const payload = (await response.json()) as {
        message?: unknown;
        error?: unknown;
      };
      const jsonMessage =
        (typeof payload.message === 'string' ? payload.message : null) ??
        (typeof payload.error === 'string' ? payload.error : null);

      return normalizeRemoteErrorText(jsonMessage);
    }

    const text = await response.text();
    return normalizeRemoteErrorText(text);
  } catch {
    return null;
  }
}

export function shouldRetryTerminalIdCollision(status: number): boolean {
  return status === 409;
}

export function buildRemoteTerminalCreateError(
  status: number,
  remoteMessage: string | null,
): string {
  if (status === 404) {
    const fallback =
      'Remote backend does not support terminal creation endpoint (/api/backend/terminals). Update/reinstall the remote tsheet server and verify the forwarded port targets that server.';

    if (!remoteMessage || isGenericNotFoundMessage(remoteMessage)) {
      return fallback;
    }

    return `${fallback} Remote said: ${remoteMessage}`;
  }

  if (remoteMessage) {
    return remoteMessage;
  }

  if (status === 409) {
    return 'Remote backend reported a terminal id collision.';
  }

  return `Remote backend refused terminal creation (HTTP ${status}).`;
}

function normalizeRemoteErrorText(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }

  const sanitized = value
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!sanitized) {
    return null;
  }

  return sanitized.slice(0, MAX_REMOTE_ERROR_MESSAGE_LENGTH);
}

function isGenericNotFoundMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase();

  return (
    normalized === 'not found' ||
    normalized === '{"message":"not found"}' ||
    normalized === '404 not found'
  );
}
