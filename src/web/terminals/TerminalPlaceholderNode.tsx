import { useEffect } from 'react';

import { NodeResizer, type NodeProps, useViewport } from '@xyflow/react';

import { getSemanticZoomMode } from '../../shared/workspace';
import { TerminalFocusSurface } from './TerminalFocusSurface';
import type { TerminalFlowNode } from './types';

export function TerminalPlaceholderNode(props: NodeProps<TerminalFlowNode>) {
  const { data, selected } = props;
  const { zoom } = useViewport();
  const mode = getSemanticZoomMode(zoom);
  const terminal = data.terminal;
  const session = data.session;
  const { onInput, onResize, onRestart, onMarkRead } = data;
  const canAttachTerminal = mode === 'focus' && selected && data.isInteractive;
  const previewLines = session?.previewLines ?? [];

  useEffect(() => {
    if (canAttachTerminal && session?.unreadCount) {
      onMarkRead(terminal.id);
    }
  }, [canAttachTerminal, onMarkRead, session?.unreadCount, terminal.id]);

  return (
    <div
      className={
        selected
          ? 'canvas-node terminal-node is-selected'
          : 'canvas-node terminal-node'
      }
    >
      <NodeResizer
        isVisible={selected}
        minWidth={260}
        minHeight={180}
        color="#8ab4d8"
        lineStyle={{ borderColor: 'rgba(138, 180, 216, 0.55)' }}
        handleStyle={{ background: '#8ab4d8', borderColor: '#04111d' }}
      />

      <div className="canvas-node-content">
        <div className="node-drag-handle canvas-node-header">
          <div>
            <p className="canvas-node-kicker">Terminal node</p>
            <strong>{terminal.label}</strong>
          </div>
          <span className={`canvas-node-status is-${session?.status ?? terminal.status}`}>
            {session?.status ?? terminal.status}
          </span>
        </div>

        <div className="canvas-node-meta">
          <span>{terminal.agentType}</span>
          <span>{terminal.shell}</span>
          <span>{terminal.cwd}</span>
          <span>{session?.connected ? 'live' : session?.recoveryState ?? 'pending'}</span>
        </div>

        {mode === 'overview' ? (
          <div className="canvas-node-summary">
            <p>Overview card</p>
            <strong>
              {session?.lastOutputLine ??
                terminal.taskLabel ??
                'Waiting for session launch'}
            </strong>
            <span>{terminal.repoLabel ?? 'No repo label yet'}</span>
            <span>
              {session
                ? `${session.unreadCount} unread - ${session.summary}`
                : 'Waiting for PTY session startup'}
            </span>
          </div>
        ) : null}

        {mode === 'inspect' ? (
          <div className="canvas-node-summary">
            <p>Inspect preview</p>
            <strong>
              {session?.summary ?? terminal.taskLabel ?? 'Waiting for PTY output'}
            </strong>
            {previewLines.length ? (
              <div className="terminal-preview-lines">
                {previewLines.map((line, index) => (
                  <code key={`${terminal.id}-${index}`}>{line}</code>
                ))}
              </div>
            ) : (
              <span>No terminal output yet. Zoom in further to attach the live terminal.</span>
            )}
          </div>
        ) : null}

        {mode === 'focus' ? (
          <div className="canvas-node-summary">
            <p>Focus shell</p>
            {canAttachTerminal && session ? (
              <>
                <div className="terminal-focus-toolbar">
                  <strong>{session.summary}</strong>
                  {!session.connected ? (
                    <button
                      className="nodrag nopan"
                      type="button"
                      onClick={() => {
                        onRestart(terminal.id);
                      }}
                    >
                      Restart
                    </button>
                  ) : null}
                </div>
                <TerminalFocusSurface
                  sessionId={terminal.id}
                  scrollback={session.scrollback}
                  onInput={onInput}
                  onResize={onResize}
                />
              </>
            ) : (
              <>
                <strong>
                  {selected
                    ? 'Waiting for PTY session snapshot.'
                    : 'Select this node to attach xterm.'}
                </strong>
                <span>
                  Focus mode only mounts the live terminal for the selected node
                  so overview monitoring stays lightweight.
                </span>
              </>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}
