import { useEffect, useRef } from 'react';

type ResizeDirection =
  | 'top-left'
  | 'top-right'
  | 'bottom-left'
  | 'bottom-right';

interface NodeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CanvasResizeHandlesProps {
  bounds: NodeBounds;
  isVisible: boolean;
  minWidth: number;
  minHeight: number;
  zoom: number;
  onBoundsChange: (bounds: NodeBounds) => void;
}

interface ResizeState {
  direction: ResizeDirection;
  startClientX: number;
  startClientY: number;
  startBounds: NodeBounds;
}

const directions: ResizeDirection[] = [
  'top-left',
  'top-right',
  'bottom-left',
  'bottom-right',
];

export function CanvasResizeHandles({
  bounds,
  isVisible,
  minWidth,
  minHeight,
  zoom,
  onBoundsChange,
}: CanvasResizeHandlesProps) {
  const resizeStateRef = useRef<ResizeState | null>(null);

  useEffect(() => {
    if (!isVisible) {
      resizeStateRef.current = null;
      return;
    }

    function handlePointerMove(event: PointerEvent) {
      const resizeState = resizeStateRef.current;

      if (!resizeState) {
        return;
      }

      event.preventDefault();

      const dx = (event.clientX - resizeState.startClientX) / zoom;
      const dy = (event.clientY - resizeState.startClientY) / zoom;
      const nextBounds = calculateResizedBounds(
        resizeState.startBounds,
        resizeState.direction,
        dx,
        dy,
        minWidth,
        minHeight,
      );

      onBoundsChange(nextBounds);
    }

    function handlePointerUp() {
      resizeStateRef.current = null;
      document.body.classList.remove('is-resizing-node');
    }

    window.addEventListener('pointermove', handlePointerMove);
    window.addEventListener('pointerup', handlePointerUp);

    return () => {
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      document.body.classList.remove('is-resizing-node');
    };
  }, [isVisible, minHeight, minWidth, onBoundsChange, zoom]);

  if (!isVisible) {
    return null;
  }

  return (
    <>
      {directions.map((direction) => (
        <div
          key={direction}
          className={`canvas-node-resize-handle is-${direction} nodrag nopan`}
          onPointerDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            resizeStateRef.current = {
              direction,
              startClientX: event.clientX,
              startClientY: event.clientY,
              startBounds: bounds,
            };
            document.body.classList.add('is-resizing-node');
          }}
        />
      ))}
    </>
  );
}

function calculateResizedBounds(
  startBounds: NodeBounds,
  direction: ResizeDirection,
  dx: number,
  dy: number,
  minWidth: number,
  minHeight: number,
): NodeBounds {
  let nextX = startBounds.x;
  let nextY = startBounds.y;
  let nextWidth = startBounds.width;
  let nextHeight = startBounds.height;

  if (direction.includes('left')) {
    nextWidth = Math.max(minWidth, startBounds.width - dx);
    nextX = startBounds.x + (startBounds.width - nextWidth);
  } else {
    nextWidth = Math.max(minWidth, startBounds.width + dx);
  }

  if (direction.includes('top')) {
    nextHeight = Math.max(minHeight, startBounds.height - dy);
    nextY = startBounds.y + (startBounds.height - nextHeight);
  } else {
    nextHeight = Math.max(minHeight, startBounds.height + dy);
  }

  return {
    x: Math.round(nextX),
    y: Math.round(nextY),
    width: Math.round(nextWidth),
    height: Math.round(nextHeight),
  };
}
