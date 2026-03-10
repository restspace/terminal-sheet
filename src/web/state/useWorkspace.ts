import { startTransition, useCallback, useEffect, useRef, useState } from 'react';

import {
  type CreateTerminalNodeInput,
  type TerminalNode,
  type TerminalNodePatch,
  touchWorkspace,
  type CameraViewport,
  type Workspace,
} from '../../shared/workspace';
import { fetchWorkspace, persistWorkspace } from './workspaceClient';
import {
  addMarkdownToWorkspace,
  addTerminalToWorkspace,
  applyWorkspaceCameraPreset,
  removeTerminalFromWorkspace,
  saveWorkspaceViewportToPreset,
  setWorkspaceViewport,
  updateWorkspaceTerminal,
} from './workspaceActions';

export interface WorkspacePersistenceState {
  phase: 'loading' | 'saving' | 'saved' | 'error';
  error: string | null;
  lastSavedAt: string | null;
}

type WorkspaceUpdater = (workspace: Workspace) => Workspace;
interface UpdateWorkspaceOptions {
  persistImmediately?: boolean;
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

  useEffect(() => {
    let cancelled = false;

    async function loadWorkspace() {
      try {
        const loadedWorkspace = await fetchWorkspace();

        if (cancelled) {
          return;
        }

        hasLoadedRef.current = true;
        workspaceRef.current = loadedWorkspace;
        localRevisionRef.current = 0;
        lastSavedRevisionRef.current = 0;
        inFlightRevisionRef.current = null;

        startTransition(() => {
          setWorkspace(loadedWorkspace);
          setPersistence({
            phase: 'saved',
            error: null,
            lastSavedAt: loadedWorkspace.updatedAt,
          });
        });
      } catch (error) {
        if (cancelled) {
          return;
        }

        setPersistence({
          phase: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
          lastSavedAt: null,
        });
      }
    }

    void loadWorkspace();

    return () => {
      cancelled = true;
      clearAutosaveTimer(autosaveTimerRef);
    }
  }, []);

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

    setPersistence((current) => ({
      ...current,
      phase: 'saving',
      error: null,
    }));

    try {
      const savedWorkspace = await persistWorkspace(nextWorkspace);
      lastSavedRevisionRef.current = Math.max(
        lastSavedRevisionRef.current,
        revision,
      );

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
    } catch (error) {
      setPersistence((current) => ({
        phase: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        lastSavedAt: current.lastSavedAt,
      }));
    } finally {
      inFlightRevisionRef.current = null;

      if (localRevisionRef.current > lastSavedRevisionRef.current) {
        schedulePersist(autosaveTimerRef, persistCurrentWorkspace, 0);
      }
    }
  }, []);

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

    startTransition(() => {
      setWorkspace(touchedWorkspace);
    });

    if (options?.persistImmediately) {
      schedulePersist(autosaveTimerRef, persistCurrentWorkspace, 0);
    } else {
      schedulePersist(autosaveTimerRef, persistCurrentWorkspace, 450);
    }

    return touchedWorkspace;
  }, [persistCurrentWorkspace]);

  const addTerminal = useCallback((
    input?: Partial<CreateTerminalNodeInput>,
    options?: UpdateWorkspaceOptions,
  ): TerminalNode | null => {
    let createdTerminal: TerminalNode | null = null;

    updateWorkspace((current) => {
      const nextState = addTerminalToWorkspace(current, input);
      createdTerminal = nextState.terminal;
      return nextState.workspace;
    }, options);

    return createdTerminal;
  }, [updateWorkspace]);

  const addMarkdown = useCallback(() => {
    updateWorkspace(addMarkdownToWorkspace);
  }, [updateWorkspace]);

  const updateTerminal = useCallback((terminalId: string, patch: TerminalNodePatch) => {
    updateWorkspace((current) => updateWorkspaceTerminal(current, terminalId, patch));
  }, [updateWorkspace]);

  const removeTerminal = useCallback((
    terminalId: string,
    options?: UpdateWorkspaceOptions,
  ) => {
    updateWorkspace(
      (current) => removeTerminalFromWorkspace(current, terminalId),
      options,
    );
  }, [updateWorkspace]);

  const setViewport = useCallback((viewport: CameraViewport) => {
    updateWorkspace((current) => setWorkspaceViewport(current, viewport));
  }, [updateWorkspace]);

  const applyCameraPreset = useCallback((presetId: string) => {
    updateWorkspace((current) => applyWorkspaceCameraPreset(current, presetId));
  }, [updateWorkspace]);

  const saveViewportToPreset = useCallback((presetId: string) => {
    updateWorkspace((current) => saveWorkspaceViewportToPreset(current, presetId));
  }, [updateWorkspace]);

  return {
    workspace,
    persistence,
    updateWorkspace,
    addTerminal,
    addMarkdown,
    updateTerminal,
    removeTerminal,
    setViewport,
    applyCameraPreset,
    saveViewportToPreset,
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
