interface CodeMirrorMarkdownEditorProps {
  value: string;
  readOnly: boolean;
  onChange: (value: string) => void;
}

export function CodeMirrorMarkdownEditor({
  value,
  readOnly,
  onChange,
}: CodeMirrorMarkdownEditorProps) {
  return (
    <textarea
      className="markdown-editor-surface markdown-plain-editor"
      value={value}
      readOnly={readOnly}
      spellCheck={false}
      onChange={(event) => {
        onChange(event.target.value);
      }}
    />
  );
}
