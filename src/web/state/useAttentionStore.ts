import { useCallback, useState } from 'react';

import type { AttentionEvent } from '../../shared/events';
import type { TerminalServerSocketMessage } from '../../shared/terminalSessions';

interface AttentionStore {
  attentionEvents: AttentionEvent[];
  handleAttentionMessage: (message: TerminalServerSocketMessage) => void;
}

export function useAttentionStore(): AttentionStore {
  const [attentionEvents, setAttentionEvents] = useState<AttentionEvent[]>([]);

  const handleAttentionMessage = useCallback(
    (message: TerminalServerSocketMessage) => {
      setAttentionEvents((current) => applyAttentionMessage(current, message));
    },
    [],
  );

  return {
    attentionEvents,
    handleAttentionMessage,
  };
}

export function applyAttentionMessage(
  current: AttentionEvent[],
  message: TerminalServerSocketMessage,
): AttentionEvent[] {
  switch (message.type) {
    case 'attention.init':
      return message.events;
    case 'attention.event':
      return [message.event, ...current].slice(0, 48);
    default:
      return current;
  }
}
