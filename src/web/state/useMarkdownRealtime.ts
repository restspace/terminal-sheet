import { useCallback, useState } from 'react';

import type {
  MarkdownDocumentState,
  MarkdownLinkState,
} from '../../shared/markdown';
import type { TerminalServerSocketMessage } from '../../shared/terminalSessions';

interface MarkdownRealtimeStore {
  markdownDocuments: Record<string, MarkdownDocumentState>;
  markdownLinks: MarkdownLinkState[];
  handleMarkdownMessage: (message: TerminalServerSocketMessage) => void;
}

export function useMarkdownRealtime(): MarkdownRealtimeStore {
  const [markdownDocuments, setMarkdownDocuments] = useState<
    Record<string, MarkdownDocumentState>
  >({});
  const [markdownLinks, setMarkdownLinks] = useState<MarkdownLinkState[]>([]);

  const handleMarkdownMessage = useCallback(
    (message: TerminalServerSocketMessage) => {
      setMarkdownDocuments((current) =>
        applyMarkdownDocumentMessage(current, message),
      );
      setMarkdownLinks((current) => applyMarkdownLinkMessage(current, message));
    },
    [],
  );

  return {
    markdownDocuments,
    markdownLinks,
    handleMarkdownMessage,
  };
}

export function applyMarkdownDocumentMessage(
  current: Record<string, MarkdownDocumentState>,
  message: TerminalServerSocketMessage,
): Record<string, MarkdownDocumentState> {
  switch (message.type) {
    case 'markdown.init':
      return Object.fromEntries(
        message.documents.map((document) => [document.nodeId, document]),
      );
    case 'markdown.document':
      return {
        ...current,
        [message.document.nodeId]: message.document,
      };
    default:
      return current;
  }
}

export function applyMarkdownLinkMessage(
  current: MarkdownLinkState[],
  message: TerminalServerSocketMessage,
): MarkdownLinkState[] {
  switch (message.type) {
    case 'markdown.link.init':
    case 'markdown.link':
      return message.links;
    default:
      return current;
  }
}
