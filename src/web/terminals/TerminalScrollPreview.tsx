import { useEffect, useRef } from 'react';

import { renderTerminalText } from '../../shared/terminalText';

interface TerminalScrollPreviewProps {
  scrollback: string;
  className?: string;
}

export function TerminalScrollPreview({
  scrollback,
  className,
}: TerminalScrollPreviewProps) {
  const previewRef = useRef<HTMLPreElement | null>(null);
  const renderedScrollback = renderTerminalText(scrollback).trimEnd();

  useEffect(() => {
    const preview = previewRef.current;

    if (!preview) {
      return;
    }

    preview.scrollTop = preview.scrollHeight;
  }, [renderedScrollback]);

  return (
    <pre ref={previewRef} className={className} aria-hidden="true">
      {renderedScrollback || ' '}
    </pre>
  );
}
