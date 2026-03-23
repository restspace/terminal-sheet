import { useDeferredValue } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const deferredContent = useDeferredValue(content);

  return (
    <div className="markdown-rendered-content">
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{deferredContent}</ReactMarkdown>
    </div>
  );
}

const REMARK_PLUGINS = [remarkGfm];
