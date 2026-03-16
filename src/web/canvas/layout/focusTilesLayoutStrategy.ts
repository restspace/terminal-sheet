import type { LayoutStrategy, NodeBounds } from './types';
import {
  createBoundsByNodeId,
  createSafeAreaWorldRect,
  sortNodeIdsByRecency,
} from './utils';

const SIDE_SLOT_COUNT = 4;
const ENTER_DURATION_MS = 1_500;
const SWAP_DURATION_MS = 750;

type SideSlotIds = [string | null, string | null, string | null, string | null];

interface FocusTilesLayoutState {
  centerNodeId: string | null;
  sideNodeIds: SideSlotIds;
}

export const focusTilesLayoutStrategy: LayoutStrategy = {
  mode: 'focus-tiles',
  compute: (input) => {
    const { nodes, selectedNodeId, interactionAtByNodeId } = input;
    const boundsByNodeId = createBoundsByNodeId(nodes);
    const nodeIds = nodes.map((node) => node.id);
    const nodeIdSet = new Set(nodeIds);

    if (!nodeIds.length) {
      return {
        boundsByNodeId,
        interactionPolicy: {
          nodesDraggable: false,
          nodesResizable: false,
        },
        nextState: createInitialState(),
        animation: null,
      };
    }

    const orderByNodeId = new Map(nodes.map((node) => [node.id, node.order]));
    const orderedByRecency = sortNodeIdsByRecency({
      nodeIds,
      interactionAtByNodeId,
      orderByNodeId,
    });
    const isEntering = input.previousMode !== 'focus-tiles';
    const previousState = sanitizeState(input.previousState, nodeIdSet);
    const selectedId =
      selectedNodeId && nodeIdSet.has(selectedNodeId) ? selectedNodeId : null;
    const defaultCenterId = selectedId ?? orderedByRecency[0] ?? null;

    let centerNodeId = previousState?.centerNodeId ?? defaultCenterId;
    let sideNodeIds = previousState?.sideNodeIds ?? createEmptySideSlots();
    let animation: { key: string; durationMs: number } | null = null;

    if (!centerNodeId || !nodeIdSet.has(centerNodeId) || isEntering) {
      centerNodeId = defaultCenterId;
      sideNodeIds = fillSideSlots({
        sideNodeIds: createEmptySideSlots(),
        centerNodeId,
        orderedByRecency,
      });

      if (centerNodeId) {
        animation = {
          key: `enter:${centerNodeId}:${sideNodeIds.join('|')}`,
          durationMs: ENTER_DURATION_MS,
        };
      }
    } else if (selectedId && selectedId !== centerNodeId) {
      const sideIndex = sideNodeIds.indexOf(selectedId);

      if (sideIndex >= 0) {
        const previousCenterId = centerNodeId;
        const nextSideSlots = [...sideNodeIds] as SideSlotIds;
        nextSideSlots[sideIndex] = previousCenterId;
        centerNodeId = selectedId;
        sideNodeIds = fillSideSlots({
          sideNodeIds: nextSideSlots,
          centerNodeId,
          orderedByRecency,
        });
      } else {
        const previousCenterId = centerNodeId;
        centerNodeId = selectedId;
        sideNodeIds = fillSideSlots({
          sideNodeIds: [
            previousCenterId,
            sideNodeIds[0],
            sideNodeIds[1],
            sideNodeIds[2],
          ],
          centerNodeId,
          orderedByRecency,
        });
      }

      animation = {
        key: `swap:${centerNodeId}:${sideNodeIds.join('|')}`,
        durationMs: SWAP_DURATION_MS,
      };
    } else {
      sideNodeIds = fillSideSlots({
        sideNodeIds,
        centerNodeId,
        orderedByRecency,
      });
    }

    const safeAreaRect = createSafeAreaWorldRect({
      viewport: input.viewport,
      viewportSize: input.viewportSize,
      insets: input.safeAreaInsets,
    });

    if (safeAreaRect && centerNodeId) {
      const sideNodeCount = sideNodeIds.filter(isDefined).length;
      const slotBounds = createTileBounds(
        safeAreaRect,
        input.viewport.zoom,
        sideNodeCount,
      );

      boundsByNodeId.set(centerNodeId, slotBounds.center);
      sideNodeIds.forEach((nodeId, index) => {
        if (!nodeId) {
          return;
        }

        const sideBounds = slotBounds.sides[index] ?? null;

        if (!sideBounds) {
          return;
        }

        boundsByNodeId.set(nodeId, sideBounds);
      });
    }

    return {
      boundsByNodeId,
      interactionPolicy: {
        nodesDraggable: false,
        nodesResizable: false,
      },
      nextState: {
        centerNodeId,
        sideNodeIds,
      } satisfies FocusTilesLayoutState,
      animation,
    };
  },
};

function sanitizeState(
  value: unknown,
  nodeIdSet: ReadonlySet<string>,
): FocusTilesLayoutState | null {
  if (!value || typeof value !== 'object') {
    return null;
  }

  const candidate = value as {
    centerNodeId?: unknown;
    sideNodeIds?: unknown;
  };
  const centerNodeId =
    typeof candidate.centerNodeId === 'string' &&
    nodeIdSet.has(candidate.centerNodeId)
      ? candidate.centerNodeId
      : null;
  const rawSideNodeIds = Array.isArray(candidate.sideNodeIds)
    ? candidate.sideNodeIds
    : [];
  const sideNodeIds = createEmptySideSlots();

  for (let index = 0; index < SIDE_SLOT_COUNT; index += 1) {
    const rawNodeId = rawSideNodeIds[index];

    if (typeof rawNodeId !== 'string' || !nodeIdSet.has(rawNodeId)) {
      continue;
    }

    sideNodeIds[index] = rawNodeId;
  }

  return {
    centerNodeId,
    sideNodeIds,
  };
}

function createInitialState(): FocusTilesLayoutState {
  return {
    centerNodeId: null,
    sideNodeIds: createEmptySideSlots(),
  };
}

function createEmptySideSlots(): SideSlotIds {
  return [null, null, null, null];
}

function fillSideSlots(options: {
  sideNodeIds: SideSlotIds;
  centerNodeId: string | null;
  orderedByRecency: readonly string[];
}): SideSlotIds {
  const { centerNodeId, orderedByRecency } = options;
  const nextSideNodeIds = [...options.sideNodeIds] as SideSlotIds;
  const seenNodeIds = new Set<string>();

  if (centerNodeId) {
    seenNodeIds.add(centerNodeId);
  }

  for (let index = 0; index < SIDE_SLOT_COUNT; index += 1) {
    const nodeId = nextSideNodeIds[index];

    if (!nodeId || seenNodeIds.has(nodeId)) {
      nextSideNodeIds[index] = null;
      continue;
    }

    seenNodeIds.add(nodeId);
  }

  for (const nodeId of orderedByRecency) {
    if (seenNodeIds.has(nodeId)) {
      continue;
    }

    const emptyIndex = nextSideNodeIds.findIndex((slotNodeId) => !slotNodeId);

    if (emptyIndex === -1) {
      break;
    }

    nextSideNodeIds[emptyIndex] = nodeId;
    seenNodeIds.add(nodeId);
  }

  return nextSideNodeIds;
}

function createTileBounds(
  safeAreaRect: NodeBounds,
  zoom: number,
  sideNodeCount: number,
): {
  center: NodeBounds;
  sides: [
    NodeBounds | null,
    NodeBounds | null,
    NodeBounds | null,
    NodeBounds | null,
  ];
} {
  const gap = Math.max(12 / Math.max(zoom, 0.3), 8);
  const width = Math.max(safeAreaRect.width - gap * 2, 120);
  const columnWidth = width / 3;
  const height = Math.max(safeAreaRect.height, 140);
  const sideHeight = Math.max((height - gap) / 2, 60);

  const leftColumnX = safeAreaRect.x;
  const centerColumnX = leftColumnX + columnWidth + gap;
  const rightColumnX = centerColumnX + columnWidth + gap;
  const topY = safeAreaRect.y;
  const bottomY = topY + sideHeight + gap;
  const rightTopBounds = {
    x: rightColumnX,
    y: topY,
    width: columnWidth,
    height: sideHeight,
  };
  const rightBottomBounds = {
    x: rightColumnX,
    y: bottomY,
    width: columnWidth,
    height: sideHeight,
  };
  const leftTopBounds = {
    x: leftColumnX,
    y: topY,
    width: columnWidth,
    height: sideHeight,
  };
  const leftBottomBounds = {
    x: leftColumnX,
    y: bottomY,
    width: columnWidth,
    height: sideHeight,
  };

  if (sideNodeCount <= 2) {
    return {
      center: {
        x: leftColumnX,
        y: topY,
        width: columnWidth * 2 + gap,
        height,
      },
      // Side-node ordering is recency-ordered: [most recent, second, ...].
      // For <=2 nodes we always show both on the right column.
      sides: [rightTopBounds, rightBottomBounds, null, null],
    };
  }

  return {
    center: {
      x: centerColumnX,
      y: topY,
      width: columnWidth,
      height,
    },
    // For 3/4 side nodes: first two (most recent) left, remaining right.
    sides: [
      leftTopBounds,
      leftBottomBounds,
      rightTopBounds,
      rightBottomBounds,
    ],
  };
}

function isDefined<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}
