import { useEffect, useRef, useState, type RefObject } from 'react';

import type {
  AttentionIntegrationSetup,
} from '../../shared/events';
import {
  isAttentionRequiredStatus,
  shouldNotifyForAttentionEvent,
} from '../../shared/events';
import { getDefaultShell } from '../../shared/platform';
import type {
  AgentType,
  CreateTerminalNodeInput,
} from '../../shared/workspace';
import { getSemanticZoomMode } from '../../shared/workspace';
import {
  cancelViewportAnimation,
  focusMarkdownWithTransition,
  focusTerminalWithTransition,
} from '../canvas/focus';
import { WorkspaceCanvas } from '../canvas/WorkspaceCanvas';
import { fetchAttentionSetup } from '../state/attentionClient';
import { useMarkdownDocuments } from '../state/useMarkdownDocuments';
import { useTerminalSessions } from '../state/useTerminalSessions';
import { useWorkspace } from '../state/useWorkspace';
import {
  formatTerminalEventTime,
  getTerminalDisplayStatus,
} from '../terminals/presentation';

export function App() {
  const {
    workspace,
    persistence,
    updateWorkspace,
    replaceWorkspace,
    refreshWorkspaceFromServer,
    addTerminal,
    updateTerminal,
    removeTerminal,
    removeMarkdown,
    setViewport,
    applyCameraPreset,
    saveViewportToPreset,
  } = useWorkspace();
  const {
    sessions,
    markdownDocuments: remoteMarkdownDocuments,
    markdownLinks,
    attentionEvents,
    workspaceSnapshot,
    socketState,
    awaitSession,
    sendInput,
    resizeSession,
    restartSession,
    markSessionRead,
  } = useTerminalSessions();
  const [healthError, setHealthError] = useState<string | null>(null);
  const [workspaceFilePath, setWorkspaceFilePath] = useState<string | null>(null);
  const [attentionSetup, setAttentionSetup] =
    useState<AttentionIntegrationSetup | null>(null);
  const [attentionSetupError, setAttentionSetupError] = useState<string | null>(
    null,
  );
  const [browserNotificationsEnabled, setBrowserNotificationsEnabled] =
    useState(() => readStoredBoolean('tc-browser-notifications'));
  const [soundEnabled, setSoundEnabled] = useState(() =>
    readStoredBoolean('tc-sound-notifications'),
  );
  const [notificationPermission, setNotificationPermission] = useState<
    NotificationPermission | 'unsupported'
  >(() =>
    typeof window !== 'undefined' && 'Notification' in window
      ? window.Notification.permission
      : 'unsupported',
  );
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [terminalShell, setTerminalShell] = useState(getDefaultShell());
  const [terminalAgentType, setTerminalAgentType] =
    useState<AgentType>('shell');
  const [focusAutoFocusAtMs, setFocusAutoFocusAtMs] = useState<number | null>(
    null,
  );
  const [terminalInteractionAtMs, setTerminalInteractionAtMs] = useState<
    Record<string, number>
  >({});
  const [isCreateMarkdownDialogOpen, setIsCreateMarkdownDialogOpen] =
    useState(false);
  const [createMarkdownPath, setCreateMarkdownPath] = useState('./notes-1.md');
  const [createMarkdownError, setCreateMarkdownError] = useState<string | null>(
    null,
  );
  const {
    documents: markdownDocuments,
    links: activeMarkdownLinks,
    createDocument,
    openDocument,
    editDocument,
    ensureDocumentLoaded,
    saveDocument,
    resolveConflict,
    queueLinkToTerminal,
  } = useMarkdownDocuments({
    workspace,
    remoteDocuments: remoteMarkdownDocuments,
    remoteLinks: markdownLinks,
    replaceWorkspace,
  });
  const viewportAnimationFrameRef = useRef<number | null>(null);
  const didAutoFocusSingleTerminalRef = useRef(false);
  const notifiedEventIdsRef = useRef(new Set<string>());
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    return () => {
      cancelViewportAnimation(viewportAnimationFrameRef);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;

    async function loadHealthAndSetup() {
      while (!cancelled) {
        try {
          const [healthResponse, setup] = await Promise.all([
            fetch('/api/health'),
            fetchAttentionSetup(),
          ]);

          if (!healthResponse.ok) {
            throw new Error(`Health check failed with ${healthResponse.status}`);
          }

          const health = (await healthResponse.json()) as {
            workspacePath?: string;
          };

          if (!cancelled) {
            setHealthError(null);
            setWorkspaceFilePath(health.workspacePath ?? null);
            setAttentionSetup(setup);
            setAttentionSetupError(null);
          }

          return;
        } catch (error) {
          if (cancelled) {
            return;
          }

          attempt += 1;
          const message =
            error instanceof Error ? error.message : 'Unknown error';
          setHealthError(message);
          setAttentionSetupError(message);
          await waitForRetry(Math.min(2_500, 350 * attempt));
        }
      }
    }

    void loadHealthAndSetup();

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    writeStoredBoolean('tc-browser-notifications', browserNotificationsEnabled);
  }, [browserNotificationsEnabled]);

  useEffect(() => {
    writeStoredBoolean('tc-sound-notifications', soundEnabled);
  }, [soundEnabled]);

  useEffect(() => {
    if (!workspace || activePresetId) {
      return;
    }

    setActivePresetId(workspace.cameraPresets[0]?.id ?? null);
  }, [activePresetId, workspace]);

  useEffect(() => {
    if (!workspace || selectedNodeId) {
      return;
    }

    if (didAutoFocusSingleTerminalRef.current || workspace.terminals.length !== 1) {
      return;
    }

    const terminal = workspace.terminals[0];

    if (!terminal) {
      return;
    }

    didAutoFocusSingleTerminalRef.current = true;
    bumpTerminalInteraction(terminal.id);
    focusTerminalWithTransition({
      terminal,
      startViewport: workspace.currentViewport,
      updateWorkspace,
      onSelectTerminal: setSelectedNodeId,
      onAutoFocusAtChange: setFocusAutoFocusAtMs,
      onViewportChange: setViewport,
      animationFrameRef: viewportAnimationFrameRef,
    });
  }, [selectedNodeId, setViewport, updateWorkspace, workspace]);

  useEffect(() => {
    if (!workspaceSnapshot || !workspace) {
      return;
    }

    if (workspaceSnapshot.updatedAt === workspace.updatedAt) {
      return;
    }

    void refreshWorkspaceFromServer(workspaceSnapshot);
  }, [refreshWorkspaceFromServer, workspace, workspaceSnapshot]);

  useEffect(() => {
    for (const event of attentionEvents) {
      if (notifiedEventIdsRef.current.has(event.id)) {
        continue;
      }

      notifiedEventIdsRef.current.add(event.id);

      if (!shouldNotifyForAttentionEvent(event)) {
        continue;
      }

      if (
        browserNotificationsEnabled &&
        notificationPermission === 'granted' &&
        'Notification' in window
      ) {
        new Notification(event.title, {
          body: event.detail,
        });
      }

      if (soundEnabled) {
        void playNotificationTone(audioContextRef);
      }
    }
  }, [
    attentionEvents,
    browserNotificationsEnabled,
    notificationPermission,
    soundEnabled,
  ]);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }

      const target = event.target;

      if (
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT')
      ) {
        return;
      }

      if (event.key.toLowerCase() === 'j') {
        event.preventDefault();
        jumpToNextAttention();
      }
    }

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  });

  if (!workspace) {
    return (
      <div className="app-shell app-shell-loading">
        <section className="workspace-panel-loading">
          <p className="eyebrow">Workspace</p>
          <h2>Loading persisted workspace...</h2>
          <p>
            {persistence.error ??
              'Fetching the saved layout from the local server.'}
          </p>
        </section>
      </div>
    );
  }

  const terminals = workspace.terminals;
  const currentViewport = workspace.currentViewport;
  const semanticMode = getSemanticZoomMode(currentViewport.zoom);
  const attentionTerminalIds = terminals
    .filter((terminal) =>
      isAttentionRequiredStatus(
        getTerminalDisplayStatus(terminal, sessions[terminal.id] ?? null),
      ),
    )
    .map((terminal) => terminal.id);

  function focusTerminal(terminalId: string) {
    const terminal = terminals.find((candidate) => candidate.id === terminalId);

    if (!terminal) {
      return;
    }

    bumpTerminalInteraction(terminalId);
    focusTerminalWithTransition({
      terminal,
      startViewport: currentViewport,
      updateWorkspace,
      onSelectTerminal: setSelectedNodeId,
      onAutoFocusAtChange: setFocusAutoFocusAtMs,
      onViewportChange: setViewport,
      animationFrameRef: viewportAnimationFrameRef,
    });
  }

  function jumpToNextAttention() {
    if (!attentionTerminalIds.length) {
      return;
    }

    const currentIndex = selectedNodeId
      ? attentionTerminalIds.indexOf(selectedNodeId)
      : -1;
    const nextIndex =
      (currentIndex + 1 + attentionTerminalIds.length) %
      attentionTerminalIds.length;
    const nextTerminalId = attentionTerminalIds[nextIndex];

    if (nextTerminalId) {
      focusTerminal(nextTerminalId);
    }
  }

  function focusMarkdown(markdownId: string) {
    if (!workspace) {
      return;
    }

    const markdownNode = workspace.markdown.find(
      (candidate) => candidate.id === markdownId,
    );

    if (!markdownNode) {
      return;
    }

    setFocusAutoFocusAtMs(null);
    focusMarkdownWithTransition({
      markdown: markdownNode,
      startViewport: currentViewport,
      updateWorkspace,
      onSelectMarkdown: setSelectedNodeId,
      onViewportChange: setViewport,
      animationFrameRef: viewportAnimationFrameRef,
    });
  }

  function openCreateMarkdownDialog() {
    if (!workspace) {
      return;
    }

    setCreateMarkdownPath(`./notes-${workspace.markdown.length + 1}.md`);
    setCreateMarkdownError(null);
    setIsCreateMarkdownDialogOpen(true);
  }

  function closeCreateMarkdownDialog() {
    setIsCreateMarkdownDialogOpen(false);
    setCreateMarkdownError(null);
  }

  async function submitCreateMarkdownDialog() {
    const filePath = createMarkdownPath.trim();

    if (!filePath) {
      setCreateMarkdownError('Enter a Markdown path.');
      return;
    }

    try {
      const response = await createDocument({
        filePath,
      });
      closeCreateMarkdownDialog();
      focusMarkdown(response.node.id);
    } catch (error) {
      setCreateMarkdownError(
        error instanceof Error ? error.message : 'Markdown creation failed.',
      );
    }
  }

  function launchTerminal(input: CreateTerminalNodeInput) {
    const createdTerminal = addTerminal(input, { persistImmediately: true });

    if (!createdTerminal) {
      return;
    }

    bumpTerminalInteraction(createdTerminal.id);
    focusTerminalWithTransition({
      terminal: createdTerminal,
      startViewport: currentViewport,
      updateWorkspace,
      onSelectTerminal: setSelectedNodeId,
      onAutoFocusAtChange: setFocusAutoFocusAtMs,
      onViewportChange: setViewport,
      animationFrameRef: viewportAnimationFrameRef,
    });
    awaitSession(createdTerminal.id);
  }

  function handleSelectedNodeChange(nodeId: string | null) {
    if (nodeId && terminals.some((terminal) => terminal.id === nodeId)) {
      bumpTerminalInteraction(nodeId);
    }

    setSelectedNodeId(nodeId);
  }

  function handleTerminalRemove(terminalId: string) {
    setFocusAutoFocusAtMs(null);
    setSelectedNodeId((current) => (current === terminalId ? null : current));
    setTerminalInteractionAtMs((current) => {
      if (!(terminalId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[terminalId];
      return next;
    });
    removeTerminal(terminalId, { persistImmediately: true });
  }

  function handleMarkdownRemove(markdownId: string) {
    setSelectedNodeId((current) => (current === markdownId ? null : current));
    removeMarkdown(markdownId, { persistImmediately: true });
  }

  function handleTerminalInput(sessionId: string, data: string) {
    bumpTerminalInteraction(sessionId, 1_000);
    sendInput(sessionId, data);
  }

  function handleTerminalRestart(sessionId: string) {
    bumpTerminalInteraction(sessionId);
    restartSession(sessionId);
  }

  function handleMarkTerminalRead(sessionId: string) {
    bumpTerminalInteraction(sessionId);
    markSessionRead(sessionId);
  }

  function bumpTerminalInteraction(
    terminalId: string,
    throttleMs = 0,
  ) {
    const now = Date.now();

    setTerminalInteractionAtMs((current) => {
      const previous = current[terminalId] ?? Number.NEGATIVE_INFINITY;

      if (now - previous < throttleMs) {
        return current;
      }

      return {
        ...current,
        [terminalId]: now,
      };
    });
  }

  async function handleBrowserNotificationsToggle() {
    if (notificationPermission === 'unsupported' || !('Notification' in window)) {
      return;
    }

    if (!browserNotificationsEnabled) {
      const permission = await window.Notification.requestPermission();
      setNotificationPermission(permission);

      if (permission !== 'granted') {
        setBrowserNotificationsEnabled(false);
        return;
      }
    }

    setBrowserNotificationsEnabled((current) => !current);
  }

  return (
    <div className="app-shell">
      <WorkspaceCanvas
        workspace={workspace}
        selectedNodeId={selectedNodeId}
        terminalInteractionAtMs={terminalInteractionAtMs}
        sessions={sessions}
        markdownDocuments={markdownDocuments}
        markdownLinks={activeMarkdownLinks}
        socketState={socketState}
        onTerminalInput={handleTerminalInput}
        onTerminalResize={resizeSession}
        onTerminalRestart={handleTerminalRestart}
        onTerminalChange={updateTerminal}
        onTerminalRemove={handleTerminalRemove}
        onMarkTerminalRead={handleMarkTerminalRead}
        onMarkdownDrop={(markdownNodeId, terminalId) => {
          void queueLinkToTerminal(markdownNodeId, terminalId);
        }}
        onMarkdownFocusRequest={focusMarkdown}
        onMarkdownRemove={handleMarkdownRemove}
        onSelectedNodeChange={handleSelectedNodeChange}
        onTerminalFocusRequest={focusTerminal}
        onWorkspaceChange={updateWorkspace}
        onViewportChange={setViewport}
        focusAutoFocusAtMs={focusAutoFocusAtMs}
        onDocumentLoad={(nodeId) => {
          void ensureDocumentLoaded(nodeId);
        }}
        onDocumentChange={(nodeId, content) => {
          editDocument(nodeId, content);
        }}
        onDocumentSave={(nodeId) => {
          void saveDocument(nodeId);
        }}
        onResolveConflict={(nodeId, choice) => {
          void resolveConflict(nodeId, choice);
        }}
      />

      <header className="workspace-toolbar">
        <div className="workspace-toolbar-row">
          <div className="toolbar-cluster toolbar-cluster-primary">
            <button
              type="button"
              onClick={() => {
                launchTerminal({
                  label: getDefaultTerminalLabel(
                    terminalAgentType,
                    workspace.terminals.length + 1,
                  ),
                  shell: terminalShell,
                  cwd: '.',
                  agentType: terminalAgentType,
                });
              }}
            >
              Add Terminal
            </button>
            <label className="toolbar-select-field">
              <span className="meta-label">Shell</span>
              <select
                className="toolbar-select"
                value={terminalShell}
                onChange={(event) => {
                  setTerminalShell(event.target.value);
                }}
              >
                <option value={getDefaultShell()}>
                  {getDefaultShell() === 'powershell.exe'
                    ? 'PowerShell'
                    : getDefaultShell()}
                </option>
              </select>
            </label>
            <label className="toolbar-select-field">
              <span className="meta-label">Agent</span>
              <select
                className="toolbar-select"
                value={terminalAgentType}
                onChange={(event) => {
                  setTerminalAgentType(event.target.value as AgentType);
                }}
              >
                <option value="shell">Shell</option>
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            <button
              type="button"
              onClick={() => {
                openCreateMarkdownDialog();
              }}
            >
              Add Markdown
            </button>
            <button
              type="button"
              onClick={() => {
                const filePath = window.prompt('Open Markdown path');

                if (!filePath?.trim()) {
                  return;
                }

                void openDocument(filePath.trim()).then((response) => {
                  focusMarkdown(response.node.id);
                });
              }}
            >
              Open Markdown
            </button>
          </div>

          <div className="preset-strip toolbar-center-strip">
            {workspace.cameraPresets.map((preset) => (
              <button
                key={preset.id}
                type="button"
                className={
                  preset.id === activePresetId
                    ? 'preset-button is-active'
                    : 'preset-button'
                }
                onClick={() => {
                  setActivePresetId(preset.id);
                  applyCameraPreset(preset.id);
                }}
              >
                {preset.name}
              </button>
            ))}
          </div>

          <div className="toolbar-cluster toolbar-cluster-actions">
            <button
              type="button"
              onClick={jumpToNextAttention}
              disabled={!attentionTerminalIds.length}
              title="Jump to next attention node (J)"
            >
              Jump Attention
            </button>
            <button
              type="button"
              onClick={() => {
                if (!activePresetId) {
                  return;
                }

                saveViewportToPreset(activePresetId);
              }}
              disabled={!activePresetId}
            >
              Save current view
            </button>
          </div>
        </div>
      </header>

      <AttentionFeed
        attentionEvents={attentionEvents}
        attentionSetup={attentionSetup}
        attentionSetupError={attentionSetupError}
        attentionTerminalIds={attentionTerminalIds}
        browserNotificationsEnabled={browserNotificationsEnabled}
        soundEnabled={soundEnabled}
        notificationPermission={notificationPermission}
        terminals={terminals}
        onBrowserNotificationsToggle={() => {
          void handleBrowserNotificationsToggle();
        }}
        onSoundToggle={() => {
          setSoundEnabled((current) => !current);
        }}
        onEventSelect={(sessionId) => {
          focusTerminal(sessionId);
        }}
      />

      <footer className="workspace-footer">
        <span>WORKSPACE {workspace.name}</span>
        <span>ZOOM MODE {currentViewport.zoom.toFixed(2)}x</span>
        <span>PERSISTENCE {persistence.phase}</span>
        <span>SEMANTIC ZOOM {semanticMode}</span>
        <span>
          TERMINAL SOCKET {healthError ? 'backend degraded' : socketState}
        </span>
      </footer>

      {isCreateMarkdownDialogOpen ? (
        <div
          className="workspace-modal-backdrop"
          onClick={() => {
            closeCreateMarkdownDialog();
          }}
        >
          <section
            className="workspace-modal"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="workspace-modal-header">
              <div>
                <p className="eyebrow">Add Markdown</p>
                <h2>Create Markdown file</h2>
              </div>
              <button
                type="button"
                onClick={() => {
                  closeCreateMarkdownDialog();
                }}
              >
                Cancel
              </button>
            </div>

            <label className="workspace-modal-field">
              <span>File path</span>
              <input
                autoFocus
                value={createMarkdownPath}
                onChange={(event) => {
                  setCreateMarkdownPath(event.target.value);
                  setCreateMarkdownError(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitCreateMarkdownDialog();
                  }
                }}
                placeholder="./notes-1.md"
              />
            </label>

            <p className="workspace-modal-help">
              Relative paths are created inside{' '}
              <code>{getWorkspaceDirectory(workspaceFilePath)}</code>.
            </p>
            <p className="workspace-modal-help">
              Examples: <code>./notes/plan.md</code> or <code>C:\dev\repo\plan.md</code>
            </p>
            {createMarkdownError ? (
              <p className="workspace-modal-error">{createMarkdownError}</p>
            ) : null}

            <div className="workspace-modal-actions">
              <button
                type="button"
                onClick={() => {
                  void submitCreateMarkdownDialog();
                }}
              >
                Create
              </button>
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

interface AttentionFeedProps {
  attentionEvents: ReturnType<typeof useTerminalSessions>['attentionEvents'];
  attentionSetup: AttentionIntegrationSetup | null;
  attentionSetupError: string | null;
  attentionTerminalIds: string[];
  browserNotificationsEnabled: boolean;
  soundEnabled: boolean;
  notificationPermission: NotificationPermission | 'unsupported';
  terminals: NonNullable<ReturnType<typeof useWorkspace>['workspace']>['terminals'];
  onBrowserNotificationsToggle: () => void;
  onSoundToggle: () => void;
  onEventSelect: (sessionId: string) => void;
}

function AttentionFeed({
  attentionEvents,
  attentionSetup,
  attentionSetupError,
  attentionTerminalIds,
  browserNotificationsEnabled,
  soundEnabled,
  notificationPermission,
  terminals,
  onBrowserNotificationsToggle,
  onSoundToggle,
  onEventSelect,
}: AttentionFeedProps) {
  return (
    <aside className="attention-feed">
      <div className="attention-feed-header">
        <div>
          <p className="eyebrow">Attention Feed</p>
          <h2>Recent agent events</h2>
        </div>
        <div className="attention-feed-header-actions">
          <button
            type="button"
            className={
              browserNotificationsEnabled
                ? 'attention-toggle is-active'
                : 'attention-toggle'
            }
            onClick={onBrowserNotificationsToggle}
            disabled={notificationPermission === 'unsupported'}
          >
            Browser
          </button>
          <button
            type="button"
            className={
              soundEnabled ? 'attention-toggle is-active' : 'attention-toggle'
            }
            onClick={onSoundToggle}
          >
            Sound
          </button>
        </div>
      </div>

      <div className="attention-feed-meta">
        <span>
          {attentionTerminalIds.length
            ? `${attentionTerminalIds.length} terminals need action`
            : 'No terminals need action'}
        </span>
        <span>
          Browser{' '}
          {notificationPermission === 'unsupported'
            ? 'unsupported'
            : notificationPermission}
        </span>
      </div>

      <div className="attention-feed-list">
        {attentionEvents.length ? (
          attentionEvents.slice(0, 12).map((event) => {
            const terminal = terminals.find(
              (candidate) => candidate.id === event.sessionId,
            );

            return (
              <button
                key={event.id}
                type="button"
                className={`event-card is-${event.status}`}
                onClick={() => {
                  onEventSelect(event.sessionId);
                }}
              >
                <div className="event-card-topline">
                  <strong>{event.title}</strong>
                  <span>{formatTerminalEventTime(event.timestamp)}</span>
                </div>
                <p>{event.detail}</p>
                <div className="event-card-meta">
                  <span>{terminal?.label ?? event.sessionId}</span>
                  <span>{event.source}</span>
                  <span>{event.confidence}</span>
                  <span>{event.eventType}</span>
                </div>
              </button>
            );
          })
        ) : (
          <div className="event-card event-card-empty">
            <strong>No attention events yet.</strong>
            <p>
              Hook events from Claude/Codex or let PTY fallback detection pick
              up bells, OSC notifications, and waiting prompts.
            </p>
          </div>
        )}
      </div>

      <details className="attention-setup-panel">
        <summary>Setup helpers</summary>
        {attentionSetup ? (
          <div className="attention-setup-content">
            <p className="attention-setup-line">
              Receiver <code>{attentionSetup.receiverUrl}</code>
            </p>
            <p className="attention-setup-line">
              Token <code>{attentionSetup.token}</code>
            </p>
            <p className="attention-setup-line">
              Every spawned terminal gets <code>TERMINAL_CANVAS_SESSION_ID</code>,{' '}
              <code>TERMINAL_CANVAS_ATTENTION_URL</code>, and{' '}
              <code>TERMINAL_CANVAS_ATTENTION_TOKEN</code>.
            </p>
            <div className="attention-setup-snippet">
              <span>Claude hook (PowerShell)</span>
              <pre>{attentionSetup.powershell.claudeHookCommand}</pre>
            </div>
            <div className="attention-setup-snippet">
              <span>Codex notify (PowerShell)</span>
              <pre>{attentionSetup.powershell.codexNotifyCommand}</pre>
            </div>
            <div className="attention-setup-snippet">
              <span>Claude hook (bash)</span>
              <pre>{attentionSetup.bash.claudeHookCommand}</pre>
            </div>
            <div className="attention-setup-snippet">
              <span>Codex notify (bash)</span>
              <pre>{attentionSetup.bash.codexNotifyCommand}</pre>
            </div>
          </div>
        ) : (
          <div className="event-card event-card-empty">
            <strong>Setup helper unavailable.</strong>
            <p>{attentionSetupError ?? 'Waiting for local setup metadata.'}</p>
          </div>
        )}
      </details>
    </aside>
  );
}

function getDefaultTerminalLabel(
  agentType: AgentType,
  terminalNumber: number,
): string {
  if (agentType === 'claude') {
    return `Claude ${terminalNumber}`;
  }

  if (agentType === 'codex') {
    return `Codex ${terminalNumber}`;
  }

  return `Shell ${terminalNumber}`;
}

function readStoredBoolean(key: string): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  return window.localStorage.getItem(key) === 'true';
}

function writeStoredBoolean(key: string, value: boolean): void {
  if (typeof window === 'undefined') {
    return;
  }

  window.localStorage.setItem(key, String(value));
}

function waitForRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, delayMs);
  });
}

async function playNotificationTone(
  audioContextRef: RefObject<AudioContext | null>,
): Promise<void> {
  const audioContextConstructor = getAudioContextConstructor();

  if (!audioContextConstructor) {
    return;
  }

  if (!audioContextRef.current) {
    audioContextRef.current = new audioContextConstructor();
  }

  const context = audioContextRef.current;

  if (context.state === 'suspended') {
    await context.resume();
  }

  const oscillator = context.createOscillator();
  const gainNode = context.createGain();
  const startAt = context.currentTime;

  oscillator.type = 'triangle';
  oscillator.frequency.value = 784;
  gainNode.gain.setValueAtTime(0.0001, startAt);
  gainNode.gain.exponentialRampToValueAtTime(0.06, startAt + 0.01);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + 0.16);
  oscillator.connect(gainNode);
  gainNode.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + 0.18);
}

function getAudioContextConstructor():
  | (new () => AudioContext)
  | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  const extendedWindow = window as Window & {
    webkitAudioContext?: new () => AudioContext;
  };

  return window.AudioContext ?? extendedWindow.webkitAudioContext;
}

function getWorkspaceDirectory(workspacePath: string | null): string {
  if (!workspacePath) {
    return '.terminal-canvas';
  }

  return workspacePath.replace(/[\\/][^\\/]+$/, '');
}
