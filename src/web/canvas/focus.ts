import type { RefObject } from 'react';

import type { CameraViewport, TerminalNode, Workspace } from '../../shared/workspace';

const MIN_FOCUS_TERMINAL_WIDTH = 560;
const MIN_FOCUS_TERMINAL_HEIGHT = 385;
const MIN_FOCUS_MARKDOWN_WIDTH = 640;
const MIN_FOCUS_MARKDOWN_HEIGHT = 420;
const FOCUS_CAMERA_TRANSITION_MS = 240;
const FOCUS_INPUT_SETTLE_MS = 90;

interface FocusableCanvasNode {
  id: string;
  bounds: {
    x: number;
    y: number;
    width: number;
    height: number;
  };
}

export function focusTerminalWithTransition(options: {
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
  const focusTarget = ensureFocusTargetSize({
    node: terminal,
    updateWorkspace,
    kind: 'terminal',
  });
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

export function focusMarkdownWithTransition(options: {
  markdown: FocusableCanvasNode;
  startViewport: CameraViewport;
  updateWorkspace: (
    updater: (workspace: Workspace) => Workspace,
  ) => Workspace | null;
  onSelectMarkdown: (markdownId: string) => void;
  onViewportChange: (viewport: CameraViewport) => void;
  animationFrameRef: RefObject<number | null>;
}): void {
  const {
    markdown,
    startViewport,
    updateWorkspace,
    onSelectMarkdown,
    onViewportChange,
    animationFrameRef,
  } = options;
  const focusTarget = ensureFocusTargetSize({
    node: markdown,
    updateWorkspace,
    kind: 'markdown',
  });
  const targetViewport = createFocusViewport(focusTarget, startViewport);

  onSelectMarkdown(markdown.id);
  animateViewportTransition({
    from: startViewport,
    to: targetViewport,
    durationMs: shouldAnimateViewport(startViewport, targetViewport)
      ? FOCUS_CAMERA_TRANSITION_MS
      : 0,
    onFrame: onViewportChange,
    animationFrameRef,
  });
}

export function cancelViewportAnimation(
  animationFrameRef: RefObject<number | null>,
): void {
  if (animationFrameRef.current === null) {
    return;
  }

  window.cancelAnimationFrame(animationFrameRef.current);
  animationFrameRef.current = null;
}

function ensureFocusTargetSize(options: {
  node: FocusableCanvasNode;
  kind: 'terminal' | 'markdown';
  updateWorkspace: (
    updater: (workspace: Workspace) => Workspace,
  ) => Workspace | null,
}): FocusableCanvasNode {
  const { node, kind, updateWorkspace } = options;
  const minWidth =
    kind === 'terminal' ? MIN_FOCUS_TERMINAL_WIDTH : MIN_FOCUS_MARKDOWN_WIDTH;
  const minHeight =
    kind === 'terminal' ? MIN_FOCUS_TERMINAL_HEIGHT : MIN_FOCUS_MARKDOWN_HEIGHT;

  if (
    node.bounds.width >= minWidth &&
    node.bounds.height >= minHeight
  ) {
    return node;
  }

  const resizedWorkspace = updateWorkspace((current) => ({
    ...current,
    terminals:
      kind === 'terminal'
        ? current.terminals.map((candidate) =>
            candidate.id === node.id
              ? {
                  ...candidate,
                  bounds: {
                    ...candidate.bounds,
                    width: Math.max(candidate.bounds.width, minWidth),
                    height: Math.max(candidate.bounds.height, minHeight),
                  },
                }
              : candidate,
          )
        : current.terminals,
    markdown:
      kind === 'markdown'
        ? current.markdown.map((candidate) =>
            candidate.id === node.id
              ? {
                  ...candidate,
                  bounds: {
                    ...candidate.bounds,
                    width: Math.max(candidate.bounds.width, minWidth),
                    height: Math.max(candidate.bounds.height, minHeight),
                  },
                }
              : candidate,
          )
        : current.markdown,
  }));

  return (
    (kind === 'terminal'
      ? resizedWorkspace?.terminals.find((candidate) => candidate.id === node.id)
      : resizedWorkspace?.markdown.find((candidate) => candidate.id === node.id)) ??
    {
      ...node,
      bounds: {
        ...node.bounds,
        width: Math.max(node.bounds.width, minWidth),
        height: Math.max(node.bounds.height, minHeight),
      },
    }
  );
}

function createFocusViewport(
  node: FocusableCanvasNode,
  currentViewport: CameraViewport,
): CameraViewport {
  const zoom = clamp(currentViewport.zoom, 1.12, 1.32);
  const estimatedCanvasWidth = 1080;
  const estimatedCanvasHeight = 720;
  const centerX = node.bounds.x + node.bounds.width / 2;
  const centerY = node.bounds.y + node.bounds.height / 2;

  return {
    x: estimatedCanvasWidth / 2 - centerX * zoom,
    y: estimatedCanvasHeight / 2 - centerY * zoom,
    zoom,
  };
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
