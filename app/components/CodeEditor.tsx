import { lazy, Suspense } from "react";

const CodeEditorClient = lazy(() => import("./CodeEditor.client"));

interface Props {
  value: string;
  onChange: (value: string) => void;
  language: "html" | "css" | "javascript";
  label: string;
  name: string;
}

export function CodeEditor({ value, onChange, language, label, name }: Props) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          marginBottom: 4,
          fontSize: 14,
          fontWeight: 500,
          color: "#202223",
        }}
      >
        {label}
      </div>
      <Suspense
        fallback={
          <textarea
            value={value}
            onChange={(e) => onChange(e.target.value)}
            rows={8}
            style={{
              fontFamily: "monospace",
              width: "100%",
              fontSize: 13,
              padding: 8,
              border: "1px solid #e1e3e5",
              borderRadius: 8,
              boxSizing: "border-box",
            }}
          />
        }
      >
        <CodeEditorClient value={value} onChange={onChange} language={language} />
      </Suspense>
      <input type="hidden" name={name} value={value} />
    </div>
  );
}
