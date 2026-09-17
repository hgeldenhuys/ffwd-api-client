import { useMemo } from "react";

export type TokenKind = "known" | "secret" | "unknown";

export function classifyTokens(
  text: string,
  known: Set<string>,
  secrets: Set<string>
): { text: string; kind: TokenKind | null }[] {
  const parts: { text: string; kind: TokenKind | null }[] = [];
  const re = /\{\{\s*([^{}]+?)\s*\}\}/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), kind: null });
    const name = m[1];
    const kind: TokenKind = secrets.has(name) ? "secret" : known.has(name) ? "known" : "unknown";
    parts.push({ text: `{{${name}}}`, kind });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), kind: null });
  return parts;
}

const KIND_CLASS: Record<TokenKind, string> = {
  known: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 rounded",
  secret: "bg-amber-500/20 text-amber-600 dark:text-amber-400 rounded",
  unknown: "bg-red-500/15 text-red-600 dark:text-red-400 rounded",
};

export function TokenInput({
  value,
  onChange,
  known,
  secrets,
  placeholder,
  className,
  onKeyDown,
}: {
  value: string;
  onChange: (v: string) => void;
  known: Set<string>;
  secrets: Set<string>;
  placeholder?: string;
  className?: string;
  onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  const parts = useMemo(() => classifyTokens(value, known, secrets), [value, known, secrets]);
  return (
    <div className={`relative ${className ?? ""}`}>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 flex items-center overflow-hidden whitespace-pre px-3 py-2 font-mono text-[13px]"
      >
        {value === "" ? (
          <span className="text-muted-foreground/60">{placeholder}</span>
        ) : (
          parts.map((p, i) =>
            p.kind ? (
              <span key={i} className={KIND_CLASS[p.kind]}>
                {p.text}
              </span>
            ) : (
              <span key={i}>{p.text}</span>
            )
          )
        )}
      </div>
      <input
        className="w-full rounded-md border bg-transparent px-3 py-2 font-mono text-[13px] text-transparent caret-foreground selection:bg-primary/30"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        spellCheck={false}
      />
    </div>
  );
}
