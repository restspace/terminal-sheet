import type { ZodType } from 'zod';

export function parseJsonMessage<T>(
  payload: unknown,
  schema: ZodType<T>,
): T | null {
  try {
    return schema.parse(JSON.parse(String(payload)));
  } catch {
    return null;
  }
}

export function serializeJsonMessage(payload: unknown): string {
  return JSON.stringify(payload);
}
