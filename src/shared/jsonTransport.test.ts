import { z } from 'zod';
import { describe, expect, it } from 'vitest';

import { parseJsonMessage, serializeJsonMessage } from './jsonTransport';

describe('json transport helpers', () => {
  it('parses valid payloads against a schema', () => {
    const schema = z.object({
      type: z.literal('ping'),
      ok: z.boolean(),
    });

    expect(parseJsonMessage('{"type":"ping","ok":true}', schema)).toEqual({
      type: 'ping',
      ok: true,
    });
  });

  it('returns null for invalid payloads', () => {
    const schema = z.object({
      value: z.number(),
    });

    expect(parseJsonMessage('{"value":"nope"}', schema)).toBeNull();
  });

  it('serializes payloads to JSON strings', () => {
    expect(serializeJsonMessage({ ok: true })).toBe('{"ok":true}');
  });
});
