import type { TerminalPresentationMode } from './terminalSurfaceModel';

export function shouldAutoMarkRead(
  selected: boolean,
  mode: TerminalPresentationMode,
  unreadCount: number,
): boolean {
  return selected && mode !== 'overview' && unreadCount > 0;
}
