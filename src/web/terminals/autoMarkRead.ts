import type { TerminalPresentationMode } from './presentationMode';

export function shouldAutoMarkRead(
  selected: boolean,
  mode: TerminalPresentationMode,
  unreadCount: number,
): boolean {
  return selected && mode !== 'overview' && unreadCount > 0;
}
