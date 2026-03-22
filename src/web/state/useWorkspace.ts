import { startTransition, useCallback, useEffect, useRef, useState } from 'react';

import {
  type CreateTerminalNodeInput,
  type TerminalNode,
  type TerminalNodePatch,
  touchWorkspace,
  type CameraViewport,
  type Workspace,
  type WorkspaceLayoutMode,
} from '../../shared/workspace';
import {
  fetchWorkspace,
  persistWorkspace,
  WorkspaceConflictError,
} from './workspaceClient';
import {
  addMarkdownToWorkspace,
  addTerminalToWorkspace,
  applyWorkspaceCameraPreset,
  removeMarkdownFromWorkspace,
  removeTerminalFromWorkspace,
  saveWorkspaceViewportToPreset,
  setWorkspaceLayoutMode,
  setWorkspaceSelectedNode,
  setWorkspaceViewport,
  updateWorkspaceTerminal,
} from './workspaceActions';
import {
  logStateDebug,
  summarizeWorkspaceDiffForDebug,
  summarizeWorkspaceForDebug,
} from '../debug/stateDebug';
import { waitForRetry } from '../utils/retry';
import { isStaleWorkspaceSnapshot } from './workspaceFreshness';

export interface WorkspacePersistenceState {
  phase: 'loading' | 'saving' | 'saved' | 'error';
  error: string | null;
  lastSavedAt: string | null;
}

type WorkspaceUpdater = (workspace: Workspace) => Workspace;
interface UpdateWorkspaceOptions {
  persistImmediately?: boolean;
  debugSource?: string;
}

export function useWorkspace() {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [persistence, setPersistence] = useState<WorkspacePersistenceState>({
    phase: 'loading',
    error: null,
    lastSavedAt: null,
  });
  const hasLoadedRef = useRef(false);
  const workspaceRef = useRef<Workspace | null>(null);
  const autosaveTimerRef = useRef<number | null>(null);
  const localRevisionRef = useRef(0);
  const lastSavedRevisionRef = useRef(0);
  const inFlightRevisionRef = useRef<number | null>(null);
  const refreshInFlightRef = useRef(false);
  const pendingExternalWorkspaceRef = useRef<Workspace | null>(null);
  const pendingServerRefreshRef = useRef(false);
  const lastSyncedUpdatedAtRef = useRef<string | null>(null);

  const applyLoadedWorkspace = useCallback((nextWorkspace: Workspace) => {
    hasLoadedRef.current = true;
    workspaceRef.current = nextWorkspace;
    lastSyncedUpdatedAtRef.current = nextWorkspace.updatedAt;
    localRevisionRef.current = 0;
    lastSavedRevisionRef.current = 0;
    inFlightRevisionRef.current = null;
    pendingExternalWorkspaceRef.current = null;
    pendingServerRefreshRef.current = false;

    startTransition(() => {
      setWorkspace(nextWorkspace);
      setPersistence({
        phase: 'saved',
        error: null,
        lastSavedAt: nextWorkspace.updatedAt,
      });
    });

    logStateDebug('workspace', 'applyLoadedWorkspace', {
      workspace: summarizeWorkspaceForDebug(nextWorkspace),
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    let attempt = 0;

    async function loadWorkspace() {
      while (!cancelled) {
        try {
          logStateDebug('workspace', 'initialLoadAttempt', {
            attempt: attempt + 1,
          });
          const loadedWorkspace = await fetchWorkspace();

          if (cancelled) {
            return;
          }

          applyLoadedWorkspace(loadedWorkspace);
          logStateDebug('workspace', 'initialLoadSuccess', {
            workspace: summarizeWorkspaceForDebug(loadedWorkspace),
          });
          return;
        } catch (error) {
          if (cancelled) {
            return;
          }

          attempt += 1;
          const message =
            error instanceof Error ? error.message : 'Unknown error';

          setPersistence({
            phase: 'loading',
            error: `Workspace server unavailable (${message}). Retrying...`,
            lastSavedAt: null,
          });

          logStateDebug('workspace', 'initialLoadError', {
            attempt,
            error: message,
          });

          await waitForRetry(Math.min(2_500, 350 * attempt));
        }
      }
    }

    void loadWorkspace();

    return () => {
      cancelled = true;
      clearAutosaveTimer(autosaveTimerRef);
    }
  }, [applyLoadedWorkspace]);

  const refreshWorkspaceFromServer = useCallback(async (
    nextWorkspace?: Workspace | null,
  ): Promise<boolean> => {
    const candidateWorkspace = nextWorkspace ?? null;
    const currentWorkspace = workspaceRef.current;

    if (candidateWorkspace && isStaleWorkspaceSnapshot(candidateWorkspace, currentWorkspace)) {
      logStateDebug('workspace', 'refreshSkippedStaleCandidate', {
        currentWorkspace: summarizeWorkspaceForDebug(currentWorkspace),
        candidateWorkspace: summarizeWorkspaceForDebug(candidateWorkspace),
      });
      return true;
    }

    if (
      inFlightRevisionRef.current !== null ||
      localRevisionRef.current > lastSavedRevisionRef.current
    ) {
      logStateDebug('workspace', 'refreshDeferred', {
        candidateWorkspace: summarizeWorkspaceForDebug(candidateWorkspace),
        inFlightRevision: inFlightRevisionRef.current,
        localRevision: localRevisionRef.current,
        lastSavedRevision: lastSavedRevisionRef.current,
      });
      if (candidateWorkspace) {
        pendingExternalWorkspaceRef.current = candidateWorkspace;
      } else {
        pendingServerRefreshRef.current = true;
      }
      return false;
    }

    if (
      candidateWorkspace &&
      currentWorkspace &&
      candidateWorkspace.updatedAt === currentWorkspace.updatedAt
    ) {
      logStateDebug('workspace', 'refreshSkippedSameUpdatedAt', {
        workspace: summarizeWorkspaceForDebug(candidateWorkspace),
      });
      return true;
    }

    if (refreshInFlightRef.current) {
      logStateDebug('workspace', 'refreshSkippedInFlight', {
        candidateWorkspace: summarizeWorkspaceForDebug(candidateWorkspace),
      });
      if (candidateWorkspace) {
        pendingExternalWorkspaceRef.current = candidateWorkspace;
      } else {
        pendingServerRefreshRef.current = true;
      }
      return false;
    }

    refreshInFlightRef.current = true;

    try {
      logStateDebug('workspace', 'refreshStart', {
        hasCandidateWorkspace: Boolean(candidateWorkspace),
        candidateWorkspace: summarizeWorkspaceForDebug(candidateWorkspace),
      });
      const loadedWorkspace = candidateWorkspace ?? (await fetchWorkspace());
      const latestWorkspace = workspaceRef.current;

      if (
        latestWorkspace &&
        latestWorkspace.updatedAt === loadedWorkspace.updatedAt
      ) {
        pendingExternalWorkspaceRef.current = null;
        logStateDebug('workspace', 'refreshNoopSameUpdatedAt', {
          workspace: summarizeWorkspaceForDebug(loadedWorkspace),
        });
        return true;
      }

      logStateDebug('workspace', 'refreshApply', {
        previousWorkspace: summarizeWorkspaceForDebug(latestWorkspace),
        nextWorkspace: summarizeWorkspaceForDebug(loadedWorkspace),
        diff: summarizeWorkspaceDiffForDebug(latestWorkspace, loadedWorkspace),
      });
      applyLoadedWorkspace(loadedWorkspace);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      setPersistence((current) => ({
        phase: current.phase,
        error: message,
        lastSavedAt: current.lastSavedAt,
      }));
      logStateDebug('workspace', 'refreshError', {
        error: message,
      });
      return false;
    } finally {
      refreshInFlightRef.current = false;

      if (
        inFlightRevisionRef.current === null &&
        localRevisionRef.current <= lastSavedRevisionRef.current &&
        (pendingExternalWorkspaceRef.current || pendingServerRefreshRef.current)
      ) {
        const pendingWorkspace = pendingExternalWorkspaceRef.current;
        const shouldFetchServer = pendingServerRefreshRef.current;
        pendingExternalWorkspaceRef.current = null;
        pendingServerRefreshRef.current = false;

        if (pendingWorkspace) {
          void refreshWorkspaceFromServer(pendingWorkspace);
        } else if (shouldFetchServer) {
          void refreshWorkspaceFromServer();
        }
      }
    }
  }, [applyLoadedWorkspace]);

  const persistCurrentWorkspace = useCallback(async () => {
    const nextWorkspace = workspaceRef.current;

    if (
      !hasLoadedRef.current ||
      !nextWorkspace ||
      inFlightRevisionRef.current !== null ||
      localRevisionRef.current <= lastSavedRevisionRef.current
    ) {
      return;
    }

    const revision = localRevisionRef.current;
    inFlightRevisionRef.current = revision;
    const baseUpdatedAt = lastSyncedUpdatedAtRef.current;

    setPersistence((current) => ({
      ...current,
      phase: 'saving',
      error: null,
    }));

    logStateDebug('workspace', 'persistStart', {
      revision,
      baseUpdatedAt,
      workspace: summarizeWorkspaceForDebug(nextWorkspace),
    });

    try {
      const savedWorkspace = await persistWorkspace(nextWorkspace, {
        baseUpdatedAt,
      });
      lastSavedRevisionRef.current = Math.max(
        lastSavedRevisionRef.current,
        revision,
      );
      lastSyncedUpdatedAtRef.current = savedWorkspace.updatedAt;

      if (revision === localRevisionRef.current) {
        workspaceRef.current = savedWorkspace;

        startTransition(() => {
          setWorkspace(savedWorkspace);
        });

        setPersistence({
          phase: 'saved',
          error: null,
          lastSavedAt: savedWorkspace.updatedAt,
        });
      } else {
        setPersistence((current) => ({
          phase: 'saving',
          error: null,
          lastSavedAt: savedWorkspace.updatedAt ?? current.lastSavedAt,
        }));
      }

      logStateDebug('workspace', 'persistSuccess', {
        revision,
        baseUpdatedAt,
        savedWorkspace: summarizeWorkspaceForDebug(savedWorkspace),
      });
    } catch (error) {
      if (error instanceof WorkspaceConflictError) {
        logStateDebug('workspace', 'persistConflict', {
          revision,
          baseUpdatedAt,
          localWorkspace: summarizeWorkspaceForDebug(nextWorkspace),
          serverWorkspace: summarizeWorkspaceForDebug(error.workspace),
        });
        applyLoadedWorkspace(error.workspace);
        return;
      }

      const message = error instanceof Error ? error.message : 'Unknown error';
      setPersistence((current) => ({
        phase: 'error',
        error: message,
        lastSavedAt: current.lastSavedAt,
      }));
      logStateDebug('workspace', 'persistError', {
        revision,
        baseUpdatedAt,
        error: message,
        workspace: summarizeWorkspaceForDebug(nextWorkspace),
      });
    } finally {
      inFlightRevisionRef.current = null;

      if (localRevisionRef.current > lastSavedRevisionRef.current) {
        schedulePersist(autosaveTimerRef, persistCurrentWorkspace, 0);
      } else if (
        pendingExternalWorkspaceRef.current ||
        pendingServerRefreshRef.current
      ) {
        const pendingWorkspace = pendingExternalWorkspaceRef.current;
        const shouldFetchServer = pendingServerRefreshRef.current;
        pendingExternalWorkspaceRef.current = null;
        pendingServerRefreshRef.current = false;

        if (pendingWorkspace) {
          void refreshWorkspaceFromServer(pendingWorkspace);
        } else if (shouldFetchServer) {
          void refreshWorkspaceFromServer();
        }
      }
    }
  }, [applyLoadedWorkspace, refreshWorkspaceFromServer]);

  const updateWorkspace = useCallback((
    updater: WorkspaceUpdater,
    options?: UpdateWorkspaceOptions,
  ): Workspace | null => {
    const currentWorkspace = workspaceRef.current;

    if (!currentWorkspace) {
      return null;
    }

    const nextWorkspace = updater(currentWorkspace);

    if (nextWorkspace === currentWorkspace) {
      return currentWorkspace;
    }

    const touchedWorkspace = touchWorkspace(nextWorkspace);
    workspaceRef.current = touchedWorkspace;
    localRevisionRef.current += 1;
    const revision = localRevisionRef.current;

    startTransition(() => {
      setWorkspace(touchedWorkspace);
    });

    logStateDebug('workspace', 'localUpdate', {
      source: options?.debugSource ?? 'unknown',
      revision,
      persistDelayMs: options?.persistImmediately ? 0 : 450,
      previousWorkspace: summarizeWorkspaceForDebug(currentWorkspace),
      nextWorkspace: summarizeWorkspaceForDebug(touchedWorkspace),
      diff: summarizeWorkspaceDiffForDebug(currentWorkspace, touchedWorkspace),
    });

    if (options?.persistImmediately) {
      schedulePersist(autosaveTimerRef, persistCurrentWorkspace, 0);
    } else {
      schedulePersist(autosaveTimerRef, persistCurrentWorkspace, 450);
    }

    return touchedWorkspace;
  }, [persistCurrentWorkspace]);

  const replaceWorkspace = useCallback((nextWorkspace: Workspace) => {
    clearAutosaveTimer(autosaveTimerRef);
    logStateDebug('workspace', 'replaceWorkspace', {
      workspace: summarizeWorkspaceForDebug(nextWorkspace),
    });
    applyLoadedWorkspace(nextWorkspace);
  }, [applyLoadedWorkspace]);

  const addTerminal = useCallback((
    input?: Partial<CreateTerminalNodeInput>,
    options?: UpdateWorkspaceOptions,
  ): TerminalNode | null => {
    let createdTerminal: TerminalNode | null = null;

    updateWorkspace((current) => {
      const nextState = addTerminalToWorkspace(current, input);
      createdTerminal = nextState.terminal;
      return nextState.workspace;
    }, {
      ...options,
      debugSource: options?.debugSource ?? 'addTerminal',
    });

    return createdTerminal;
  }, [updateWorkspace]);

  const addMarkdown = useCallback(() => {
    updateWorkspace(addMarkdownToWorkspace, {
      debugSource: 'addMarkdown',
    });
  }, [updateWorkspace]);

  const updateTerminal = useCallback((terminalId: string, patch: TerminalNodePatch) => {
    updateWorkspace((current) => updateWorkspaceTerminal(current, terminalId, patch), {
      debugSource: 'updateTerminal',
    });
  }, [updateWorkspace]);

  const removeTerminal = useCallback((
    terminalId: string,
    options?: UpdateWorkspaceOptions,
  ) => {
    updateWorkspace(
      (current) => removeTerminalFromWorkspace(current, terminalId),
      {
        ...options,
        debugSource: options?.debugSource ?? 'removeTerminal',
      },
    );
  }, [updateWorkspace]);

  const removeMarkdown = useCallback((
    markdownId: string,
    options?: UpdateWorkspaceOptions,
  ) => {
    updateWorkspace(
      (current) => removeMarkdownFromWorkspace(current, markdownId),
      {
        ...options,
        debugSource: options?.debugSource ?? 'removeMarkdown',
      },
    );
  }, [updateWorkspace]);

  const setViewport = useCallback((
    viewport: CameraViewport,
    options?: UpdateWorkspaceOptions,
  ) => {
    logStateDebug('workspace', 'setViewportRequested', {
      source: options?.debugSource ?? 'setViewport',
      viewport,
      currentViewport: workspaceRef.current?.currentViewport ?? null,
    });
    updateWorkspace((current) => setWorkspaceViewport(current, viewport), {
      ...options,
      debugSource: options?.debugSource ?? 'setViewport',
    });
  }, [updateWorkspace]);

  const applyCameraPreset = useCallback((presetId: string) => {
    updateWorkspace((current) => applyWorkspaceCameraPreset(current, presetId), {
      debugSource: 'applyCameraPreset',
    });
  }, [updateWorkspace]);

  const saveViewportToPreset = useCallback((presetId: string) => {
    updateWorkspace((current) => saveWorkspaceViewportToPreset(current, presetId), {
      debugSource: 'saveViewportToPreset',
    });
  }, [updateWorkspace]);

  const setLayoutMode = useCallback((layoutMode: WorkspaceLayoutMode) => {
    updateWorkspace((current) => setWorkspaceLayoutMode(current, layoutMode), {
      debugSource: 'setLayoutMode',
      persistImmediately: true,
    });
  }, [updateWorkspace]);

  const setSelectedNodeId = useCallback((selectedNodeId: string | null) => {
    updateWorkspace((current) => setWorkspaceSelectedNode(current, selectedNodeId), {
      debugSource: 'setSelectedNodeId',
      persistImmediately: true,
    });
  }, [updateWorkspace]);

  return {
    workspace,
    persistence,
    updateWorkspace,
    replaceWorkspace,
    refreshWorkspaceFromServer,
    addTerminal,
    addMarkdown,
    updateTerminal,
    removeTerminal,
    removeMarkdown,
    setViewport,
    applyCameraPreset,
    saveViewportToPreset,
    setLayoutMode,
    setSelectedNodeId,
  };
}

function clearAutosaveTimer(timerRef: React.RefObject<number | null>): void {
  if (timerRef.current === null) {
    return;
  }

  window.clearTimeout(timerRef.current);
  timerRef.current = null;
}

function schedulePersist(
  timerRef: React.RefObject<number | null>,
  persist: () => Promise<void>,
  delayMs: number,
): void {
  clearAutosaveTimer(timerRef);

  timerRef.current = window.setTimeout(() => {
    timerRef.current = null;
    void persist();
  }, delayMs);
}
