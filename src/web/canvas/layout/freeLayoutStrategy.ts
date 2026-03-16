import type { LayoutStrategy } from './types';
import { createBoundsByNodeId } from './utils';

export const freeLayoutStrategy: LayoutStrategy = {
  mode: 'free',
  compute: (input) => {
    return {
      boundsByNodeId: createBoundsByNodeId(input.nodes),
      interactionPolicy: {
        nodesDraggable: true,
        nodesResizable: true,
      },
      nextState: {
        mode: 'free',
      },
      animation: null,
    };
  },
};
