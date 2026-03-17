import { serializeJsonMessage } from '../../shared/jsonTransport';

export function sendJson(
  socket: {
    readyState: number;
    send: (payload: string) => void;
  },
  payload: object,
): void {
  if (socket.readyState !== 1) {
    return;
  }

  try {
    socket.send(serializeJsonMessage(payload));
  } catch {
    // Ignore shutdown races; socket reconnect handles recovery.
  }
}
