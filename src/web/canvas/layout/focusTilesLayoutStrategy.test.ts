import { describe, expect, it } from 'vitest';

import { focusTilesLayoutStrategy } from './focusTilesLayoutStrategy';

describe('focusTilesLayoutStrategy', () => {
  it('places the selected node in the center and the next four recent nodes in side slots on entry', () => {
    const nodes = createNodes(['a', 'b', 'c', 'd', 'e', 'f']);
    const result = focusTilesLayoutStrategy.compute({
      mode: 'focus-tiles',
      nodes,
      selectedNodeId: 'a',
      interactionAtByNodeId: {
        b: 100,
        c: 90,
        d: 80,
        e: 70,
        f: 60,
        a: 50,
      },
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 1200, height: 800 },
      safeAreaInsets: { top: 100, right: 200, bottom: 80, left: 20 },
      previousState: null,
      previousMode: 'free',
    });
    const state = result.nextState as {
      centerNodeId: string | null;
      sideNodeIds: [string | null, string | null, string | null, string | null];
    };

    expect(state.centerNodeId).toBe('a');
    expect(state.sideNodeIds).toEqual(['b', 'c', 'd', 'e']);
    expect(result.interactionPolicy).toEqual({
      nodesDraggable: false,
      nodesResizable: false,
    });
    expect(result.animation?.durationMs).toBe(1_500);
  });

  it('uses a wide focus tile across left+center when there are two side nodes', () => {
    const result = focusTilesLayoutStrategy.compute({
      mode: 'focus-tiles',
      nodes: createNodes(['focus', 'one', 'two']),
      selectedNodeId: 'focus',
      interactionAtByNodeId: {
        one: 100,
        two: 90,
        focus: 80,
      },
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 1200, height: 800 },
      safeAreaInsets: { top: 100, right: 200, bottom: 80, left: 20 },
      previousState: null,
      previousMode: 'free',
    });
    const focusBounds = expectBounds(result.boundsByNodeId, 'focus');
    const firstSideBounds = expectBounds(result.boundsByNodeId, 'one');
    const secondSideBounds = expectBounds(result.boundsByNodeId, 'two');

    expect(focusBounds.x).toBeLessThan(firstSideBounds.x);
    expect(focusBounds.width).toBeGreaterThan(firstSideBounds.width * 1.9);
    expect(firstSideBounds.x).toBeCloseTo(secondSideBounds.x);
    expect(firstSideBounds.y).toBeLessThan(secondSideBounds.y);
    expect(focusBounds.height).toBeGreaterThan(firstSideBounds.height * 1.9);
  });

  it('places two most recent side nodes on the left and least recent on the right for four side nodes', () => {
    const result = focusTilesLayoutStrategy.compute({
      mode: 'focus-tiles',
      nodes: createNodes(['focus', 'one', 'two', 'three', 'four']),
      selectedNodeId: 'focus',
      interactionAtByNodeId: {
        one: 100,
        two: 90,
        three: 80,
        four: 70,
        focus: 60,
      },
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 1200, height: 800 },
      safeAreaInsets: { top: 100, right: 200, bottom: 80, left: 20 },
      previousState: null,
      previousMode: 'free',
    });
    const focusBounds = expectBounds(result.boundsByNodeId, 'focus');
    const oneBounds = expectBounds(result.boundsByNodeId, 'one');
    const twoBounds = expectBounds(result.boundsByNodeId, 'two');
    const threeBounds = expectBounds(result.boundsByNodeId, 'three');
    const fourBounds = expectBounds(result.boundsByNodeId, 'four');

    expect(oneBounds.x).toBeCloseTo(twoBounds.x);
    expect(oneBounds.y).toBeLessThan(twoBounds.y);
    expect(threeBounds.x).toBeCloseTo(fourBounds.x);
    expect(threeBounds.y).toBeLessThan(fourBounds.y);
    expect(focusBounds.x).toBeGreaterThan(oneBounds.x);
    expect(focusBounds.x).toBeLessThan(threeBounds.x);
  });

  it('swaps center and clicked side node in focus mode', () => {
    const nodes = createNodes(['a', 'b', 'c', 'd', 'e']);
    const previousState = {
      centerNodeId: 'a',
      sideNodeIds: ['b', 'c', 'd', 'e'],
    };
    const result = focusTilesLayoutStrategy.compute({
      mode: 'focus-tiles',
      nodes,
      selectedNodeId: 'c',
      interactionAtByNodeId: {
        a: 80,
        b: 70,
        c: 60,
        d: 50,
        e: 40,
      },
      viewport: { x: 0, y: 0, zoom: 1 },
      viewportSize: { width: 1200, height: 800 },
      safeAreaInsets: { top: 100, right: 200, bottom: 80, left: 20 },
      previousState,
      previousMode: 'focus-tiles',
    });
    const state = result.nextState as {
      centerNodeId: string | null;
      sideNodeIds: [string | null, string | null, string | null, string | null];
    };

    expect(state.centerNodeId).toBe('c');
    expect(state.sideNodeIds).toEqual(['b', 'a', 'd', 'e']);
    expect(result.animation?.durationMs).toBe(750);
  });
});

function createNodes(nodeIds: string[]) {
  return nodeIds.map((id, order) => ({
    id,
    order,
    bounds: {
      x: order * 50,
      y: 20,
      width: 320,
      height: 220,
    },
  }));
}

function expectBounds(
  boundsByNodeId: ReadonlyMap<
    string,
    {
      x: number;
      y: number;
      width: number;
      height: number;
    }
  >,
  nodeId: string,
) {
  const bounds = boundsByNodeId.get(nodeId);

  expect(bounds).toBeDefined();
  return bounds!;
}
