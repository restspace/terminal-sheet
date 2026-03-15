import { startTransition, useCallback, useEffect, useRef, useState } from 'react';

import type {
  MarkdownConflictChoice,
  MarkdownDocumentState,
  MarkdownLinkState,
} from '../../shared/markdown';
import type { Workspace } from '../../shared/workspace';
import {
  createMarkdownDocument,
  fetchMarkdownDocument,
  openMarkdownDocument,
  queueMarkdownLink,
  resolveMarkdownConflict,
  saveMarkdownDocument,
} from './markdownClient';

export function useMarkdownDocuments(options: {
  workspace: Workspace | null;
  remoteDocuments: Record<string, MarkdownDocumentState>;
  remoteLinks: MarkdownLinkState[];
  replaceWorkspace: (workspace: Workspace) => void;
}) {
  const { workspace, remoteDocuments, remoteLinks, replaceWorkspace } = options;
  const [documents, setDocuments] = useState<Record<string, MarkdownDocumentState>>(
    {},
  );
  const documentsRef = useRef(documents);
  const autosaveTimersRef = useRef(new Map<string, number>());

  useEffect(() => {
    documentsRef.current = documents;
  }, [documents]);

  useEffect(() => {
    const autosaveTimers = autosaveTimersRef.current;

    return () => {
      for (const timerId of autosaveTimers.values()) {
        window.clearTimeout(timerId);
      }
      autosaveTimers.clear();
    };
  }, []);

  useEffect(() => {
    setDocuments((current) => {
      const next: Record<string, MarkdownDocumentState> = {};
      const remoteIds = new Set(Object.keys(remoteDocuments));

      for (const [nodeId, remoteDocument] of Object.entries(remoteDocuments)) {
        const existing = current[nodeId];

        if (existing && existing.dirty && existing.status !== 'saving') {
          next[nodeId] = {
            ...remoteDocument,
            content: existing.content,
            dirty: existing.content !== remoteDocument.savedContent,
            status: remoteDocument.status === 'conflict' ? 'conflict' : 'ready',
          };
          continue;
        }

        next[nodeId] = remoteDocument;
      }

      for (const nodeId of Object.keys(current)) {
        if (!remoteIds.has(nodeId) && workspace?.markdown.some((node) => node.id === nodeId)) {
          next[nodeId] = current[nodeId] as MarkdownDocumentState;
        }
      }

      return next;
    });
  }, [remoteDocuments, workspace]);

  const ensureDocumentLoaded = useCallback(async (nodeId: string) => {
    if (documentsRef.current[nodeId]) {
      return documentsRef.current[nodeId] as MarkdownDocumentState;
    }

    const document = await fetchMarkdownDocumentWithRetry(nodeId);
    setDocuments((current) => ({
      ...current,
      [nodeId]: document,
    }));
    return document;
  }, []);

  const createDocument = useCallback(async (input?: {
    label?: string;
    filePath?: string;
  }) => {
    const response = await createMarkdownDocument(input);
    replaceWorkspace(response.workspace);
    setDocuments((current) => ({
      ...current,
      [response.document.nodeId]: response.document,
    }));
    return response;
  }, [replaceWorkspace]);

  const openDocument = useCallback(async (filePath: string) => {
    const response = await openMarkdownDocument(filePath);
    replaceWorkspace(response.workspace);
    setDocuments((current) => ({
      ...current,
      [response.document.nodeId]: response.document,
    }));
    return response;
  }, [replaceWorkspace]);

  const saveDocument = useCallback(async (nodeId: string) => {
    const current = documentsRef.current[nodeId];

    if (!current) {
      throw new Error(`Markdown document ${nodeId} is not loaded.`);
    }

    setDocuments((existing) => ({
      ...existing,
      [nodeId]: {
        ...current,
        status: 'saving',
        error: null,
      },
    }));

    try {
      const saved = await saveMarkdownDocument({
        nodeId,
        content: current.content,
        externalVersion: current.externalVersion,
      });

      startTransition(() => {
        setDocuments((existing) => ({
          ...existing,
          [nodeId]: saved,
        }));
      });

      return saved;
    } catch (error) {
      setDocuments((existing) => ({
        ...existing,
        [nodeId]: {
          ...current,
          status: 'error',
          error:
            error instanceof Error ? error.message : 'Markdown save failed.',
        },
      }));
      throw error;
    }
  }, []);

  const editDocument = useCallback((nodeId: string, content: string) => {
    const existing = documentsRef.current[nodeId];

    if (!existing) {
      return;
    }

    const existingTimer = autosaveTimersRef.current.get(nodeId);

    if (existingTimer !== undefined) {
      window.clearTimeout(existingTimer);
    }

    setDocuments((current) => ({
      ...current,
      [nodeId]: {
        ...existing,
        content,
        dirty: content !== existing.savedContent,
        status: existing.conflict ? 'conflict' : 'ready',
        error: null,
      },
    }));

    if (existing.readOnly || existing.conflict) {
      return;
    }

    const timerId = window.setTimeout(() => {
      autosaveTimersRef.current.delete(nodeId);
      void saveDocument(nodeId).catch(() => {
        // The document state already reflects the save error.
      });
    }, 600);
    autosaveTimersRef.current.set(nodeId, timerId);
  }, [saveDocument]);

  const resolveConflict = useCallback(async (
    nodeId: string,
    choice: MarkdownConflictChoice,
  ) => {
    const current = documentsRef.current[nodeId];

    if (!current) {
      throw new Error(`Markdown document ${nodeId} is not loaded.`);
    }

    const resolved = await resolveMarkdownConflict({
      nodeId,
      choice,
      content: current.content,
      externalVersion: current.externalVersion,
    });

    setDocuments((existing) => ({
      ...existing,
      [nodeId]: choice === 'keep-buffer'
        ? {
            ...resolved,
            content: current.content,
            dirty: current.content !== resolved.savedContent,
          }
        : resolved,
    }));

    return resolved;
  }, []);

  const queueLinkToTerminal = useCallback(async (
    markdownNodeId: string,
    terminalId: string,
  ) => {
    await queueMarkdownLink({
      markdownNodeId,
      terminalId,
    });
  }, []);

  return {
    documents,
    links: remoteLinks,
    ensureDocumentLoaded,
    editDocument,
    createDocument,
    openDocument,
    saveDocument,
    resolveConflict,
    queueLinkToTerminal,
  };
}

async function fetchMarkdownDocumentWithRetry(
  nodeId: string,
  attemptsRemaining = 5,
): Promise<MarkdownDocumentState> {
  try {
    return await fetchMarkdownDocument(nodeId);
  } catch (error) {
    if (attemptsRemaining <= 1) {
      throw error;
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, 180);
    });

    return fetchMarkdownDocumentWithRetry(nodeId, attemptsRemaining - 1);
  }
}
