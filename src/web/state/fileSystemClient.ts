import {
  filesystemListResponseSchema,
  type FileSystemListRequest,
  type FileSystemListResponse,
} from '../../shared/filesystem';
import { serializeJsonMessage } from '../../shared/jsonTransport';

export async function fetchFileSystemDirectory(
  input: Partial<FileSystemListRequest>,
): Promise<FileSystemListResponse> {
  const response = await fetch('/api/filesystem/list', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: serializeJsonMessage(input),
  });

  if (!response.ok) {
    const message = await readErrorMessage(response);
    throw new Error(message);
  }

  return filesystemListResponseSchema.parse(await response.json());
}

async function readErrorMessage(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { message?: string };

    if (payload.message?.trim()) {
      return payload.message;
    }
  } catch {
    // Ignore invalid JSON responses and fallback to status text.
  }

  return `Filesystem request failed with ${response.status}`;
}
