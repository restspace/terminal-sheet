import { useEffect, useRef, type ReactNode } from 'react';

import type { TerminalNode, TerminalStatus } from '../../shared/workspace';

interface TerminalTitleBarProps {
  terminal: TerminalNode;
  status: TerminalStatus;
  className?: string;
  sidecar?: ReactNode;
  onTerminalChange?: (
    terminalId: string,
    patch: Partial<Pick<TerminalNode, 'label' | 'cwd'>>,
  ) => void;
}

export function TerminalTitleBar({
  terminal,
  status,
  className,
  sidecar,
  onTerminalChange,
}: TerminalTitleBarProps) {
  const labelInputRef = useRef<HTMLInputElement | null>(null);
  const pathLabel =
    terminal.repoLabel ?? terminal.taskLabel ?? 'local workspace';

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
        <span className="terminal-header-token" title={pathLabel}>
          {pathLabel}
        </span>
      </div>
      <div className="terminal-header-sidecar">
        {sidecar}
        <span className={`canvas-node-status is-${status}`}>{status}</span>
      </div>
    </div>
  );
}

function stopEventPropagation(event: { stopPropagation: () => void }): void {
  event.stopPropagation();
}
