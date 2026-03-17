import { useEffect, useRef, type CSSProperties, type ReactNode } from 'react';

import type { TerminalNode, TerminalStatus } from '../../shared/workspace';

interface TerminalTitleBarProps {
  terminal: TerminalNode;
  status: TerminalStatus;
  currentPath?: string;
  className?: string;
  sidecar?: ReactNode;
  onPathSelectRequest?: (terminalId: string) => void;
  onTerminalChange?: (
    terminalId: string,
    patch: Partial<Pick<TerminalNode, 'label' | 'cwd'>>,
  ) => void;
  onClose?: (terminalId: string) => void;
}

export function TerminalTitleBar({
  terminal,
  status,
  currentPath,
  className,
  sidecar,
  onPathSelectRequest,
  onTerminalChange,
  onClose,
}: TerminalTitleBarProps) {
  const labelInputRef = useRef<HTMLInputElement | null>(null);
  const pathValue = (currentPath?.trim() || terminal.cwd || '.').trim();
  const pathBubbleStyle = getPathBubbleStyle(pathValue);
  const pathLabel = pathValue;
  const statusLabel = formatStatusLabel(status);

  useEffect(() => {
    if (
      labelInputRef.current &&
      document.activeElement !== labelInputRef.current
    ) {
      labelInputRef.current.value = terminal.label;
    }
  }, [terminal.label]);

  return (
    <div className={className}>
      <div className="terminal-header-line">
        <input
          ref={labelInputRef}
          className="terminal-inline-input terminal-inline-input-label nodrag nopan"
          aria-label="Terminal label"
          defaultValue={terminal.label}
          onChange={(event) => {
            const nextValue = event.target.value;
            onTerminalChange?.(terminal.id, { label: nextValue });
          }}
          onBlur={(event) => {
            if (!event.target.value.trim()) {
              const fallbackLabel = terminal.label || 'Shell';
              event.target.value = fallbackLabel;
              onTerminalChange?.(terminal.id, { label: fallbackLabel });
            }
          }}
          onPointerDown={stopEventPropagation}
          onClick={stopEventPropagation}
        />
        <span className="terminal-header-token" title={terminal.shell}>
          {terminal.shell}
        </span>
        {onPathSelectRequest ? (
          <button
            type="button"
            className="terminal-header-token terminal-header-token-path terminal-header-token-button nodrag nopan"
            title={pathValue}
            style={pathBubbleStyle}
            onPointerDown={stopPointerEventPropagation}
            onClick={(event) => {
              stopEventPropagation(event);
              onPathSelectRequest(terminal.id);
            }}
          >
            {pathLabel}
          </button>
        ) : (
          <span
            className="terminal-header-token terminal-header-token-path"
            title={pathValue}
            style={pathBubbleStyle}
          >
            {pathLabel}
          </span>
        )}
      </div>
      <div className="terminal-header-sidecar">
        {sidecar}
        {onClose ? (
          <button
            className="terminal-header-close-button nodrag nopan"
            type="button"
            aria-label={`Close ${terminal.label}`}
            onPointerDown={stopPointerEventPropagation}
            onClick={(event) => {
              stopEventPropagation(event);
              onClose(terminal.id);
            }}
          >
            Close
          </button>
        ) : null}
        <span className={`canvas-node-status is-${status}`}>{statusLabel}</span>
      </div>
    </div>
  );
}

function stopEventPropagation(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}

function stopPointerEventPropagation(event: {
  stopPropagation: () => void;
  preventDefault: () => void;
}): void {
  event.preventDefault();
  event.stopPropagation();
}

const DIRECTORY_BUBBLE_COLORS = [
  'rgba(66, 104, 141, 0.52)',
  'rgba(58, 122, 122, 0.5)',
  'rgba(82, 111, 84, 0.52)',
  'rgba(118, 92, 58, 0.5)',
  'rgba(97, 84, 130, 0.52)',
  'rgba(104, 70, 95, 0.52)',
  'rgba(57, 114, 150, 0.52)',
  'rgba(92, 117, 62, 0.5)',
  'rgba(121, 89, 61, 0.52)',
  'rgba(71, 92, 121, 0.52)',
] as const;

const directoryPathColorByPath = new Map<string, string>();
let nextDirectoryColorIndex = 0;

function getPathBubbleStyle(pathValue: string): CSSProperties {
  return {
    background: getDirectoryBubbleColor(pathValue),
    borderColor: 'rgba(154, 202, 245, 0.28)',
  };
}

function getDirectoryBubbleColor(pathValue: string): string {
  const normalizedPath = pathValue.trim() || '.';
  const existingColor = directoryPathColorByPath.get(normalizedPath);

  if (existingColor) {
    return existingColor;
  }

  const color = DIRECTORY_BUBBLE_COLORS[
    nextDirectoryColorIndex % DIRECTORY_BUBBLE_COLORS.length
  ] as string;
  nextDirectoryColorIndex += 1;
  directoryPathColorByPath.set(normalizedPath, color);
  return color;
}

function formatStatusLabel(status: TerminalStatus): string {
  if (status === 'active-output') {
    return 'running';
  }

  return status;
}
