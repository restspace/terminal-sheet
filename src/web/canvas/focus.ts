import type { RefObject } from 'react';

import type { CameraViewport, TerminalNode } from '../../shared/workspace';

const FOCUS_CAMERA_TRANSITION_MS = 240;
const FOCUS_INPUT_SETTLE_MS = 90;

interface CanvasViewportSize {
  width: number;
  height: number;
}

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
  canvasSize: CanvasViewportSize;
  onSelectTerminal: (terminalId: string) => void;
  onAutoFocusAtChange: (autoFocusAtMs: number | null) => void;
  onViewportChange: (viewport: CameraViewport) => void;
  animationFrameRef: RefObject<number | null>;
}): void {
  const {
    terminal,
    startViewport,
    canvasSize,
    onSelectTerminal,
    onAutoFocusAtChange,
    onViewportChange,
    animationFrameRef,
  } = options;
  const targetViewport = createFocusViewport(terminal, startViewport, canvasSize);
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
  canvasSize: CanvasViewportSize;
  onSelectMarkdown: (markdownId: string) => void;
  onViewportChange: (viewport: CameraViewport) => void;
  animationFrameRef: RefObject<number | null>;
}): void {
  const {
    markdown,
    startViewport,
    canvasSize,
    onSelectMarkdown,
    onViewportChange,
    animationFrameRef,
  } = options;
  const targetViewport = createFocusViewport(markdown, startViewport, canvasSize);

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

function createFocusViewport(
  node: FocusableCanvasNode,
  currentViewport: CameraViewport,
  canvasSize: CanvasViewportSize,
): CameraViewport {
  if (!hasCanvasViewportSize(canvasSize)) {
    return currentViewport;
  }

  const zoom = clamp(currentViewport.zoom, 1.12, 1.32);
  const centerX = node.bounds.x + node.bounds.width / 2;
  const centerY = node.bounds.y + node.bounds.height / 2;

  return {
    x: canvasSize.width / 2 - centerX * zoom,
    y: canvasSize.height / 2 - centerY * zoom,
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

function hasCanvasViewportSize(canvasSize: CanvasViewportSize): boolean {
  return canvasSize.width > 0 && canvasSize.height > 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
