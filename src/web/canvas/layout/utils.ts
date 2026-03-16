import type {
  LayoutSafeAreaInsets,
  LayoutViewportSize,
  NodeBounds,
} from './types';
import type { CameraViewport } from '../../../shared/workspace';

export type WorldRect = NodeBounds;

export function createBoundsByNodeId(
  nodes: readonly {
    id: string;
    bounds: NodeBounds;
  }[],
): Map<string, NodeBounds> {
  return new Map(
    nodes.map((node) => [
      node.id,
      {
        ...node.bounds,
      },
    ]),
  );
}

export function sortNodeIdsByRecency(options: {
  nodeIds: readonly string[];
  interactionAtByNodeId: Readonly<Record<string, number>>;
  orderByNodeId: ReadonlyMap<string, number>;
}): string[] {
  const { nodeIds, interactionAtByNodeId, orderByNodeId } = options;

  return [...nodeIds].sort((leftId, rightId) => {
    const leftInteractionAt =
      interactionAtByNodeId[leftId] ?? Number.NEGATIVE_INFINITY;
    const rightInteractionAt =
      interactionAtByNodeId[rightId] ?? Number.NEGATIVE_INFINITY;

    if (leftInteractionAt !== rightInteractionAt) {
      return rightInteractionAt - leftInteractionAt;
    }

    return (
      (orderByNodeId.get(leftId) ?? Number.MAX_SAFE_INTEGER) -
      (orderByNodeId.get(rightId) ?? Number.MAX_SAFE_INTEGER)
    );
  });
}

export function createSafeAreaWorldRect(options: {
  viewport: CameraViewport;
  viewportSize: LayoutViewportSize;
  insets: LayoutSafeAreaInsets;
}): WorldRect | null {
  const { viewport, viewportSize, insets } = options;
  const zoom = viewport.zoom;

  if (zoom <= 0 || viewportSize.width <= 0 || viewportSize.height <= 0) {
    return null;
  }

  const left = clamp(insets.left, 0, viewportSize.width);
  const right = clamp(insets.right, 0, viewportSize.width);
  const top = clamp(insets.top, 0, viewportSize.height);
  const bottom = clamp(insets.bottom, 0, viewportSize.height);
  const width = Math.max(120, viewportSize.width - left - right);
  const height = Math.max(120, viewportSize.height - top - bottom);

  return {
    x: (left - viewport.x) / zoom,
    y: (top - viewport.y) / zoom,
    width: width / zoom,
    height: height / zoom,
  };
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
