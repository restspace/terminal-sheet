import { describe, expect, it } from 'vitest';

import {
  buildRemoteTerminalCreateError,
  extractRemoteErrorMessage,
  shouldRetryTerminalIdCollision,
} from './remoteTerminalCreateError';

describe('remoteTerminalCreateError', () => {
  it('extracts JSON error messages', async () => {
    const response = new Response(
      JSON.stringify({
        message: 'Terminal terminal-123 already exists.',
      }),
      {
        status: 409,
        headers: {
          'content-type': 'application/json',
        },
      },
    );

    await expect(extractRemoteErrorMessage(response)).resolves.toBe(
      'Terminal terminal-123 already exists.',
    );
  });

  it('extracts plain text messages and strips markup', async () => {
    const response = new Response(
      '<html><body>Remote backend error: unsupported route</body></html>',
      {
        status: 404,
        headers: {
          'content-type': 'text/html',
        },
      },
    );

    await expect(extractRemoteErrorMessage(response)).resolves.toBe(
      'Remote backend error: unsupported route',
    );
  });

  it('builds fallback messages when no remote detail is present', () => {
    expect(buildRemoteTerminalCreateError(404, null)).toBe(
      'Remote backend does not support terminal creation endpoint (/api/backend/terminals). Update/reinstall the remote tsheet server and verify the forwarded port targets that server.',
    );
    expect(buildRemoteTerminalCreateError(409, null)).toBe(
      'Remote backend reported a terminal id collision.',
    );
    expect(buildRemoteTerminalCreateError(503, null)).toBe(
      'Remote backend refused terminal creation (HTTP 503).',
    );
  });

  it('prefers remote message when available', () => {
    expect(
      buildRemoteTerminalCreateError(
        500,
        'Terminal terminal-123 already exists.',
      ),
    ).toBe('Terminal terminal-123 already exists.');
  });

  it('normalizes generic 404 not-found responses to compatibility guidance', () => {
    expect(buildRemoteTerminalCreateError(404, 'Not found')).toBe(
      'Remote backend does not support terminal creation endpoint (/api/backend/terminals). Update/reinstall the remote tsheet server and verify the forwarded port targets that server.',
    );
  });

  it('retries terminal creation only for 409 responses', () => {
    expect(shouldRetryTerminalIdCollision(409)).toBe(true);
    expect(shouldRetryTerminalIdCollision(400)).toBe(false);
    expect(shouldRetryTerminalIdCollision(500)).toBe(false);
  });
});
