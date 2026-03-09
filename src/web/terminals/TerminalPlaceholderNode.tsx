import { useEffect } from 'react';

import { type NodeProps, useViewport } from '@xyflow/react';

import { getSemanticZoomMode } from '../../shared/workspace';
import { CanvasResizeHandles } from '../canvas/CanvasResizeHandles';
import {
  formatTerminalEventTime,
  getTerminalDisplayStatus,
  getTerminalLastEventAt,
  getTerminalLastMeaningfulLine,
  hasAttentionState,
} from './presentation';
import { TerminalSurface } from './TerminalFocusSurface';
import type { TerminalFlowNode } from './types';

export function TerminalPlaceholderNode(props: NodeProps<TerminalFlowNode>) {
  const { data, selected } = props;
  const { zoom } = useViewport();
  const mode = getSemanticZoomMode(zoom);
  const terminal = data.terminal;
  const session = data.session;
  const { onBoundsChange, onRestart, onMarkRead } = data;
  const canAttachTerminal = mode === 'focus' && selected && data.isInteractive;
  const canMountLivePreview =
    data.mountLivePreview && session !== null && mode !== 'overview';
  const previewLines = session?.previewLines ?? [];
  const status = getTerminalDisplayStatus(terminal, session);
  const unreadCount = session?.unreadCount ?? 0;
  const unreadLabel = unreadCount ? `${unreadCount} unread` : 'All read';
  const lastMeaningfulLine = getTerminalLastMeaningfulLine(terminal, session);
  const lastEventTime = formatTerminalEventTime(
    getTerminalLastEventAt(session),
  );
  const activitySummary =
    session?.summary ?? terminal.taskLabel ?? 'Waiting for session launch';
  const repoLabel = terminal.repoLabel ?? 'No repo label yet';
  const hasAttention = hasAttentionState(status);

  useEffect(() => {
    if (selected && mode !== 'overview' && session?.unreadCount) {
      onMarkRead(terminal.id);
    }
  }, [mode, onMarkRead, selected, session?.unreadCount, terminal.id]);

  return (
    <div
      className={
        selected
          ? 'canvas-node terminal-node is-selected'
          : 'canvas-node terminal-node'
      }
    >
      <span
        className={`terminal-node-stripe is-${status}`}
        aria-hidden="true"
      />

      <CanvasResizeHandles
        bounds={terminal.bounds}
        isVisible={selected}
        minWidth={260}
        minHeight={180}
        zoom={zoom}
        onBoundsChange={(bounds) => {
          onBoundsChange(terminal.id, bounds);
        }}
      />

      <div className="canvas-node-content">
        <div className="node-drag-handle canvas-node-header">
          <div>
            <p className="canvas-node-kicker">Terminal node</p>
            <strong>{terminal.label}</strong>
          </div>
          <div className="terminal-header-sidecar">
            {hasAttention ? (
              <span className="terminal-pill is-attention">
                Needs attention
              </span>
            ) : null}
            {unreadCount ? (
              <span className="terminal-pill is-unread">
                {unreadCount} unread
              </span>
            ) : null}
            <span className={`canvas-node-status is-${status}`}>{status}</span>
          </div>
        </div>

        <div className="canvas-node-meta">
          <span>{terminal.agentType}</span>
          <span>{terminal.shell}</span>
          <span>{terminal.cwd}</span>
          <span>
            {session?.connected
              ? 'live'
              : (session?.recoveryState ?? 'pending')}
          </span>
        </div>

        <div className="terminal-node-insights">
          <span title={lastMeaningfulLine}>{lastMeaningfulLine}</span>
          <span>{lastEventTime}</span>
          <span>{unreadLabel}</span>
        </div>

        {mode === 'overview' ? (
          <div className="canvas-node-summary terminal-overview-card">
            <div className="terminal-overview-topline">
              <div className="terminal-overview-copy">
                <p>Overview card</p>
                <strong title={lastMeaningfulLine}>{lastMeaningfulLine}</strong>
              </div>
              <div className="terminal-overview-badges">
                <span className={`terminal-pill is-${terminal.agentType}`}>
                  {terminal.agentType}
                </span>
                {hasAttention ? (
                  <span className="terminal-pill is-attention">
                    Action needed
                  </span>
                ) : null}
                <span className="terminal-pill">{unreadLabel}</span>
              </div>
            </div>
            <span className="terminal-overview-line">{activitySummary}</span>
            <div className="terminal-overview-footer">
              <span>{repoLabel}</span>
              <span>{terminal.taskLabel ?? 'No task label yet'}</span>
              <span>{lastEventTime}</span>
            </div>
          </div>
        ) : null}

        {mode === 'inspect' ? (
          canMountLivePreview ? (
            <div className="canvas-node-summary terminal-live-preview-card">
              <div className="terminal-focus-toolbar">
                <div className="terminal-focus-title">
                  <span className="terminal-focus-label">Inspect preview</span>
                  <strong title={session.summary}>{session.summary}</strong>
                </div>
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
              <TerminalSurface
                className="terminal-preview-surface"
                readOnly
                sessionId={terminal.id}
                scrollback={session.scrollback}
              />
              <span>
                {selected
                  ? 'Live read-only preview. Press F or zoom further to claim read/write control.'
                  : 'Live read-only preview. Double-click to focus this terminal for input.'}
              </span>
            </div>
          ) : (
            <div className="canvas-node-summary">
              <p>Inspect preview</p>
              <strong>
                {session?.summary ??
                  terminal.taskLabel ??
                  'Waiting for PTY output'}
              </strong>
              {previewLines.length ? (
                <div className="terminal-preview-lines">
                  {previewLines.map((line, index) => (
                    <code key={`${terminal.id}-${index}`}>{line}</code>
                  ))}
                </div>
              ) : (
                <span>
                  No terminal output yet. Zoom in further to attach the live
                  terminal.
                </span>
              )}
            </div>
          )
        ) : null}

        {mode === 'focus' ? (
          canAttachTerminal ? (
            <div className="canvas-node-summary">
              <div className="terminal-focus-toolbar">
                <div className="terminal-focus-title">
                  <span className="terminal-focus-label">Focus shell</span>
                  {session ? (
                    <strong title={session.summary}>{session.summary}</strong>
                  ) : null}
                </div>
                {!session?.connected ? (
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
              <strong>
                {session
                  ? 'Live terminal attached in focus overlay.'
                  : 'Waiting for PTY session snapshot.'}
              </strong>
              <span>
                Focus mode mounts the read/write terminal in a dedicated overlay
                above the canvas while neighboring terminals stay read-only.
              </span>
            </div>
          ) : canMountLivePreview ? (
            <div className="canvas-node-summary terminal-live-preview-card">
              <div className="terminal-focus-toolbar">
                <div className="terminal-focus-title">
                  <span className="terminal-focus-label">Context shell</span>
                  <strong title={session.summary}>{session.summary}</strong>
                </div>
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
              <TerminalSurface
                className="terminal-preview-surface"
                readOnly
                sessionId={terminal.id}
                scrollback={session.scrollback}
              />
              <span>
                Live read-only preview. Select and focus this terminal to move
                it into read/write mode.
              </span>
            </div>
          ) : (
            <div className="canvas-node-summary">
              <div className="terminal-focus-toolbar">
                <div className="terminal-focus-title">
                  <span className="terminal-focus-label">Focus shell</span>
                  {session ? (
                    <strong title={session.summary}>{session.summary}</strong>
                  ) : null}
                </div>
              </div>
              <strong>
                {selected
                  ? 'Waiting for PTY session snapshot.'
                  : 'Select this node to focus it.'}
              </strong>
              <span>
                Terminals outside the live preview budget fall back to summaries
                until they are selected or moved closer to the focused context.
              </span>
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}
