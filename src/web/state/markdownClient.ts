import type {
  MarkdownConflictChoice,
  MarkdownDocumentState,
} from '../../shared/markdown';
import { markdownDocumentStateSchema } from '../../shared/markdown';
import { serializeJsonMessage } from '../../shared/jsonTransport';
import { type Workspace, workspaceSchema } from '../../shared/workspace';
import { fetchWithFrontendLease } from './frontendLeaseClient';

interface MarkdownMutationResponse {
  workspace: Workspace;
  node: {
    id: string;
  };
  document: MarkdownDocumentState;
}

export async function createMarkdownDocument(input?: {
  label?: string;
  filePath?: string;
}): Promise<MarkdownMutationResponse> {
  const response = await fetchWithFrontendLease('/api/markdown/create', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: serializeJsonMessage(input ?? {}),
  });

  if (!response.ok) {
    throw new Error(`Create markdown failed with ${response.status}`);
  }

  return parseMutationResponse(await response.json());
}

export async function openMarkdownDocument(
  filePath: string,
): Promise<MarkdownMutationResponse> {
  const response = await fetchWithFrontendLease('/api/markdown/open', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: serializeJsonMessage({
      filePath,
    }),
  });

  if (!response.ok) {
    throw new Error(`Open markdown failed with ${response.status}`);
  }

  return parseMutationResponse(await response.json());
}

export async function fetchMarkdownDocument(
  nodeId: string,
): Promise<MarkdownDocumentState> {
  const response = await fetchWithFrontendLease(
    `/api/markdown/${encodeURIComponent(nodeId)}`,
  );

  if (!response.ok) {
    throw new Error(`Markdown request failed with ${response.status}`);
  }

  return markdownDocumentStateSchema.parse(await response.json());
}

export async function saveMarkdownDocument(input: {
  nodeId: string;
  content: string;
  externalVersion: string;
}): Promise<MarkdownDocumentState> {
  const response = await fetchWithFrontendLease(
    `/api/markdown/${encodeURIComponent(input.nodeId)}`,
    {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: serializeJsonMessage({
        content: input.content,
        externalVersion: input.externalVersion,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Markdown save failed with ${response.status}`);
  }

  return markdownDocumentStateSchema.parse(await response.json());
}

export async function resolveMarkdownConflict(input: {
  nodeId: string;
  choice: MarkdownConflictChoice;
  content?: string;
  externalVersion: string;
}): Promise<MarkdownDocumentState> {
  const response = await fetchWithFrontendLease(
    `/api/markdown/${encodeURIComponent(input.nodeId)}/resolve`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: serializeJsonMessage({
        choice: input.choice,
        content: input.content,
        externalVersion: input.externalVersion,
      }),
    },
  );

  if (!response.ok) {
    throw new Error(`Markdown conflict resolution failed with ${response.status}`);
  }

  return markdownDocumentStateSchema.parse(await response.json());
}

export async function queueMarkdownLink(input: {
  markdownNodeId: string;
  terminalId: string;
}): Promise<void> {
  const response = await fetchWithFrontendLease('/api/markdown/link', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: serializeJsonMessage(input),
  });

  if (!response.ok) {
    throw new Error(`Queue markdown link failed with ${response.status}`);
  }
}

function parseMutationResponse(payload: unknown): MarkdownMutationResponse {
  const candidate = payload as {
    workspace: unknown;
    node: { id: string };
    document: unknown;
  };

  return {
    workspace: workspaceSchema.parse(candidate.workspace),
    node: candidate.node,
    document: markdownDocumentStateSchema.parse(candidate.document),
  };
}
