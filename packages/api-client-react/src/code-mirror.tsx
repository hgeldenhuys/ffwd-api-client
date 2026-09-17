/**
 * The CodeMirror body/response editor lives in its own chunk, imported with
 * React.lazy from ApiClient, so an SSR host never loads it on the server.
 */
import CodeMirror from "@uiw/react-codemirror";
import { json } from "@codemirror/lang-json";

export default function CodeMirrorJson({
  value,
  onChange,
  editable = true,
  height = "220px",
}: {
  value: string;
  onChange?: (v: string) => void;
  editable?: boolean;
  height?: string;
}) {
  return (
    <CodeMirror
      value={value}
      height={height}
      extensions={[json()]}
      editable={editable}
      onChange={(v: string) => editable && onChange?.(v)}
      basicSetup={{ lineNumbers: true, foldGutter: false }}
    />
  );
}
