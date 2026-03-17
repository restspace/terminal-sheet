import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';

import type {
  AttentionIntegrationSetup,
} from '../../shared/events';
import { LOCAL_BACKEND_ID } from '../../shared/backends';
import {
  isAttentionRequiredStatus,
  shouldNotifyForAttentionEvent,
} from '../../shared/events';
import { getDefaultShell } from '../../shared/platform';
import type {
  AgentType,
  CameraViewport,
  CreateTerminalNodeInput,
  TerminalNode,
  WorkspaceLayoutMode,
} from '../../shared/workspace';
import { getSemanticZoomMode } from '../../shared/workspace';
import type { TerminalSessionSnapshot } from '../../shared/terminalSessions';
import {
  cancelViewportAnimation,
  focusMarkdownWithTransition,
  focusTerminalWithTransition,
} from '../canvas/focus';
import { WorkspaceCanvas } from '../canvas/WorkspaceCanvas';
import { buildAttentionFooterSummary } from './attentionSummary';
import { FileSystemPickerModal } from './FileSystemPickerModal';
import { fetchAttentionSetup } from '../state/attentionClient';
import { useMarkdownDocuments } from '../state/useMarkdownDocuments';
import { useTerminalSessions } from '../state/useTerminalSessions';
import { useWorkspace } from '../state/useWorkspace';
import { waitForRetry } from '../utils/retry';
import {
  formatTerminalEventTime,
  getTerminalDisplayStatus,
  getTerminalRuntimePath,
} from '../terminals/presentation';

const MAX_NOTIFIED_EVENT_IDS = 256;
const EMPTY_TERMINALS: TerminalNode[] = [];
const DEFAULT_VIEWPORT: CameraViewport = { x: 0, y: 0, zoom: 1 };

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
    setLayoutMode,
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
  const [nodeInteractionAtMs, setNodeInteractionAtMs] = useState<
    Record<string, number>
  >({});
  const [isCreateMarkdownDialogOpen, setIsCreateMarkdownDialogOpen] =
    useState(false);
  const [createMarkdownPath, setCreateMarkdownPath] = useState('./notes-1.md');
  const [createMarkdownError, setCreateMarkdownError] = useState<string | null>(
    null,
  );
  const [fileSystemPicker, setFileSystemPicker] =
    useState<FileSystemPickerState | null>(null);
  const [isAttentionFeedExpanded, setIsAttentionFeedExpanded] = useState(false);
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
  const bumpNodeInteraction = useCallback((nodeId: string, throttleMs = 0) => {
    const now = Date.now();

    setNodeInteractionAtMs((current) => {
      const previous = current[nodeId] ?? Number.NEGATIVE_INFINITY;

      if (now - previous < throttleMs) {
        return current;
      }

      return {
        ...current,
        [nodeId]: now,
      };
    });
  }, []);

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
    bumpNodeInteraction(terminal.id);

    if (workspace.layoutMode === 'focus-tiles') {
      setSelectedNodeId(terminal.id);
      setFocusAutoFocusAtMs(null);
      return;
    }

    focusTerminalWithTransition({
      terminal,
      startViewport: workspace.currentViewport,
      updateWorkspace,
      onSelectTerminal: setSelectedNodeId,
      onAutoFocusAtChange: setFocusAutoFocusAtMs,
      onViewportChange: setViewport,
      animationFrameRef: viewportAnimationFrameRef,
    });
  }, [bumpNodeInteraction, selectedNodeId, setViewport, updateWorkspace, workspace]);

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
    if (notifiedEventIdsRef.current.size > MAX_NOTIFIED_EVENT_IDS) {
      const retainedEventIds = new Set(attentionEvents.map((event) => event.id));

      for (const eventId of notifiedEventIdsRef.current) {
        if (!retainedEventIds.has(eventId)) {
          notifiedEventIdsRef.current.delete(eventId);
        }
      }
    }

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

  const terminals = workspace?.terminals ?? EMPTY_TERMINALS;
  const layoutMode = workspace?.layoutMode ?? 'free';
  const currentViewport = workspace?.currentViewport ?? DEFAULT_VIEWPORT;
  const semanticMode = getSemanticZoomMode(currentViewport.zoom);
  const attentionTerminalIds = useMemo(
    () =>
      terminals
        .filter((terminal) =>
          isAttentionRequiredStatus(
            getTerminalDisplayStatus(terminal, sessions[terminal.id] ?? null),
          ),
        )
        .map((terminal) => terminal.id),
    [sessions, terminals],
  );
  const selectedTerminal = useMemo(
    () =>
      selectedNodeId === null
        ? null
        : terminals.find((terminal) => terminal.id === selectedNodeId) ?? null,
    [selectedNodeId, terminals],
  );
  const selectedTerminalSession = selectedTerminal
    ? (sessions[selectedTerminal.id] ?? null)
    : null;
  const configuredAgentLabel = getConfiguredFooterAgent(
    selectedTerminal,
    selectedTerminalSession,
  );
  const footerRepoRoot = selectedTerminal
    ? getTerminalRuntimePath(selectedTerminal, selectedTerminalSession, 'root')
    : 'No terminal selected';
  const attentionFooterSummary = buildAttentionFooterSummary({
    attentionEvents,
    attentionTerminalCount: attentionTerminalIds.length,
    terminals,
  });

  const focusTerminal = useCallback((terminalId: string) => {
    const terminal = terminals.find((candidate) => candidate.id === terminalId);

    if (!terminal) {
      return;
    }

    bumpNodeInteraction(terminalId);

    if (layoutMode === 'focus-tiles') {
      setSelectedNodeId(terminalId);
      setFocusAutoFocusAtMs(null);
      return;
    }

    focusTerminalWithTransition({
      terminal,
      startViewport: currentViewport,
      updateWorkspace,
      onSelectTerminal: setSelectedNodeId,
      onAutoFocusAtChange: setFocusAutoFocusAtMs,
      onViewportChange: setViewport,
      animationFrameRef: viewportAnimationFrameRef,
    });
  }, [
    bumpNodeInteraction,
    currentViewport,
    layoutMode,
    setViewport,
    terminals,
    updateWorkspace,
  ]);

  const jumpToNextAttention = useCallback(() => {
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
  }, [attentionTerminalIds, focusTerminal, selectedNodeId]);

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
  }, [jumpToNextAttention]);

  const focusMarkdown = useCallback((markdownId: string) => {
    if (!workspace) {
      return;
    }

    const markdownNode = workspace.markdown.find(
      (candidate) => candidate.id === markdownId,
    );

    if (!markdownNode) {
      return;
    }

    bumpNodeInteraction(markdownId);

    if (layoutMode === 'focus-tiles') {
      setSelectedNodeId(markdownId);
      setFocusAutoFocusAtMs(null);
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
  }, [
    bumpNodeInteraction,
    currentViewport,
    layoutMode,
    setViewport,
    updateWorkspace,
    workspace,
  ]);

  function openCreateMarkdownDialog() {
    if (!workspace) {
      return;
    }

    setCreateMarkdownPath(`./notes-${workspace.markdown.length + 1}.md`);
    setCreateMarkdownError(null);
    setIsCreateMarkdownDialogOpen(true);
  }

  const openTerminalDirectoryPicker = useCallback((terminalId: string) => {
    const terminal = terminals.find((candidate) => candidate.id === terminalId);

    if (!terminal) {
      return;
    }

    const session = sessions[terminalId] ?? null;
    const initialDirectoryPath = getTerminalRuntimePath(
      terminal,
      session,
      'cwd',
    );

    setFileSystemPicker({
      mode: 'directory',
      server: terminal.backendId ?? LOCAL_BACKEND_ID,
      initialDirectoryPath,
      title: 'Select working directory',
      subtitle: terminal.label,
      confirmLabel: 'Select folder',
      terminalId,
    });
  }, [sessions, terminals]);

  function openMarkdownPicker() {
    setFileSystemPicker({
      mode: 'file',
      server: LOCAL_BACKEND_ID,
      initialDirectoryPath: '.',
      title: 'Open Markdown',
      subtitle: 'Browse project files',
      confirmLabel: 'Open',
      extensions: ['.md', '.markdown'],
    });
  }

  const confirmFileSystemPicker = useCallback(async (
    selectedPath: string,
  ): Promise<void> => {
    if (!fileSystemPicker) {
      return;
    }

    if (fileSystemPicker.mode === 'directory') {
      if (!fileSystemPicker.terminalId) {
        throw new Error('Terminal selection is missing.');
      }

      const terminal = terminals.find(
        (candidate) => candidate.id === fileSystemPicker.terminalId,
      );
      const session = sessions[fileSystemPicker.terminalId] ?? null;

      updateTerminal(fileSystemPicker.terminalId, {
        cwd: selectedPath,
      });

      if (terminal && session?.connected) {
        sendInput(
          terminal.id,
          buildCwdSwitchCommand(terminal.shell, selectedPath),
        );
      }
      return;
    }

    const response = await openDocument(selectedPath);
    focusMarkdown(response.node.id);
  }, [
    fileSystemPicker,
    focusMarkdown,
    openDocument,
    sendInput,
    sessions,
    terminals,
    updateTerminal,
  ]);

  const closeCreateMarkdownDialog = useCallback(() => {
    setIsCreateMarkdownDialogOpen(false);
    setCreateMarkdownError(null);
  }, []);

  const submitCreateMarkdownDialog = useCallback(async () => {
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
  }, [closeCreateMarkdownDialog, createDocument, createMarkdownPath, focusMarkdown]);

  function launchTerminal(input: CreateTerminalNodeInput) {
    const createdTerminal = addTerminal(input, { persistImmediately: true });

    if (!createdTerminal) {
      return;
    }

    bumpNodeInteraction(createdTerminal.id);

    if (layoutMode === 'focus-tiles') {
      setSelectedNodeId(createdTerminal.id);
      setFocusAutoFocusAtMs(null);
    } else {
      focusTerminalWithTransition({
        terminal: createdTerminal,
        startViewport: currentViewport,
        updateWorkspace,
        onSelectTerminal: setSelectedNodeId,
        onAutoFocusAtChange: setFocusAutoFocusAtMs,
        onViewportChange: setViewport,
        animationFrameRef: viewportAnimationFrameRef,
      });
    }

    awaitSession(createdTerminal.id);
  }

  const handleSelectedNodeChange = useCallback((nodeId: string | null) => {
    if (nodeId) {
      bumpNodeInteraction(nodeId);
    }

    setSelectedNodeId(nodeId);
  }, [bumpNodeInteraction]);

  const handleTerminalRemove = useCallback((terminalId: string) => {
    setFocusAutoFocusAtMs(null);
    setSelectedNodeId((current) => (current === terminalId ? null : current));
    setNodeInteractionAtMs((current) => {
      if (!(terminalId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[terminalId];
      return next;
    });
    removeTerminal(terminalId, { persistImmediately: true });
  }, [removeTerminal]);

  const handleMarkdownRemove = useCallback((markdownId: string) => {
    setSelectedNodeId((current) => (current === markdownId ? null : current));
    setNodeInteractionAtMs((current) => {
      if (!(markdownId in current)) {
        return current;
      }

      const next = { ...current };
      delete next[markdownId];
      return next;
    });
    removeMarkdown(markdownId, { persistImmediately: true });
  }, [removeMarkdown]);

  const handleTerminalInput = useCallback((sessionId: string, data: string) => {
    bumpNodeInteraction(sessionId, 1_000);
    sendInput(sessionId, data);
  }, [bumpNodeInteraction, sendInput]);

  const handleTerminalRestart = useCallback((sessionId: string) => {
    bumpNodeInteraction(sessionId);
    restartSession(sessionId);
  }, [bumpNodeInteraction, restartSession]);

  const handleMarkTerminalRead = useCallback((sessionId: string) => {
    bumpNodeInteraction(sessionId);
    markSessionRead(sessionId);
  }, [bumpNodeInteraction, markSessionRead]);

  const handleLayoutModeChange = useCallback((nextLayoutMode: WorkspaceLayoutMode): void => {
    setFocusAutoFocusAtMs(null);
    setLayoutMode(nextLayoutMode);
  }, [setLayoutMode]);

  const handleBrowserNotificationsToggle = useCallback(async () => {
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
  }, [browserNotificationsEnabled, notificationPermission]);
  const handleMarkdownDrop = useCallback((markdownNodeId: string, terminalId: string) => {
    void queueLinkToTerminal(markdownNodeId, terminalId);
  }, [queueLinkToTerminal]);
  const handleDocumentLoad = useCallback((nodeId: string) => {
    void ensureDocumentLoaded(nodeId);
  }, [ensureDocumentLoaded]);
  const handleDocumentChange = useCallback((nodeId: string, content: string) => {
    editDocument(nodeId, content);
  }, [editDocument]);
  const handleDocumentSave = useCallback((nodeId: string) => {
    void saveDocument(nodeId);
  }, [saveDocument]);
  const handleResolveConflict = useCallback((
    nodeId: string,
    choice: 'reload-disk' | 'overwrite-disk' | 'keep-buffer',
  ) => {
    void resolveConflict(nodeId, choice);
  }, [resolveConflict]);
  const handleBrowserNotificationsToggleClick = useCallback(() => {
    void handleBrowserNotificationsToggle();
  }, [handleBrowserNotificationsToggle]);
  const handleSoundToggle = useCallback(() => {
    setSoundEnabled((current) => !current);
  }, []);

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

  return (
    <div className="app-shell">
      <WorkspaceCanvas
        workspace={workspace}
        selectedNodeId={selectedNodeId}
        nodeInteractionAtMs={nodeInteractionAtMs}
        sessions={sessions}
        markdownDocuments={markdownDocuments}
        markdownLinks={activeMarkdownLinks}
        socketState={socketState}
        onTerminalInput={handleTerminalInput}
        onTerminalResize={resizeSession}
        onTerminalRestart={handleTerminalRestart}
        onTerminalChange={updateTerminal}
        onPathSelectRequest={openTerminalDirectoryPicker}
        onTerminalRemove={handleTerminalRemove}
        onMarkTerminalRead={handleMarkTerminalRead}
        onMarkdownDrop={handleMarkdownDrop}
        onMarkdownFocusRequest={focusMarkdown}
        onMarkdownRemove={handleMarkdownRemove}
        onSelectedNodeChange={handleSelectedNodeChange}
        onTerminalFocusRequest={focusTerminal}
        onWorkspaceChange={updateWorkspace}
        onViewportChange={setViewport}
        focusAutoFocusAtMs={focusAutoFocusAtMs}
        onDocumentLoad={handleDocumentLoad}
        onDocumentChange={handleDocumentChange}
        onDocumentSave={handleDocumentSave}
        onResolveConflict={handleResolveConflict}
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
            <label className="toolbar-select-field">
              <span className="meta-label">Layout</span>
              <select
                className="toolbar-select"
                value={layoutMode}
                onChange={(event) => {
                  handleLayoutModeChange(
                    event.target.value as WorkspaceLayoutMode,
                  );
                }}
              >
                <option value="free">Free</option>
                <option value="focus-tiles">Focus Tiles</option>
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
                openMarkdownPicker();
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

      {isAttentionFeedExpanded ? (
        <AttentionFeed
          asideId="attention-feed-panel"
          attentionEvents={attentionEvents}
          attentionSetup={attentionSetup}
          attentionSetupError={attentionSetupError}
          attentionTerminalIds={attentionTerminalIds}
          browserNotificationsEnabled={browserNotificationsEnabled}
          soundEnabled={soundEnabled}
          notificationPermission={notificationPermission}
          terminals={terminals}
          onBrowserNotificationsToggle={handleBrowserNotificationsToggleClick}
          onSoundToggle={handleSoundToggle}
          onEventSelect={(sessionId) => {
            focusTerminal(sessionId);
          }}
        />
      ) : null}

      <footer className="workspace-footer">
        <span>WORKSPACE {workspace.name}</span>
        {configuredAgentLabel ? <span>{configuredAgentLabel}</span> : null}
        <span className="workspace-footer-repo-root" title={footerRepoRoot}>
          REPO ROOT {footerRepoRoot}
        </span>
        <span>ZOOM MODE {currentViewport.zoom.toFixed(2)}x</span>
        <span>PERSISTENCE {persistence.phase}</span>
        <span>SEMANTIC ZOOM {semanticMode}</span>
        <span>
          TERMINAL SOCKET {healthError ? 'backend degraded' : socketState}
        </span>
        <button
          type="button"
          className={
            isAttentionFeedExpanded
              ? 'workspace-footer-attention is-expanded'
              : 'workspace-footer-attention'
          }
          aria-controls="attention-feed-panel"
          aria-expanded={isAttentionFeedExpanded}
          onClick={() => {
            setIsAttentionFeedExpanded((current) => !current);
          }}
          title={attentionFooterSummary}
        >
          <span className="workspace-footer-attention-arrow" aria-hidden="true">
            {'>'}
          </span>
          <span className="workspace-footer-attention-label">Attention</span>
          <span className="workspace-footer-attention-summary">
            {attentionFooterSummary}
          </span>
        </button>
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

      {fileSystemPicker ? (
        <FileSystemPickerModal
          title={fileSystemPicker.title}
          subtitle={fileSystemPicker.subtitle}
          server={fileSystemPicker.server}
          mode={fileSystemPicker.mode}
          initialDirectoryPath={fileSystemPicker.initialDirectoryPath}
          extensions={fileSystemPicker.extensions}
          confirmLabel={fileSystemPicker.confirmLabel}
          onConfirm={confirmFileSystemPicker}
          onClose={() => {
            setFileSystemPicker(null);
          }}
        />
      ) : null}
    </div>
  );
}

interface FileSystemPickerState {
  mode: 'directory' | 'file';
  server: string;
  initialDirectoryPath?: string;
  title: string;
  subtitle?: string;
  confirmLabel: string;
  terminalId?: string;
  extensions?: string[];
}

interface AttentionFeedProps {
  asideId: string;
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
  asideId,
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
    <aside id={asideId} className="attention-feed">
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

function getConfiguredFooterAgent(
  terminal: TerminalNode | null,
  session: TerminalSessionSnapshot | null,
): 'CODEX' | 'CLAUDE' | null {
  if (!terminal || !session || session.integration.status !== 'configured') {
    return null;
  }

  const owner = session.integration.owner ?? terminal.agentType;

  if (owner === 'codex') {
    return 'CODEX';
  }

  if (owner === 'claude') {
    return 'CLAUDE';
  }

  return null;
}

function buildCwdSwitchCommand(shell: string, directoryPath: string): string {
  const lowerShell = shell.toLowerCase();

  if (lowerShell.includes('powershell')) {
    return `Set-Location -LiteralPath '${escapePowerShellLiteral(directoryPath)}'\r`;
  }

  if (lowerShell.includes('cmd')) {
    return `cd /d "${escapeCmdQuoted(directoryPath)}"\r`;
  }

  return `cd -- '${escapePosixSingleQuoted(directoryPath)}'\n`;
}

function escapePowerShellLiteral(input: string): string {
  return input.replaceAll("'", "''");
}

function escapeCmdQuoted(input: string): string {
  return input.replaceAll('"', '""');
}

function escapePosixSingleQuoted(input: string): string {
  return input.replaceAll("'", "'\"'\"'");
}
