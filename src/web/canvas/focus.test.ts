/** @vitest-environment jsdom */

import type { RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createPlaceholderMarkdown,
  createPlaceholderTerminal,
  type CameraViewport,
} from '../../shared/workspace';
import {
  focusMarkdownWithTransition,
  focusTerminalWithTransition,
} from './focus';

describe('focus helpers', () => {
  let animationFrameCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    animationFrameCallbacks = [];
    vi.spyOn(performance, 'now').mockReturnValue(0);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      animationFrameCallbacks.push(callback);
      return animationFrameCallbacks.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('focuses a small terminal without inflating its bounds before centering it', () => {
    const terminal = createPlaceholderTerminal(0);
    const onSelectTerminal = vi.fn();
    const onAutoFocusAtChange = vi.fn();
    const onViewportChange = vi.fn();
    const animationFrameRef = { current: null } as RefObject<number | null>;
    const startViewport: CameraViewport = { x: 0, y: 0, zoom: 0.72 };

    focusTerminalWithTransition({
      terminal,
      startViewport,
      canvasSize: { width: 1280, height: 720 },
      onSelectTerminal,
      onAutoFocusAtChange,
      onViewportChange,
      animationFrameRef,
    });

    flushAnimationFrame(animationFrameCallbacks, 1_000);

    const finalViewport = readLastViewport(onViewportChange);

    expect(onSelectTerminal).toHaveBeenCalledWith(terminal.id);
    expect(onAutoFocusAtChange).toHaveBeenCalledWith(330);
    expect(finalViewport.zoom).toBeCloseTo(1.12);
    expect(finalViewport.x).toBeCloseTo(326.4);
    expect(finalViewport.y).toBeCloseTo(113.6);
    expect(animationFrameRef.current).toBeNull();
  });

  it('focuses markdown using the measured canvas size instead of a fixed estimate', () => {
    const markdown = createPlaceholderMarkdown(0);
    const onSelectMarkdown = vi.fn();
    const onViewportChange = vi.fn();
    const animationFrameRef = { current: null } as RefObject<number | null>;
    const startViewport: CameraViewport = { x: 0, y: 0, zoom: 1.2 };

    focusMarkdownWithTransition({
      markdown,
      startViewport,
      canvasSize: { width: 1600, height: 900 },
      onSelectMarkdown,
      onViewportChange,
      animationFrameRef,
    });

    flushAnimationFrame(animationFrameCallbacks, 1_000);

    const finalViewport = readLastViewport(onViewportChange);

    expect(onSelectMarkdown).toHaveBeenCalledWith(markdown.id);
    expect(finalViewport.zoom).toBeCloseTo(1.2);
    expect(finalViewport.x).toBeCloseTo(368);
    expect(finalViewport.y).toBeCloseTo(132);
    expect(animationFrameRef.current).toBeNull();
  });
});

function flushAnimationFrame(
  callbacks: FrameRequestCallback[],
  now: number,
): void {
  const callback = callbacks.shift();

  if (!callback) {
    throw new Error('Expected a scheduled animation frame.');
  }

  callback(now);
}

function readLastViewport(
  onViewportChange: ReturnType<typeof vi.fn>,
): CameraViewport {
  const lastCall = onViewportChange.mock.calls.at(-1)?.[0] as
    | CameraViewport
    | undefined;

  if (!lastCall) {
    throw new Error('Expected at least one viewport update.');
  }

  return lastCall;
}
