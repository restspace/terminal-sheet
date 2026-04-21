import { forwardRef } from 'react';

interface CodeMirrorMarkdownEditorProps {
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}

export const CodeMirrorMarkdownEditor = forwardRef<
  HTMLTextAreaElement,
  CodeMirrorMarkdownEditorProps
>(function CodeMirrorMarkdownEditor({ value, readOnly, onChange }, ref) {
  return (
    <textarea
      ref={ref}
      className="markdown-editor-surface markdown-plain-editor"
      value={value}
      readOnly={readOnly}
      spellCheck={false}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
});
