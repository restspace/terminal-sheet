import { startTransition, useCallback, useEffect, useRef, useState } from 'react';

import { LOCAL_BACKEND_ID } from '../../shared/backends';
import { getDefaultShell } from '../../shared/platform';
import {
  createTerminalNode,
  touchWorkspace,
  type CameraViewport,
  type CreateTerminalNodeInput,
  type TerminalNode,
  type TerminalNodePatch,
  type Workspace,
  type WorkspaceLayoutMode,
} from '../../shared/workspace';
import {
  applyWorkspaceCommands as applyWorkspaceCommandsToState,
} from '../../shared/workspaceCommands';
import {
  fetchWorkspace,
  sendWorkspaceCommands,
  WorkspaceConflictError,
} from './workspaceClient';
import {
  logStateDebug,
  summarizeWorkspaceDiffForDebug,
  summarizeWorkspaceForDebug,
} from '../debug/stateDebug';
import { waitForRetry } from '../utils/retry';
import { isStaleWorkspaceSnapshot } from './workspaceFreshness';

type WorkspaceCommand = Parameters<
  typeof applyWorkspaceCommandsToState
>[1][number];

export interface WorkspacePersistenceState {
  phase: 'loading' | 'saving' | 'saved' | 'error';
  error: string | null;
  lastSavedAt: string | null;
}

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
  const pendingCommandsRef = useRef<WorkspaceCommand[]>([]);
  const inFlightCommandsRef = useRef<WorkspaceCommand[] | null>(null);
  const refreshInFlightRef = useRef(false);
  const pendingExternalWorkspaceRef = useRef<Workspace | null>(null);
  const pendingServerRefreshRef = useRef(false);
  const lastSyncedUpdatedAtRef = useRef<string | null>(null);

  const applyLoadedWorkspace = useCallback((nextWorkspace: Workspace) => {
    hasLoadedRef.current = true;
    clearAutosaveTimer(autosaveTimerRef);
    workspaceRef.current = nextWorkspace;
    lastSyncedUpdatedAtRef.current = nextWorkspace.updatedAt;
    pendingCommandsRef.current = [];
    inFlightCommandsRef.current = null;
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
    };
  }, [applyLoadedWorkspace]);

  const refreshWorkspaceFromServer = useCallback(
    async (nextWorkspace?: Workspace | null): Promise<boolean> => {
      const candidateWorkspace = nextWorkspace ?? null;
      const currentWorkspace = workspaceRef.current;

      if (
        candidateWorkspace &&
        isStaleWorkspaceSnapshot(candidateWorkspace, currentWorkspace)
      ) {
        logStateDebug('workspace', 'refreshSkippedStaleCandidate', {
          currentWorkspace: summarizeWorkspaceForDebug(currentWorkspace),
          candidateWorkspace: summarizeWorkspaceForDebug(candidateWorkspace),
        });
        return true;
      }

      if (
        inFlightCommandsRef.current !== null ||
        pendingCommandsRef.current.length > 0
      ) {
        logStateDebug('workspace', 'refreshDeferred', {
          candidateWorkspace: summarizeWorkspaceForDebug(candidateWorkspace),
          inFlightCommandTypes:
            inFlightCommandsRef.current?.map((command) => command.type) ?? [],
          pendingCommandTypes: pendingCommandsRef.current.map(
            (command) => command.type,
          ),
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
          diff: summarizeWorkspaceDiffForDebug(
            latestWorkspace,
            loadedWorkspace,
          ),
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
          inFlightCommandsRef.current === null &&
          pendingCommandsRef.current.length === 0 &&
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
    },
    [applyLoadedWorkspace],
  );

  const persistPendingCommands = useCallback(async () => {
    const nextWorkspace = workspaceRef.current;
    const pendingCommands = pendingCommandsRef.current;

    if (
      !hasLoadedRef.current ||
      !nextWorkspace ||
      inFlightCommandsRef.current !== null ||
      !pendingCommands.length
    ) {
      return;
    }

    const commands = [...pendingCommands];
    pendingCommandsRef.current = [];
    inFlightCommandsRef.current = commands;
    const baseUpdatedAt = lastSyncedUpdatedAtRef.current;

    setPersistence((current) => ({
      ...current,
      phase: 'saving',
      error: null,
    }));

    logStateDebug('workspace', 'persistCommandsStart', {
      baseUpdatedAt,
      commandTypes: commands.map((command) => command.type),
      workspace: summarizeWorkspaceForDebug(nextWorkspace),
    });

    try {
      const savedWorkspace = await sendWorkspaceCommands(commands, {
        baseUpdatedAt,
      });
      lastSyncedUpdatedAtRef.current = savedWorkspace.updatedAt;

      if (pendingCommandsRef.current.length === 0) {
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
        const optimisticWorkspace = touchWorkspace(
          applyWorkspaceCommandsToState(
            savedWorkspace,
            pendingCommandsRef.current,
          ),
        );
        workspaceRef.current = optimisticWorkspace;

        startTransition(() => {
          setWorkspace(optimisticWorkspace);
        });

        setPersistence((current) => ({
          phase: 'saving',
          error: null,
          lastSavedAt: savedWorkspace.updatedAt ?? current.lastSavedAt,
        }));
      }

      logStateDebug('workspace', 'persistCommandsSuccess', {
        baseUpdatedAt,
        commandTypes: commands.map((command) => command.type),
        savedWorkspace: summarizeWorkspaceForDebug(savedWorkspace),
      });
    } catch (error) {
      if (error instanceof WorkspaceConflictError) {
        logStateDebug('workspace', 'persistCommandsConflict', {
          baseUpdatedAt,
          commandTypes: commands.map((command) => command.type),
          localWorkspace: summarizeWorkspaceForDebug(nextWorkspace),
          serverWorkspace: summarizeWorkspaceForDebug(error.workspace),
        });
        applyLoadedWorkspace(error.workspace);
        return;
      }

      pendingCommandsRef.current = [...commands, ...pendingCommandsRef.current];
      const message = error instanceof Error ? error.message : 'Unknown error';
      setPersistence((current) => ({
        phase: 'error',
        error: message,
        lastSavedAt: current.lastSavedAt,
      }));
      logStateDebug('workspace', 'persistCommandsError', {
        baseUpdatedAt,
        commandTypes: commands.map((command) => command.type),
        error: message,
        workspace: summarizeWorkspaceForDebug(nextWorkspace),
      });
    } finally {
      inFlightCommandsRef.current = null;

      if (pendingCommandsRef.current.length > 0) {
        schedulePersist(autosaveTimerRef, persistPendingCommands, 0);
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

  const applyCommands = useCallback(
    (
      commands: readonly WorkspaceCommand[],
      options?: UpdateWorkspaceOptions,
    ): Workspace | null => {
      const currentWorkspace = workspaceRef.current;

      if (!currentWorkspace || !commands.length) {
        return null;
      }

      const nextWorkspace = applyWorkspaceCommandsToState(
        currentWorkspace,
        commands,
      );

      if (nextWorkspace === currentWorkspace) {
        return currentWorkspace;
      }

      const touchedWorkspace = touchWorkspace(nextWorkspace);
      workspaceRef.current = touchedWorkspace;
      pendingCommandsRef.current = [...pendingCommandsRef.current, ...commands];

      startTransition(() => {
        setWorkspace(touchedWorkspace);
      });

      setPersistence((current) => ({
        phase: current.phase === 'loading' ? 'loading' : current.phase,
        error: null,
        lastSavedAt: current.lastSavedAt,
      }));

      logStateDebug('workspace', 'localCommandsApplied', {
        source: options?.debugSource ?? 'unknown',
        commandTypes: commands.map((command) => command.type),
        persistDelayMs: options?.persistImmediately ? 0 : 450,
        previousWorkspace: summarizeWorkspaceForDebug(currentWorkspace),
        nextWorkspace: summarizeWorkspaceForDebug(touchedWorkspace),
        diff: summarizeWorkspaceDiffForDebug(
          currentWorkspace,
          touchedWorkspace,
        ),
      });

      schedulePersist(
        autosaveTimerRef,
        persistPendingCommands,
        options?.persistImmediately ? 0 : 450,
      );

      return touchedWorkspace;
    },
    [persistPendingCommands],
  );

  const replaceWorkspace = useCallback((nextWorkspace: Workspace) => {
    logStateDebug('workspace', 'replaceWorkspace', {
      workspace: summarizeWorkspaceForDebug(nextWorkspace),
    });
    applyLoadedWorkspace(nextWorkspace);
  }, [applyLoadedWorkspace]);

  const addTerminal = useCallback((
    input?: Partial<CreateTerminalNodeInput>,
    options?: UpdateWorkspaceOptions,
  ): TerminalNode | null => {
    const currentWorkspace = workspaceRef.current;

    if (!currentWorkspace) {
      return null;
    }

      const terminal = createTerminalNode(
        {
        label: input?.label?.trim() || `Shell ${currentWorkspace.terminals.length + 1}`,
        shell: input?.shell?.trim() || getDefaultShell(),
        cwd: input?.cwd?.trim() || '.',
        agentType: input?.agentType ?? 'shell',
        backendId: input?.backendId,
        repoLabel: input?.repoLabel?.trim() || 'local workspace',
        taskLabel: input?.taskLabel?.trim() || 'live terminal session',
        tags: input?.tags ?? [],
      },
        currentWorkspace.terminals.length,
        currentWorkspace.currentViewport,
      );
      const command: WorkspaceCommand = {
        type: 'add-terminal',
        terminal: {
          ...terminal,
          backendId: terminal.backendId ?? LOCAL_BACKEND_ID,
        },
      };

      applyCommands(
        [command],
        {
          ...options,
          debugSource: options?.debugSource ?? 'addTerminal',
        persistImmediately: options?.persistImmediately ?? true,
      },
    );

    return terminal;
  }, [applyCommands]);

  const addMarkdown = useCallback(() => {
    applyCommands(
      [
        {
          type: 'add-markdown',
          input: {},
        },
      ],
      {
        debugSource: 'addMarkdown',
        persistImmediately: true,
      },
    );
  }, [applyCommands]);

  const updateTerminal = useCallback((terminalId: string, patch: TerminalNodePatch) => {
    applyCommands(
      [
        {
          type: 'update-terminal',
          terminalId,
          patch,
        },
      ],
      {
        debugSource: 'updateTerminal',
        persistImmediately: true,
      },
    );
  }, [applyCommands]);

  const removeTerminal = useCallback((
    terminalId: string,
    options?: UpdateWorkspaceOptions,
  ) => {
    applyCommands(
      [
        {
          type: 'remove-node',
          nodeId: terminalId,
        },
      ],
      {
        ...options,
        debugSource: options?.debugSource ?? 'removeTerminal',
        persistImmediately: options?.persistImmediately ?? true,
      },
    );
  }, [applyCommands]);

  const removeMarkdown = useCallback((
    markdownId: string,
    options?: UpdateWorkspaceOptions,
  ) => {
    applyCommands(
      [
        {
          type: 'remove-node',
          nodeId: markdownId,
        },
      ],
      {
        ...options,
        debugSource: options?.debugSource ?? 'removeMarkdown',
        persistImmediately: options?.persistImmediately ?? true,
      },
    );
  }, [applyCommands]);

  const setViewport = useCallback((
    viewport: CameraViewport,
    options?: UpdateWorkspaceOptions,
  ) => {
    logStateDebug('workspace', 'setViewportRequested', {
      source: options?.debugSource ?? 'setViewport',
      viewport,
      currentViewport: workspaceRef.current?.currentViewport ?? null,
    });
    applyCommands(
      [
        {
          type: 'set-viewport',
          viewport,
        },
      ],
      {
        ...options,
        debugSource: options?.debugSource ?? 'setViewport',
      },
    );
  }, [applyCommands]);

  const setNodeBounds = useCallback((
    nodeId: string,
    bounds: Workspace['terminals'][number]['bounds'],
    options?: UpdateWorkspaceOptions,
  ) => {
    applyCommands(
      [
        {
          type: 'set-node-bounds',
          nodeId,
          bounds,
        },
      ],
      {
        ...options,
        debugSource: options?.debugSource ?? 'setNodeBounds',
        persistImmediately: options?.persistImmediately ?? true,
      },
    );
  }, [applyCommands]);

  const applyCameraPreset = useCallback((presetId: string) => {
    const preset = workspaceRef.current?.cameraPresets.find(
      (candidate) => candidate.id === presetId,
    );

    if (!preset) {
      return;
    }

    applyCommands(
      [
        {
          type: 'set-viewport',
          viewport: preset.viewport,
        },
      ],
      {
        debugSource: 'applyCameraPreset',
      },
    );
  }, [applyCommands]);

  const saveViewportToPreset = useCallback((presetId: string) => {
    applyCommands(
      [
        {
          type: 'save-viewport-to-preset',
          presetId,
        },
      ],
      {
        debugSource: 'saveViewportToPreset',
        persistImmediately: true,
      },
    );
  }, [applyCommands]);

  const setLayoutMode = useCallback((layoutMode: WorkspaceLayoutMode) => {
    applyCommands(
      [
        {
          type: 'set-layout-mode',
          layoutMode,
        },
      ],
      {
        debugSource: 'setLayoutMode',
        persistImmediately: true,
      },
    );
  }, [applyCommands]);

  return {
    workspace,
    persistence,
    replaceWorkspace,
    refreshWorkspaceFromServer,
    applyCommands,
    addTerminal,
    addMarkdown,
    updateTerminal,
    removeTerminal,
    removeMarkdown,
    setViewport,
    setNodeBounds,
    applyCameraPreset,
    saveViewportToPreset,
    setLayoutMode,
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
