import React, { memo, useEffect, useRef } from 'react';

import { type NodeProps } from '@xyflow/react';

import { CanvasResizeHandles } from '../canvas/CanvasResizeHandles';
import { shouldAutoMarkRead } from './autoMarkRead';
import {
  formatTerminalEventTime,
  getTerminalDisplayStatus,
  getTerminalIntegrationBadgeLabel,
  getTerminalIntegrationDisplayStatus,
  getTerminalIntegrationMessage,
  getTerminalLastEventAt,
  getTerminalLastMeaningfulLine,
  getTerminalRuntimePath,
  hasAttentionState,
} from './presentation';
import { TerminalSurface } from './TerminalFocusSurface';
import { TerminalTitleBar } from './TerminalTitleBar';
import type { TerminalFlowNode } from './types';

function TerminalPlaceholderNodeComponent(props: NodeProps<TerminalFlowNode>) {
  const { data, selected } = props;
  const surfaceModel = data.surfaceModel;
  const mode = surfaceModel.presentationMode;
  const terminal = data.terminal;
  const session = data.session;
  const {
    onBoundsChange,
    onInput,
    onResize,
    onRestart,
    onMarkRead,
    onTerminalChange,
    onRemove,
  } = data;
  const surfaceKind = surfaceModel.surfaceKind;
  const showsLiveTerminal = surfaceKind !== 'summary' && session !== null;
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
  const integrationBadgeLabel = getTerminalIntegrationBadgeLabel(
    terminal,
    session,
  );
  const integrationMessage = getTerminalIntegrationMessage(terminal, session);
  const liveCwd = getTerminalRuntimePath(terminal, session, 'cwd');
  const projectRoot = getTerminalRuntimePath(terminal, session, 'root');
  const integrationStatus = getTerminalIntegrationDisplayStatus(
    terminal,
    session,
  );
  const hideRedundantMetadata = selected && mode !== 'overview';
  const hideReadOnlyStatusRows = showsLiveTerminal;
  const previewScrollResetKey = `${mode}:${selected}`;
  const lastAutoMarkedUnreadCountRef = useRef<number>(0);
  const markdownLink = data.activeMarkdownLink;
  const markdownLinkLabel = markdownLink
    ? markdownLink.phase === 'active'
      ? 'Markdown linked'
      : 'Markdown queued'
    : null;

  useEffect(() => {
    const unreadCount = session?.unreadCount ?? 0;

    if (!selected || mode === 'overview' || unreadCount <= 0) {
      lastAutoMarkedUnreadCountRef.current = 0;
      return;
    }

    if (lastAutoMarkedUnreadCountRef.current === unreadCount) {
      return;
    }

    lastAutoMarkedUnreadCountRef.current = unreadCount;
    if (shouldAutoMarkRead(selected, mode, unreadCount)) {
      onMarkRead(terminal.id);
    }
  }, [mode, onMarkRead, selected, session?.unreadCount, terminal.id]);

  const backendAccent = data.backendAccent ?? null;
  const nodeStyle = backendAccent
    ? ({ '--machine-accent': backendAccent.color } as React.CSSProperties)
    : undefined;

  const nodeClassName = [
    'canvas-node',
    'terminal-node',
    selected ? 'is-selected' : '',
    mode === 'focus' ? 'is-focus-mode' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={nodeClassName}
      style={nodeStyle}
      onDragOver={(event) => {
        if (readMarkdownDragNodeId(event)) {
          event.preventDefault();
        }
      }}
      onDrop={(event) => {
        const markdownNodeId = readMarkdownDragNodeId(event);

        if (!markdownNodeId) {
          return;
        }

        event.preventDefault();
        data.onMarkdownDrop(markdownNodeId, terminal.id);
      }}
    >
      <span
        className={`terminal-node-stripe is-${status}`}
        aria-hidden="true"
        style={backendAccent ? { borderColor: backendAccent.color } : undefined}
      />

      <CanvasResizeHandles
        bounds={terminal.bounds}
        isVisible={selected && data.allowResize}
        minWidth={260}
        minHeight={180}
        zoom={data.resizeZoom}
        onBoundsChange={(bounds) => {
          onBoundsChange(terminal.id, bounds);
        }}
      />

      <div className="canvas-node-content">
        <TerminalTitleBar
          className="node-drag-handle canvas-node-header terminal-window-header"
          terminal={terminal}
          status={status}
          currentPath={liveCwd}
          backendAccent={backendAccent}
          onPathSelectRequest={data.onPathSelectRequest}
          onTerminalChange={onTerminalChange}
          onClose={onRemove}
          sidecar={
            mode === 'focus' && !session?.connected ? (
              <button
                className="nodrag nopan"
                type="button"
                onClick={() => {
                  onRestart(terminal.id);
                }}
              >
                Restart
              </button>
            ) : null
          }
        />

        {!hideRedundantMetadata && !hideReadOnlyStatusRows ? (
          <>
            <div className="canvas-node-meta">
              <span>{terminal.agentType}</span>
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
              {markdownLinkLabel ? (
                <span className="terminal-pill is-linked">{markdownLinkLabel}</span>
              ) : null}
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

            <div className="terminal-runtime-context">
              <div className="terminal-runtime-topline">
                <span
                  className={`terminal-pill terminal-pill-integration is-${integrationStatus}`}
                >
                  {integrationBadgeLabel}
                </span>
                {session?.integration.updatedAt ? (
                  <span>
                    {formatTerminalEventTime(session.integration.updatedAt)}
                  </span>
                ) : null}
              </div>
              <strong title={integrationMessage}>{integrationMessage}</strong>
              <div className="terminal-runtime-paths">
                <span title={liveCwd}>cwd {liveCwd}</span>
                <span title={projectRoot}>root {projectRoot}</span>
              </div>
            </div>
          </>
        ) : null}

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
                {markdownLinkLabel ? (
                  <span className="terminal-pill is-linked">{markdownLinkLabel}</span>
                ) : null}
                <span className="terminal-pill">{unreadLabel}</span>
              </div>
            </div>
            <span className="terminal-overview-line">{activitySummary}</span>
            <div className="terminal-runtime-context is-compact">
              <div className="terminal-runtime-topline">
                <span
                  className={`terminal-pill terminal-pill-integration is-${integrationStatus}`}
                >
                  {integrationBadgeLabel}
                </span>
              </div>
              <strong title={integrationMessage}>{integrationMessage}</strong>
            </div>
            <div className="terminal-overview-footer">
              <span>{repoLabel}</span>
              <span>{terminal.taskLabel ?? 'No task label yet'}</span>
              <span title={liveCwd}>cwd {liveCwd}</span>
              <span title={projectRoot}>root {projectRoot}</span>
              <span>{lastEventTime}</span>
            </div>
          </div>
        ) : null}

        {mode !== 'overview' ? (
          showsLiveTerminal && session ? (
            <div className="canvas-node-summary terminal-live-preview-card">
              {mode === 'inspect' && !session.connected ? (
                <div className="terminal-preview-actions">
                  <button
                    className="nodrag nopan"
                    type="button"
                    onClick={() => {
                      onRestart(terminal.id);
                    }}
                  >
                    Restart
                  </button>
                </div>
              ) : null}
              <TerminalSurface
                className={
                  mode === 'focus'
                    ? 'terminal-context-surface terminal-focus-surface'
                    : 'terminal-context-surface'
                }
                sessionId={terminal.id}
                scrollback={session.scrollback}
                interactionMode={surfaceModel.interactionMode}
                sizeSource={surfaceModel.sizeSource}
                resizeAuthority={surfaceModel.resizeAuthority}
                snapshotCols={session.cols}
                scrollResetKey={previewScrollResetKey}
                autoFocusAtMs={surfaceKind === 'interactive' ? data.autoFocusAtMs : null}
                onInput={onInput}
                onResize={onResize}
              />
            </div>
          ) : (
            <div className="canvas-node-summary">
              {mode === 'focus' ? (
                <>
                  <strong>Launching terminal session.</strong>
                  <span>
                    The live terminal surface will attach here as soon as the
                    backend publishes the first session snapshot.
                  </span>
                </>
              ) : (
                <>
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
                      No terminal output yet. The live preview will appear here
                      as soon as the backend publishes session output.
                    </span>
                  )}
                </>
              )}
            </div>
          )
        ) : null}
      </div>
    </div>
  );
}

export const TerminalPlaceholderNode = memo(
  TerminalPlaceholderNodeComponent,
  areTerminalNodePropsEqual,
);
TerminalPlaceholderNode.displayName = 'TerminalPlaceholderNode';

function readMarkdownDragNodeId(event: Pick<DragEvent, 'dataTransfer'>): string | null {
  const payload = event.dataTransfer?.getData('application/x-terminal-canvas-markdown');

  return payload?.trim() || null;
}

function areTerminalNodePropsEqual(
  previous: NodeProps<TerminalFlowNode>,
  next: NodeProps<TerminalFlowNode>,
): boolean {
  const previousData = previous.data;
  const nextData = next.data;

  return (
    previous.selected === next.selected &&
    previous.dragging === next.dragging &&
    previous.width === next.width &&
    previous.height === next.height &&
    previousData.terminal === nextData.terminal &&
    previousData.session === nextData.session &&
    previousData.backendAccent === nextData.backendAccent &&
    previousData.surfaceModel === nextData.surfaceModel &&
    previousData.autoFocusAtMs === nextData.autoFocusAtMs &&
    previousData.socketState === nextData.socketState &&
    previousData.activeMarkdownLink === nextData.activeMarkdownLink &&
    previousData.allowResize === nextData.allowResize &&
    previousData.resizeZoom === nextData.resizeZoom &&
    previousData.onBoundsChange === nextData.onBoundsChange &&
    previousData.onTerminalChange === nextData.onTerminalChange &&
    previousData.onPathSelectRequest === nextData.onPathSelectRequest &&
    previousData.onRemove === nextData.onRemove &&
    previousData.onInput === nextData.onInput &&
    previousData.onResize === nextData.onResize &&
    previousData.onRestart === nextData.onRestart &&
    previousData.onMarkRead === nextData.onMarkRead &&
    previousData.onMarkdownDrop === nextData.onMarkdownDrop
  );
}
