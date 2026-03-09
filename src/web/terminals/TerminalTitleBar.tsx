import { useEffect, useState, type ReactNode } from 'react';

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
  const [labelDraft, setLabelDraft] = useState(terminal.label);
  const pathLabel =
    terminal.repoLabel ?? terminal.taskLabel ?? 'local workspace';

  useEffect(() => {
    setLabelDraft(terminal.label);
  }, [terminal.label]);

  return (
    <div className={className}>
      <div className="terminal-header-line">
        <input
          className="terminal-inline-input terminal-inline-input-label nodrag nopan"
          aria-label="Terminal label"
          value={labelDraft}
          onChange={(event) => {
            const nextValue = event.target.value;
            setLabelDraft(nextValue);
            onTerminalChange?.(terminal.id, { label: nextValue });
          }}
          onBlur={() => {
            if (!labelDraft.trim()) {
              const fallbackLabel = terminal.label || 'Shell';
              setLabelDraft(fallbackLabel);
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
