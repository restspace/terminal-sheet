import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type {
  AttentionIntegrationSetup,
} from '../../shared/events';
import { LOCAL_BACKEND_ID } from '../../shared/backends';
import type { ServerRole } from '../../shared/backends';
import { BackendManagerPanel } from '../backends/BackendManagerPanel';
import {
  isAttentionRequiredStatus,
} from '../../shared/events';
import { getDefaultShell } from '../../shared/platform';
import { buildCwdSwitchCommand, getShellPresets } from '../../shared/shells';
import type {
  AgentType,
  CameraViewport,
  CreateTerminalNodeInput,
  TerminalNode,
  Workspace,
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
import { useCanvasUiState } from '../canvas/useCanvasUiState';
import { buildAttentionFooterSummary } from './attentionSummary';
import { FileSystemPickerModal } from './FileSystemPickerModal';
import { fetchAttentionSetup } from '../state/attentionClient';
import { useAttentionNotifications } from '../state/useAttentionNotifications';
import { fetchWithFrontendLease } from '../state/frontendLeaseClient';
import { useFrontendLease } from '../state/useFrontendLease';
import { useMarkdownDocuments } from '../state/useMarkdownDocuments';
import { useTerminalSessions } from '../state/useTerminalSessions';
import { useWorkspace } from '../state/useWorkspace';
import {
  logStateDebug,
  summarizeWorkspaceForDebug,
} from '../debug/stateDebug';
import { waitForRetry } from '../utils/retry';
import {
  formatTerminalEventTime,
  getTerminalDisplayStatus,
  getTerminalRuntimePath,
} from '../terminals/presentation';

const EMPTY_TERMINALS: TerminalNode[] = [];
const DEFAULT_VIEWPORT: CameraViewport = { x: 0, y: 0, zoom: 1 };
const EMPTY_CANVAS_VIEWPORT_SIZE = { width: 0, height: 0 };
const BACKEND_SHELLS_STORAGE_KEY = 'tc-backend-shells';
const USER_TIMING_CLEAR_INTERVAL_MS = 5_000;

export function App() {
  const frontendLease = useFrontendLease();

  if (frontendLease.phase === 'locked') {
    return (
      <div className="app-shell app-shell-loading">
        <section className="workspace-panel-loading">
          <p className="eyebrow">Browser ownership</p>
          <h2>Another browser is controlling this workspace</h2>
          <p>{frontendLease.lock?.message ?? 'Waiting for the active browser lease.'}</p>
          {frontendLease.lock?.owner ? (
            <div className="workspace-panel-meta">
              <span>
                Owner <code>{frontendLease.lock.owner.ownerLabel}</code>
              </span>
              <span>
                Frontend <code>{frontendLease.lock.owner.frontendId}</code>
              </span>
              <span>
                Expires around <code>{formatLeaseExpiry(frontendLease.lock.owner.expiresAt)}</code>
              </span>
            </div>
          ) : null}
          {frontendLease.error ? (
            <p className="workspace-modal-error">{frontendLease.error}</p>
          ) : null}
          <div className="workspace-panel-actions">
            <button
              type="button"
              onClick={() => {
                void frontendLease.retryAcquire();
              }}
            >
              Retry
            </button>
            {frontendLease.lock?.canTakeOver ? (
              <button
                type="button"
                onClick={() => {
                  void frontendLease.takeOverLease();
                }}
              >
                Take over
              </button>
            ) : null}
          </div>
        </section>
      </div>
    );
  }

  if (frontendLease.phase === 'error') {
    return (
      <div className="app-shell app-shell-loading">
        <section className="workspace-panel-loading">
          <p className="eyebrow">Browser ownership</p>
          <h2>Failed to acquire the browser lease</h2>
          <p>{frontendLease.error ?? 'The frontend could not claim workspace control.'}</p>
          <div className="workspace-panel-actions">
            <button
              type="button"
              onClick={() => {
                void frontendLease.retryAcquire();
              }}
            >
              Retry
            </button>
          </div>
        </section>
      </div>
    );
  }

  if (frontendLease.phase !== 'active') {
    return (
      <div className="app-shell app-shell-loading">
        <section className="workspace-panel-loading">
          <p className="eyebrow">Browser ownership</p>
          <h2>Acquiring workspace control...</h2>
          <p>
            Claiming the active browser lease before loading sessions, workspace
            state, and terminal control.
          </p>
        </section>
      </div>
    );
  }

  return <ActiveApp />;
}

function ActiveApp() {
  const {
    workspace,
    persistence,
    replaceWorkspace,
    refreshWorkspaceFromServer,
    addTerminal,
    updateTerminal,
    removeTerminal,
    removeMarkdown,
    setViewport,
    setNodeBounds,
    saveViewportToPreset,
    setLayoutMode,
  } = useWorkspace();
  const {
    sessions,
    markdownDocuments: remoteMarkdownDocuments,
    markdownLinks,
    attentionEvents,
    socketState,
    awaitSession,
    sendInput,
    resizeSession,
    restartSession,
    markSessionRead,
  } = useTerminalSessions({
    workspace,
    refreshWorkspaceFromServer,
  });
  const [healthError, setHealthError] = useState<string | null>(null);
  const [workspaceFilePath, setWorkspaceFilePath] = useState<string | null>(null);
  const [serverRole, setServerRole] = useState<ServerRole | null>(null);
  const [isBackendsPanelOpen, setIsBackendsPanelOpen] = useState(false);
  const [attentionSetup, setAttentionSetup] =
    useState<AttentionIntegrationSetup | null>(null);
  const [attentionSetupError, setAttentionSetupError] = useState<string | null>(
    null,
  );
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [terminalShell, setTerminalShell] = useState(getDefaultShell());
  const [backendShellById, setBackendShellById] =
    useState<Record<string, string>>(readStoredBackendShellById);
  const [terminalAgentType, setTerminalAgentType] =
    useState<AgentType>('shell');
  const [terminalBackendId, setTerminalBackendId] =
    useState<string>(LOCAL_BACKEND_ID);
  const [terminalCreateError, setTerminalCreateError] = useState<string | null>(
    null,
  );
  const [isCreateMarkdownDialogOpen, setIsCreateMarkdownDialogOpen] =
    useState(false);
  const [createMarkdownPath, setCreateMarkdownPath] = useState('./notes-1.md');
  const [createMarkdownError, setCreateMarkdownError] = useState<string | null>(
    null,
  );
  const [terminalResizeSyncError, setTerminalResizeSyncError] =
    useState<TerminalResizeSyncError | null>(null);
  const [fileSystemPicker, setFileSystemPicker] =
    useState<FileSystemPickerState | null>(null);
  const [isAttentionFeedExpanded, setIsAttentionFeedExpanded] = useState(false);
  const [canvasViewportSize, setCanvasViewportSize] = useState(
    EMPTY_CANVAS_VIEWPORT_SIZE,
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
  const {
    selectedNodeId,
    setSelectedNodeId,
    focusAutoFocusAtMs,
    setFocusAutoFocusAtMs,
    nodeInteractionAtMs,
    bumpNodeInteraction,
    clearNodeInteraction,
    isSelectionHydrated,
  } = useCanvasUiState(workspace);
  const {
    browserNotificationsEnabled,
    soundEnabled,
    notificationPermission,
    toggleBrowserNotifications,
    toggleSound,
  } = useAttentionNotifications(attentionEvents);
  const viewportAnimationFrameRef = useRef<number | null>(null);
  const didAutoFocusSingleTerminalRef = useRef(false);
  const previousSelectedNodeIdRef = useRef<string | null>(null);
  const previousWorkspaceLayoutModeRef = useRef<WorkspaceLayoutMode | null>(null);
  const handleCanvasViewportChange = useCallback((viewport: CameraViewport) => {
    setViewport(viewport, {
      debugSource: 'canvas.viewportCommit',
    });
  }, [setViewport]);
  const handleSingleTerminalAutoFocusViewportChange = useCallback((
    viewport: CameraViewport,
  ) => {
    setViewport(viewport, {
      debugSource: 'focus.singleTerminalAutoFocus',
    });
  }, [setViewport]);
  const handleTerminalFocusViewportChange = useCallback((viewport: CameraViewport) => {
    setViewport(viewport, {
      debugSource: 'focus.terminal',
    });
  }, [setViewport]);
  const handleMarkdownFocusViewportChange = useCallback((viewport: CameraViewport) => {
    setViewport(viewport, {
      debugSource: 'focus.markdown',
    });
  }, [setViewport]);
  const handleNewTerminalFocusViewportChange = useCallback((viewport: CameraViewport) => {
    setViewport(viewport, {
      debugSource: 'focus.newTerminal',
    });
  }, [setViewport]);
  const handleCanvasViewportSizeChange = useCallback((
    size: { width: number; height: number },
  ) => {
    setCanvasViewportSize((current) =>
      current.width === size.width && current.height === size.height
        ? current
        : size,
    );
  }, []);

  useEffect(() => {
    return () => {
      cancelViewportAnimation(viewportAnimationFrameRef);
    };
  }, []);

  useEffect(() => {
    if (typeof performance === 'undefined') {
      return;
    }

    const clearUserTimingEntries = () => {
      performance.clearMarks();
      performance.clearMeasures();
    };

    clearUserTimingEntries();
    const intervalId = window.setInterval(
      clearUserTimingEntries,
      USER_TIMING_CLEAR_INTERVAL_MS,
    );

    return () => {
      window.clearInterval(intervalId);
      clearUserTimingEntries();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;

    async function loadHealthAndSetup() {
      while (!cancelled) {
        try {
          const [healthResponse, setup] = await Promise.all([
            fetchWithFrontendLease('/api/health'),
            fetchAttentionSetup(),
          ]);

          if (!healthResponse.ok) {
            throw new Error(`Health check failed with ${healthResponse.status}`);
          }

          const health = (await healthResponse.json()) as {
            workspacePath?: string;
            role?: ServerRole;
          };

          if (!cancelled) {
            setHealthError(null);
            setWorkspaceFilePath(health.workspacePath ?? null);
            setServerRole(health.role ?? null);
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
    if (!workspace || activePresetId) {
      return;
    }

    setActivePresetId(workspace.cameraPresets[0]?.id ?? null);
  }, [activePresetId, workspace]);

  useEffect(() => {
    if (!workspace) {
      return;
    }

    if (previousWorkspaceLayoutModeRef.current === workspace.layoutMode) {
      return;
    }

    logStateDebug('app', 'layoutModeObserved', {
      previousLayoutMode: previousWorkspaceLayoutModeRef.current,
      nextLayoutMode: workspace.layoutMode,
      workspace: summarizeWorkspaceForDebug(workspace),
    });
    previousWorkspaceLayoutModeRef.current = workspace.layoutMode;
  }, [workspace]);

  useEffect(() => {
    if (previousSelectedNodeIdRef.current === selectedNodeId) {
      return;
    }

    logStateDebug('app', 'selectedNodeChanged', {
      previousSelectedNodeId: previousSelectedNodeIdRef.current,
      nextSelectedNodeId: selectedNodeId,
      workspaceLayoutMode: workspace?.layoutMode ?? null,
      note: 'selectedNodeId is local canvas UI state.',
    });
    previousSelectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId, workspace?.layoutMode]);

  useEffect(() => {
    if (!workspace || !isSelectionHydrated || selectedNodeId) {
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

    if (!hasCanvasViewportSize(canvasViewportSize)) {
      return;
    }

    focusTerminalWithTransition({
      terminal,
      startViewport: workspace.currentViewport,
      canvasSize: canvasViewportSize,
      onSelectTerminal: setSelectedNodeId,
      onAutoFocusAtChange: setFocusAutoFocusAtMs,
      onViewportChange: handleSingleTerminalAutoFocusViewportChange,
      animationFrameRef: viewportAnimationFrameRef,
    });
  }, [
    bumpNodeInteraction,
    canvasViewportSize,
    handleSingleTerminalAutoFocusViewportChange,
    isSelectionHydrated,
    selectedNodeId,
    setSelectedNodeId,
    workspace,
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
  const inferredBackendShellById = useMemo(() => {
    const next: Record<string, string> = {};

    for (const terminal of terminals) {
      const normalizedShell = terminal.shell.trim();

      if (!normalizedShell) {
        continue;
      }

      next[terminal.backendId ?? LOCAL_BACKEND_ID] = normalizedShell;
    }

    return next;
  }, [terminals]);
  const resolveBackendShell = useCallback((backendId: string): string => {
    const configuredShell = backendShellById[backendId]?.trim();

    if (configuredShell) {
      return configuredShell;
    }

    const inferredShell = inferredBackendShellById[backendId]?.trim();

    if (inferredShell) {
      return inferredShell;
    }

    return getDefaultShell();
  }, [backendShellById, inferredBackendShellById]);
  const rememberBackendShell = useCallback((backendId: string, shell: string): void => {
    const normalizedShell = shell.trim();

    if (!normalizedShell) {
      return;
    }

    setBackendShellById((current) => {
      if (current[backendId] === normalizedShell) {
        return current;
      }

      return {
        ...current,
        [backendId]: normalizedShell,
      };
    });
  }, []);
  const availableTerminalBackends = useMemo(
    () => [
      { id: LOCAL_BACKEND_ID, label: 'Local backend' },
      ...(workspace?.backends.map((backend) => ({
        id: backend.id,
        label: backend.label,
      })) ?? []),
    ],
    [workspace],
  );
  const terminalShellOptions = useMemo(() => getShellPresets(), []);

  useEffect(() => {
    if (availableTerminalBackends.some((backend) => backend.id === terminalBackendId)) {
      return;
    }

    setTerminalBackendId(LOCAL_BACKEND_ID);
    setTerminalShell(resolveBackendShell(LOCAL_BACKEND_ID));
  }, [availableTerminalBackends, resolveBackendShell, terminalBackendId]);

  useEffect(() => {
    writeStoredBackendShellById(backendShellById);
  }, [backendShellById]);

  const focusTerminal = useCallback((terminalId: string) => {
    const terminal = terminals.find((candidate) => candidate.id === terminalId);

    if (!terminal) {
      return;
    }

    logStateDebug('app', 'focusTerminalRequested', {
      terminalId,
      layoutMode,
      currentViewport,
    });

    bumpNodeInteraction(terminalId);

    if (layoutMode === 'focus-tiles') {
      setSelectedNodeId(terminalId);
      setFocusAutoFocusAtMs(null);
      return;
    }

    focusTerminalWithTransition({
      terminal,
      startViewport: currentViewport,
      canvasSize: canvasViewportSize,
      onSelectTerminal: setSelectedNodeId,
      onAutoFocusAtChange: setFocusAutoFocusAtMs,
      onViewportChange: handleTerminalFocusViewportChange,
      animationFrameRef: viewportAnimationFrameRef,
    });
  }, [
    bumpNodeInteraction,
    canvasViewportSize,
    currentViewport,
    handleTerminalFocusViewportChange,
    layoutMode,
    setSelectedNodeId,
    terminals,
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

    logStateDebug('app', 'focusMarkdownRequested', {
      markdownId,
      layoutMode,
      currentViewport,
    });

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
      canvasSize: canvasViewportSize,
      onSelectMarkdown: setSelectedNodeId,
      onViewportChange: handleMarkdownFocusViewportChange,
      animationFrameRef: viewportAnimationFrameRef,
    });
  }, [
    bumpNodeInteraction,
    canvasViewportSize,
    currentViewport,
    handleMarkdownFocusViewportChange,
    layoutMode,
    setSelectedNodeId,
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

  const createRemoteTerminal = useCallback(async (
    backendId: string,
    input: CreateTerminalNodeInput,
  ): Promise<{
    terminal: TerminalNode;
    workspace: Workspace | null;
  }> => {
    const response = await fetchWithFrontendLease(
      `/api/backends/${encodeURIComponent(backendId)}/terminals`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          label: input.label,
          shell: input.shell,
          cwd: input.cwd,
          agentType: input.agentType,
          repoLabel: input.repoLabel,
          taskLabel: input.taskLabel,
          tags: input.tags ?? [],
        }),
      },
    );

    if (!response.ok) {
      const payload = (await response.json()) as { message?: string };
      throw new Error(payload.message ?? `Server error ${response.status}`);
    }

    const payload = (await response.json()) as {
      terminal?: TerminalNode;
      workspace?: Workspace;
    };

    if (!payload.terminal) {
      throw new Error('Remote backend did not return a created terminal.');
    }

    return {
      terminal: payload.terminal,
      workspace: payload.workspace ?? null,
    };
  }, []);

  async function launchTerminal(input: CreateTerminalNodeInput) {
    setTerminalCreateError(null);

    let createdTerminal: TerminalNode | null = null;
    const selectedBackendId = input.backendId ?? LOCAL_BACKEND_ID;

    if (selectedBackendId === LOCAL_BACKEND_ID) {
      createdTerminal = await addTerminal(input, {
        persistImmediately: true,
      });
    } else {
      try {
        const remoteCreate = await createRemoteTerminal(selectedBackendId, input);
        createdTerminal = remoteCreate.terminal;
        if (remoteCreate.workspace) {
          replaceWorkspace(remoteCreate.workspace);
        } else {
          void refreshWorkspaceFromServer();
        }
      } catch (error) {
        setTerminalCreateError(
          error instanceof Error ? error.message : 'Failed to create remote terminal.',
        );
        return;
      }
    }

    if (!createdTerminal) {
      setTerminalCreateError('Failed to create terminal.');
      return;
    }

    rememberBackendShell(selectedBackendId, createdTerminal.shell);
    bumpNodeInteraction(createdTerminal.id);

    if (layoutMode === 'focus-tiles') {
      setSelectedNodeId(createdTerminal.id);
      setFocusAutoFocusAtMs(null);
    } else {
      focusTerminalWithTransition({
        terminal: createdTerminal,
        startViewport: currentViewport,
        canvasSize: canvasViewportSize,
        onSelectTerminal: setSelectedNodeId,
        onAutoFocusAtChange: setFocusAutoFocusAtMs,
        onViewportChange: handleNewTerminalFocusViewportChange,
        animationFrameRef: viewportAnimationFrameRef,
      });
    }

    awaitSession(createdTerminal.id);
  }

  const handleSelectedNodeChange = useCallback((nodeId: string | null) => {
    if (nodeId) {
      bumpNodeInteraction(nodeId);
    }

    logStateDebug('app', 'selectedNodeChangeRequested', {
      nextSelectedNodeId: nodeId,
      layoutMode,
    });
    setSelectedNodeId(nodeId);
  }, [bumpNodeInteraction, layoutMode, setSelectedNodeId]);

  const handleTerminalRemove = useCallback((terminalId: string) => {
    setFocusAutoFocusAtMs(null);
    clearNodeInteraction(terminalId);
    removeTerminal(terminalId, { persistImmediately: true });
  }, [clearNodeInteraction, removeTerminal, setFocusAutoFocusAtMs]);

  const handleMarkdownRemove = useCallback((markdownId: string) => {
    clearNodeInteraction(markdownId);
    removeMarkdown(markdownId, { persistImmediately: true });
  }, [clearNodeInteraction, removeMarkdown]);

  const handleTerminalInput = useCallback((sessionId: string, data: string) => {
    bumpNodeInteraction(sessionId, 1_000);
    sendInput(sessionId, data);
  }, [bumpNodeInteraction, sendInput]);
  const handleTerminalResize = useCallback((
    sessionId: string,
    cols: number,
    rows: number,
    generation: number,
  ) => {
    return resizeSession(sessionId, cols, rows, generation);
  }, [resizeSession]);
  const handleTerminalResizeSyncError = useCallback((details: {
    sessionId: string;
    cols: number;
    rows: number;
    timeoutMs: number;
  }) => {
    setTerminalResizeSyncError((current) => {
      if (
        current &&
        current.sessionId === details.sessionId &&
        current.cols === details.cols &&
        current.rows === details.rows
      ) {
        return current;
      }

      return details;
    });
  }, []);

  const handleTerminalRestart = useCallback((sessionId: string) => {
    bumpNodeInteraction(sessionId);
    restartSession(sessionId);
  }, [bumpNodeInteraction, restartSession]);

  const handleMarkTerminalRead = useCallback((sessionId: string) => {
    bumpNodeInteraction(sessionId);
    markSessionRead(sessionId);
  }, [bumpNodeInteraction, markSessionRead]);

  const handleNodeBoundsChange = useCallback((
    nodeId: string,
    bounds: Workspace['terminals'][number]['bounds'],
  ) => {
    setNodeBounds(nodeId, bounds, {
      debugSource: 'canvas.boundsChange',
    });
  }, [setNodeBounds]);

  const handleLayoutModeChange = useCallback((nextLayoutMode: WorkspaceLayoutMode): void => {
    setFocusAutoFocusAtMs(null);
    logStateDebug('app', 'layoutModeChangeRequested', {
      previousLayoutMode: workspace?.layoutMode ?? null,
      nextLayoutMode,
      persistencePhase: persistence.phase,
    });
    setLayoutMode(nextLayoutMode);
  }, [persistence.phase, setLayoutMode, workspace?.layoutMode]);

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
    void toggleBrowserNotifications();
  }, [toggleBrowserNotifications]);
  const handleSoundToggle = useCallback(() => {
    toggleSound();
  }, [toggleSound]);

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
        onTerminalResize={handleTerminalResize}
        onTerminalResizeSyncError={handleTerminalResizeSyncError}
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
        onNodeBoundsChange={handleNodeBoundsChange}
        onViewportChange={handleCanvasViewportChange}
        onViewportSizeChange={handleCanvasViewportSizeChange}
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
                void launchTerminal({
                  label: getDefaultTerminalLabel(
                    terminalAgentType,
                    workspace.terminals.length + 1,
                  ),
                  shell: terminalShell,
                  cwd: '.',
                  agentType: terminalAgentType,
                  backendId: terminalBackendId,
                });
              }}
            >
              Add Terminal
            </button>
            <label className="toolbar-select-field">
              <span className="meta-label">Backend</span>
              <select
                className="toolbar-select"
                value={terminalBackendId}
                onChange={(event) => {
                  const nextBackendId = event.target.value;
                  setTerminalBackendId(nextBackendId);
                  setTerminalShell(resolveBackendShell(nextBackendId));
                  setTerminalCreateError(null);
                }}
              >
                {availableTerminalBackends.map((backend) => (
                  <option key={backend.id} value={backend.id}>
                    {backend.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="toolbar-select-field">
              <span className="meta-label">Shell</span>
              <select
                className="toolbar-select"
                value={terminalShell}
                onChange={(event) => {
                  setTerminalShell(event.target.value);
                }}
              >
                {terminalShellOptions.map((shellOption) => (
                  <option key={shellOption.value} value={shellOption.value}>
                    {shellOption.label}
                  </option>
                ))}
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
            {terminalCreateError ? (
              <span className="workspace-toolbar-error" title={terminalCreateError}>
                {terminalCreateError}
              </span>
            ) : null}
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
            <button
              type="button"
              className={
                isBackendsPanelOpen
                  ? 'toolbar-button is-active'
                  : 'toolbar-button'
              }
              aria-controls="backend-manager-panel"
              aria-expanded={isBackendsPanelOpen}
              onClick={() => {
                setIsBackendsPanelOpen((current) => !current);
              }}
            >
              Backends
            </button>
          </div>
        </div>
      </header>

      {isBackendsPanelOpen ? (
        <BackendManagerPanel
          asideId="backend-manager-panel"
          serverRole={serverRole}
          onBackendsChanged={() => refreshWorkspaceFromServer()}
        />
      ) : null}

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

      {terminalResizeSyncError ? (
        <div
          className="workspace-modal-backdrop"
          onClick={() => {
            setTerminalResizeSyncError(null);
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
                <p className="eyebrow">Terminal Error</p>
                <h2>Failed to sync terminal size</h2>
              </div>
              <button
                type="button"
                onClick={() => {
                  setTerminalResizeSyncError(null);
                }}
              >
                Dismiss
              </button>
            </div>
            <p className="workspace-modal-help">
              The frontend could not sync PTY size for terminal{' '}
              <code>{terminalResizeSyncError.sessionId}</code> after{' '}
              {Math.round(terminalResizeSyncError.timeoutMs / 1_000)} seconds.
            </p>
            <p className="workspace-modal-help">
              Requested size <code>{terminalResizeSyncError.cols}</code> x{' '}
              <code>{terminalResizeSyncError.rows}</code>. Restart the terminal or
              reload the app to recover.
            </p>
            <div className="workspace-modal-actions">
              <button
                type="button"
                onClick={() => {
                  setTerminalResizeSyncError(null);
                }}
              >
                Close
              </button>
            </div>
          </section>
        </div>
      ) : null}

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

interface TerminalResizeSyncError {
  sessionId: string;
  cols: number;
  rows: number;
  timeoutMs: number;
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

function hasCanvasViewportSize(size: { width: number; height: number }): boolean {
  return size.width > 0 && size.height > 0;
}

function readStoredBackendShellById(): Record<string, string> {
  if (typeof window === 'undefined') {
    return {};
  }

  const rawValue = window.localStorage.getItem(BACKEND_SHELLS_STORAGE_KEY);

  if (!rawValue) {
    return {};
  }

  try {
    const parsed = JSON.parse(rawValue) as unknown;

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }

    const next: Record<string, string> = {};

    for (const [backendId, shell] of Object.entries(parsed)) {
      if (typeof shell !== 'string') {
        continue;
      }

      const normalizedBackendId = backendId.trim();
      const normalizedShell = shell.trim();

      if (!normalizedBackendId || !normalizedShell) {
        continue;
      }

      next[normalizedBackendId] = normalizedShell;
    }

    return next;
  } catch {
    return {};
  }
}

function writeStoredBackendShellById(value: Record<string, string>): void {
  if (typeof window === 'undefined') {
    return;
  }

  const entries = Object.entries(value);

  if (!entries.length) {
    window.localStorage.removeItem(BACKEND_SHELLS_STORAGE_KEY);
    return;
  }

  const normalized = Object.fromEntries(
    entries
      .map(([backendId, shell]) => [backendId.trim(), shell.trim()] as const)
      .filter(([backendId, shell]) => Boolean(backendId) && Boolean(shell)),
  );

  if (!Object.keys(normalized).length) {
    window.localStorage.removeItem(BACKEND_SHELLS_STORAGE_KEY);
    return;
  }

  window.localStorage.setItem(
    BACKEND_SHELLS_STORAGE_KEY,
    JSON.stringify(normalized),
  );
}

function getWorkspaceDirectory(workspacePath: string | null): string {
  if (!workspacePath) {
    return '.terminal-canvas';
  }

  return workspacePath.replace(/[\\/][^\\/]+$/, '');
}

function formatLeaseExpiry(expiresAt: string): string {
  const date = new Date(expiresAt);

  if (Number.isNaN(date.getTime())) {
    return expiresAt;
  }

  return date.toLocaleTimeString();
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

