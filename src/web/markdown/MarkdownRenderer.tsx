import { useDeferredValue } from 'react';
import ReactMarkdown, {
  type Components,
  type ExtraProps,
} from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface MarkdownRendererProps {
  content: string;
}

export function MarkdownRenderer({ content }: MarkdownRendererProps) {
  const deferredContent = useDeferredValue(content);

  return (
    <div className="markdown-rendered-content">
      <ReactMarkdown
        components={LINE_ANCHOR_COMPONENTS}
        remarkPlugins={REMARK_PLUGINS}
      >
        {deferredContent}
      </ReactMarkdown>
    </div>
  );
}

const REMARK_PLUGINS = [remarkGfm];

const LINE_ANCHOR_COMPONENTS: Components = {
  blockquote: ({ node, ...props }) => (
    <blockquote {...props} data-markdown-source-line={getSourceLine(node)} />
  ),
  h1: ({ node, ...props }) => (
    <h1 {...props} data-markdown-source-line={getSourceLine(node)} />
  ),
  h2: ({ node, ...props }) => (
    <h2 {...props} data-markdown-source-line={getSourceLine(node)} />
  ),
  h3: ({ node, ...props }) => (
    <h3 {...props} data-markdown-source-line={getSourceLine(node)} />
  ),
  h4: ({ node, ...props }) => (
    <h4 {...props} data-markdown-source-line={getSourceLine(node)} />
  ),
  h5: ({ node, ...props }) => (
    <h5 {...props} data-markdown-source-line={getSourceLine(node)} />
  ),
  h6: ({ node, ...props }) => (
    <h6 {...props} data-markdown-source-line={getSourceLine(node)} />
  ),
  li: ({ node, ...props }) => (
    <li {...props} data-markdown-source-line={getSourceLine(node)} />
  ),
  ol: ({ node, ...props }) => (
    <ol {...props} data-markdown-source-line={getSourceLine(node)} />
  ),
  p: ({ node, ...props }) => (
    <p {...props} data-markdown-source-line={getSourceLine(node)} />
  ),
  pre: ({ node, ...props }) => (
    <pre {...props} data-markdown-source-line={getSourceLine(node)} />
  ),
  table: ({ node, ...props }) => (
    <table {...props} data-markdown-source-line={getSourceLine(node)} />
  ),
  ul: ({ node, ...props }) => (
    <ul {...props} data-markdown-source-line={getSourceLine(node)} />
  ),
};

function getSourceLine(node: ExtraProps['node']): number | undefined {
  return node?.position?.start.line;
}
