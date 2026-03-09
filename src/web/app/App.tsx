import { type RefObject, useEffect, useRef, useState } from 'react';

import type {
  CameraViewport,
  CreateTerminalNodeInput,
  TerminalNode,
  Workspace,
} from '../../shared/workspace';
import { getSemanticZoomMode } from '../../shared/workspace';
import { WorkspaceCanvas } from '../canvas/WorkspaceCanvas';
import { EventFeed } from '../event-feed/EventFeed';
import { useTerminalSessions } from '../state/useTerminalSessions';
import { useWorkspace } from '../state/useWorkspace';

interface HealthState {
  status: string;
  port: number;
  workspacePath: string;
  devMode: boolean;
  liveSessions: number;
  timestamp: string;
}

const MIN_FOCUS_TERMINAL_WIDTH = 560;
const MIN_FOCUS_TERMINAL_HEIGHT = 385;
const FOCUS_CAMERA_TRANSITION_MS = 240;
const FOCUS_INPUT_SETTLE_MS = 90;

export function App() {
  const {
    workspace,
    persistence,
    updateWorkspace,
    addTerminal,
    addMarkdown,
    setViewport,
    applyCameraPreset,
    saveViewportToPreset,
  } = useWorkspace();
  const {
    sessions,
    socketState,
    sendInput,
    resizeSession,
    restartSession,
    markSessionRead,
  } = useTerminalSessions();
  const [health, setHealth] = useState<HealthState | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [activePresetId, setActivePresetId] = useState<string | null>(null);
  const [focusAutoFocusAtMs, setFocusAutoFocusAtMs] = useState<number | null>(
    null,
  );
  const viewportAnimationFrameRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      cancelViewportAnimation(viewportAnimationFrameRef);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadHealth() {
      try {
        const response = await fetch('/api/health');

        if (!response.ok) {
          throw new Error(`Health check failed with ${response.status}`);
        }

        const nextHealth = (await response.json()) as HealthState;

        if (!cancelled) {
          setHealth(nextHealth);
        }
      } catch (error) {
        if (!cancelled) {
          const message =
            error instanceof Error ? error.message : 'Unknown error';
          setHealthError(message);
        }
      }
    }

    void loadHealth();

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
    if (!workspace || selectedNodeId) {
      return;
    }

    if (
      getSemanticZoomMode(workspace.currentViewport.zoom) === 'focus' &&
      workspace.terminals.length === 1
    ) {
      const terminal = workspace.terminals[0];

      if (!terminal) {
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
    }
  }, [selectedNodeId, setViewport, updateWorkspace, workspace]);

  if (!workspace) {
    return (
      <div className="app-shell">
        <header className="topbar">
          <div>
            <p className="eyebrow">Milestone 3</p>
            <h1>Terminal Canvas</h1>
          </div>
        </header>

        <main className="workspace-layout">
          <section className="workspace-panel workspace-panel-loading">
            <p className="eyebrow">Workspace</p>
            <h2>Loading persisted workspace...</h2>
            <p>
              {persistence.error ??
                'Fetching the saved layout from the local server.'}
            </p>
          </section>
        </main>
      </div>
    );
  }

  const terminals = workspace.terminals;
  const currentViewport = workspace.currentViewport;
  const semanticMode = getSemanticZoomMode(currentViewport.zoom);

  function focusTerminal(terminalId: string) {
    const terminal = terminals.find((candidate) => candidate.id === terminalId);

    if (!terminal) {
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
  }

  function launchTerminal(input: CreateTerminalNodeInput) {
    const createdTerminal = addTerminal(input, { persistImmediately: true });

    if (!createdTerminal) {
      return;
    }

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

  function handleSelectedNodeChange(nodeId: string | null) {
    if (
      nodeId === null &&
      semanticMode === 'focus' &&
      terminals.length === 1 &&
      terminals[0]
    ) {
      setSelectedNodeId(terminals[0].id);
      return;
    }

    setSelectedNodeId(nodeId);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">Milestone 3</p>
          <h1>Terminal Canvas</h1>
        </div>
        <div className="topbar-actions">
          <button type="button" onClick={addMarkdown}>
            Add Markdown
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
      </header>

      <main className="workspace-layout">
        <section className="workspace-panel">
          <div className="panel-meta">
            <div>
              <span className="meta-label">Workspace</span>
              <strong>{workspace.name}</strong>
            </div>
            <div>
              <span className="meta-label">Zoom mode</span>
              <strong>{semanticMode}</strong>
            </div>
            <div>
              <span className="meta-label">Persistence</span>
              <strong>{persistence.phase}</strong>
            </div>
          </div>

          <div className="preset-strip">
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

          <WorkspaceCanvas
            workspace={workspace}
            healthError={healthError}
            selectedNodeId={selectedNodeId}
            sessions={sessions}
            socketState={socketState}
            onTerminalInput={sendInput}
            onTerminalResize={resizeSession}
            onTerminalRestart={restartSession}
            onMarkTerminalRead={markSessionRead}
            onSelectedNodeChange={handleSelectedNodeChange}
            onTerminalFocusRequest={focusTerminal}
            onWorkspaceChange={updateWorkspace}
            onViewportChange={setViewport}
            focusAutoFocusAtMs={focusAutoFocusAtMs}
          />
        </section>

        <EventFeed
          health={health}
          healthError={healthError}
          persistence={persistence}
          workspace={workspace}
          sessions={sessions}
          socketState={socketState}
          activePresetId={activePresetId}
          selectedNodeId={selectedNodeId}
          onLaunchTerminal={launchTerminal}
        />
      </main>
    </div>
  );
}

function focusTerminalWithTransition(options: {
  terminal: TerminalNode;
  startViewport: CameraViewport;
  updateWorkspace: (
    updater: (workspace: Workspace) => Workspace,
  ) => Workspace | null;
  onSelectTerminal: (terminalId: string) => void;
  onAutoFocusAtChange: (autoFocusAtMs: number | null) => void;
  onViewportChange: (viewport: CameraViewport) => void;
  animationFrameRef: RefObject<number | null>;
}): void {
  const {
    terminal,
    startViewport,
    updateWorkspace,
    onSelectTerminal,
    onAutoFocusAtChange,
    onViewportChange,
    animationFrameRef,
  } = options;
  const focusTarget = ensureFocusTargetSize(terminal, updateWorkspace);
  const targetViewport = createFocusViewport(focusTarget, startViewport);
  const transitionDuration = shouldAnimateViewport(
    startViewport,
    targetViewport,
  )
    ? FOCUS_CAMERA_TRANSITION_MS
    : 0;

  onSelectTerminal(terminal.id);
  onAutoFocusAtChange(
    performance.now() + transitionDuration + FOCUS_INPUT_SETTLE_MS,
  );
  animateViewportTransition({
    from: startViewport,
    to: targetViewport,
    durationMs: transitionDuration,
    onFrame: onViewportChange,
    animationFrameRef,
  });
}

function ensureFocusTargetSize(
  terminal: TerminalNode,
  updateWorkspace: (
    updater: (workspace: Workspace) => Workspace,
  ) => Workspace | null,
): TerminalNode {
  if (
    terminal.bounds.width >= MIN_FOCUS_TERMINAL_WIDTH &&
    terminal.bounds.height >= MIN_FOCUS_TERMINAL_HEIGHT
  ) {
    return terminal;
  }

  const resizedWorkspace = updateWorkspace((current) => ({
    ...current,
    terminals: current.terminals.map((candidate) =>
      candidate.id === terminal.id
        ? {
            ...candidate,
            bounds: {
              ...candidate.bounds,
              width: Math.max(candidate.bounds.width, MIN_FOCUS_TERMINAL_WIDTH),
              height: Math.max(
                candidate.bounds.height,
                MIN_FOCUS_TERMINAL_HEIGHT,
              ),
            },
          }
        : candidate,
    ),
  }));

  return (
    resizedWorkspace?.terminals.find(
      (candidate) => candidate.id === terminal.id,
    ) ?? {
      ...terminal,
      bounds: {
        ...terminal.bounds,
        width: Math.max(terminal.bounds.width, MIN_FOCUS_TERMINAL_WIDTH),
        height: Math.max(terminal.bounds.height, MIN_FOCUS_TERMINAL_HEIGHT),
      },
    }
  );
}

function createFocusViewport(
  terminal: TerminalNode,
  currentViewport: CameraViewport,
): CameraViewport {
  const zoom = clamp(currentViewport.zoom, 1.12, 1.32);
  const estimatedCanvasWidth = 1080;
  const estimatedCanvasHeight = 720;
  const centerX = terminal.bounds.x + terminal.bounds.width / 2;
  const centerY = terminal.bounds.y + terminal.bounds.height / 2;

  return {
    x: estimatedCanvasWidth / 2 - centerX * zoom,
    y: estimatedCanvasHeight / 2 - centerY * zoom,
    zoom,
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function animateViewportTransition(options: {
  from: CameraViewport;
  to: CameraViewport;
  durationMs: number;
  onFrame: (viewport: CameraViewport) => void;
  animationFrameRef: RefObject<number | null>;
}): void {
  const { from, to, durationMs, onFrame, animationFrameRef } = options;
  cancelViewportAnimation(animationFrameRef);

  if (durationMs <= 0 || !shouldAnimateViewport(from, to)) {
    onFrame(to);
    return;
  }

  const startedAt = performance.now();

  const tick = (now: number) => {
    const progress = clamp((now - startedAt) / durationMs, 0, 1);
    const easedProgress = easeInOutCubic(progress);

    onFrame(interpolateViewport(from, to, easedProgress));

    if (progress < 1) {
      animationFrameRef.current = window.requestAnimationFrame(tick);
      return;
    }

    animationFrameRef.current = null;
    onFrame(to);
  };

  animationFrameRef.current = window.requestAnimationFrame(tick);
}

function cancelViewportAnimation(
  animationFrameRef: RefObject<number | null>,
): void {
  if (animationFrameRef.current === null) {
    return;
  }

  window.cancelAnimationFrame(animationFrameRef.current);
  animationFrameRef.current = null;
}

function shouldAnimateViewport(
  from: CameraViewport,
  to: CameraViewport,
): boolean {
  return (
    Math.abs(from.x - to.x) > 1 ||
    Math.abs(from.y - to.y) > 1 ||
    Math.abs(from.zoom - to.zoom) > 0.01
  );
}

function interpolateViewport(
  from: CameraViewport,
  to: CameraViewport,
  progress: number,
): CameraViewport {
  return {
    x: from.x + (to.x - from.x) * progress,
    y: from.y + (to.y - from.y) * progress,
    zoom: from.zoom + (to.zoom - from.zoom) * progress,
  };
}

function easeInOutCubic(progress: number): number {
  return progress < 0.5
    ? 4 * progress * progress * progress
    : 1 - Math.pow(-2 * progress + 2, 3) / 2;
}
