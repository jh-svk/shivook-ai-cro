import ReactCodeMirror from "@uiw/react-codemirror";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { javascript } from "@codemirror/lang-javascript";

const langExtensions = {
  html: [html()],
  css: [css()],
  javascript: [javascript()],
};

interface Props {
  value: string;
  onChange: (value: string) => void;
  language: "html" | "css" | "javascript";
}

export default function CodeEditorClient({ value, onChange, language }: Props) {
  return (
    <ReactCodeMirror
      value={value}
      onChange={onChange}
      extensions={langExtensions[language]}
      minHeight="120px"
      style={{ border: "1px solid #e1e3e5", borderRadius: 8, overflow: "hidden" }}
    />
  );
}
