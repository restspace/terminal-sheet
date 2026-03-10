import { useLayoutEffect, useMemo, useRef } from 'react';

import { renderTerminalText } from '../../shared/terminalText';

interface TerminalScrollPreviewProps {
  scrollback: string;
  className?: string;
  scrollResetKey?: string | number | boolean;
}

const BOTTOM_SCROLL_TOLERANCE_PX = 24;

export function TerminalScrollPreview({
  scrollback,
  className,
  scrollResetKey,
}: TerminalScrollPreviewProps) {
  const previewRef = useRef<HTMLPreElement | null>(null);
  const shouldStickToBottomRef = useRef(true);
  const renderedScrollback = useMemo(
    () => renderTerminalText(scrollback).trimEnd(),
    [scrollback],
  );

  useLayoutEffect(() => {
    const preview = previewRef.current;

    if (!preview) {
      return;
    }

    if (shouldStickToBottomRef.current) {
      preview.scrollTop = preview.scrollHeight;
    }
  }, [renderedScrollback]);

  useLayoutEffect(() => {
    const preview = previewRef.current;

    if (!preview) {
      return;
    }

    shouldStickToBottomRef.current = true;
    preview.scrollTop = preview.scrollHeight;
  }, [scrollResetKey]);

  return (
    <pre
      ref={previewRef}
      className={className ? `${className} nodrag nopan nowheel` : 'nodrag nopan nowheel'}
      aria-hidden="true"
      onScroll={(event) => {
        const preview = event.currentTarget;
        shouldStickToBottomRef.current = isNearBottom(preview);
      }}
    >
      {renderedScrollback || ' '}
    </pre>
  );
}

function isNearBottom(element: HTMLElement): boolean {
  return (
    element.scrollHeight - element.clientHeight - element.scrollTop <=
    BOTTOM_SCROLL_TOLERANCE_PX
  );
}
