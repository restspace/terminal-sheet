import { startTransition, useEffect, useRef, useState } from 'react';

import {
  createTerminalNode,
  createPlaceholderMarkdown,
  type CreateTerminalNodeInput,
  type TerminalNode,
  type TerminalNodePatch,
  touchWorkspace,
  type CameraViewport,
  updateTerminalNode,
  type Workspace,
} from '../../shared/workspace';
import { fetchWorkspace, persistWorkspace } from './workspaceClient';

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
  const lastSavedSnapshotRef = useRef<string>('');
  const hasLoadedRef = useRef(false);
  const workspaceRef = useRef<Workspace | null>(null);
  const skipAutosaveSnapshotRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadWorkspace() {
      try {
        const loadedWorkspace = await fetchWorkspace();

        if (cancelled) {
          return;
        }

        lastSavedSnapshotRef.current = JSON.stringify(loadedWorkspace);
        hasLoadedRef.current = true;
        workspaceRef.current = loadedWorkspace;

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
    };
  }, []);

  useEffect(() => {
    if (!workspace || !hasLoadedRef.current) {
      return;
    }

    const snapshot = JSON.stringify(workspace);

    if (skipAutosaveSnapshotRef.current === snapshot) {
      skipAutosaveSnapshotRef.current = null;
      return;
    }

    if (snapshot === lastSavedSnapshotRef.current) {
      return;
    }

    const saveTimer = window.setTimeout(async () => {
      setPersistence((current) => ({
        ...current,
        phase: 'saving',
        error: null,
      }));

      try {
        await persistWorkspace(workspace);
        lastSavedSnapshotRef.current = snapshot;

        setPersistence({
          phase: 'saved',
          error: null,
          lastSavedAt: workspace.updatedAt,
        });
      } catch (error) {
        setPersistence({
          phase: 'error',
          error: error instanceof Error ? error.message : 'Unknown error',
          lastSavedAt: null,
        });
      }
    }, 450);

    return () => {
      window.clearTimeout(saveTimer);
    };
  }, [workspace]);

  function updateWorkspace(
    updater: WorkspaceUpdater,
    options?: UpdateWorkspaceOptions,
  ): Workspace | null {
    const currentWorkspace = workspaceRef.current;

    if (!currentWorkspace) {
      return null;
    }

    const nextWorkspace = updater(currentWorkspace);

    if (nextWorkspace === currentWorkspace) {
      return currentWorkspace;
    }

    const touchedWorkspace = touchWorkspace(nextWorkspace);
    const snapshot = JSON.stringify(touchedWorkspace);

    workspaceRef.current = touchedWorkspace;

    startTransition(() => {
      setWorkspace(touchedWorkspace);
    });

    if (options?.persistImmediately) {
      skipAutosaveSnapshotRef.current = snapshot;
      void saveWorkspaceImmediately(touchedWorkspace, snapshot);
    }

    return touchedWorkspace;
  }

  function addTerminal(
    input?: Partial<CreateTerminalNodeInput>,
    options?: UpdateWorkspaceOptions,
  ): TerminalNode | null {
    let createdTerminal: TerminalNode | null = null;

    updateWorkspace((current) => {
      createdTerminal = createTerminalNode(
        {
          label:
            input?.label?.trim() || `Shell ${current.terminals.length + 1}`,
          shell: input?.shell?.trim() || defaultShell(),
          cwd: input?.cwd?.trim() || '.',
          agentType: input?.agentType ?? 'shell',
          repoLabel: input?.repoLabel?.trim() || 'local workspace',
          taskLabel: input?.taskLabel?.trim() || 'live terminal session',
          tags: input?.tags ?? [],
        },
        current.terminals.length,
        current.currentViewport,
      );

      return {
        ...current,
        terminals: [...current.terminals, createdTerminal],
      };
    }, options);

    return createdTerminal;
  }

  function addMarkdown() {
    updateWorkspace((current) => ({
      ...current,
      markdown: [
        ...current.markdown,
        createPlaceholderMarkdown(
          current.markdown.length,
          current.currentViewport,
        ),
      ],
    }));
  }

  function updateTerminal(terminalId: string, patch: TerminalNodePatch) {
    updateWorkspace((current) =>
      updateTerminalNode(current, terminalId, patch),
    );
  }

  function setViewport(viewport: CameraViewport) {
    updateWorkspace((current) => {
      if (sameViewport(current.currentViewport, viewport)) {
        return current;
      }

      return {
        ...current,
        currentViewport: viewport,
      };
    });
  }

  function applyCameraPreset(presetId: string) {
    updateWorkspace((current) => {
      const preset = current.cameraPresets.find(
        (candidate) => candidate.id === presetId,
      );

      if (!preset) {
        return current;
      }

      return {
        ...current,
        currentViewport: preset.viewport,
      };
    });
  }

  function saveViewportToPreset(presetId: string) {
    updateWorkspace((current) => ({
      ...current,
      cameraPresets: current.cameraPresets.map((preset) =>
        preset.id === presetId
          ? { ...preset, viewport: current.currentViewport }
          : preset,
      ),
    }));
  }

  async function saveWorkspaceImmediately(
    nextWorkspace: Workspace,
    snapshot: string,
  ) {
    setPersistence((current) => ({
      ...current,
      phase: 'saving',
      error: null,
    }));

    try {
      const savedWorkspace = await persistWorkspace(nextWorkspace);
      const currentSnapshot = workspaceRef.current
        ? JSON.stringify(workspaceRef.current)
        : '';

      if (currentSnapshot !== snapshot) {
        lastSavedSnapshotRef.current = snapshot;

        setPersistence({
          phase: 'saved',
          error: null,
          lastSavedAt: savedWorkspace.updatedAt,
        });

        return;
      }

      workspaceRef.current = savedWorkspace;
      lastSavedSnapshotRef.current = JSON.stringify(savedWorkspace);

      startTransition(() => {
        setWorkspace(savedWorkspace);
      });

      setPersistence({
        phase: 'saved',
        error: null,
        lastSavedAt: savedWorkspace.updatedAt,
      });
    } catch (error) {
      if (skipAutosaveSnapshotRef.current === snapshot) {
        skipAutosaveSnapshotRef.current = null;
      }

      setPersistence({
        phase: 'error',
        error: error instanceof Error ? error.message : 'Unknown error',
        lastSavedAt: null,
      });
    }
  }

  return {
    workspace,
    persistence,
    updateWorkspace,
    addTerminal,
    addMarkdown,
    updateTerminal,
    setViewport,
    applyCameraPreset,
    saveViewportToPreset,
  };
}

function sameViewport(left: CameraViewport, right: CameraViewport): boolean {
  return (
    almostEqual(left.x, right.x) &&
    almostEqual(left.y, right.y) &&
    almostEqual(left.zoom, right.zoom)
  );
}

function almostEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.001;
}

function defaultShell(): string {
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Win')) {
    return 'powershell.exe';
  }

  return 'bash';
}
