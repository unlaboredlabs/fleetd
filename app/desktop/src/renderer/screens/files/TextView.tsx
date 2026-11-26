// Text or code, its lines numbered: code in its language's colours once the grammar loads (plain until then, the same
// metrics, no shift); a long file stays plain. Lines wrap at the panel's width, or scroll sideways with Wrap off.
import { useMemo } from "react";
import { cx, renderTokens, type CodeLang } from "../../ui";
import { useTokens } from "../../ui/markdown/Code";
import f from "./files.module.css";

export function TextView({ text, lang, wrap }: { text: string; lang: CodeLang | null; wrap: boolean }) {
  const clean = useMemo(() => text.replace(/\r\n?/gu, "\n").replace(/\n$/u, ""), [text]);
  const lines = useMemo(() => clean.split("\n"), [clean]);
  const tokens = useTokens(clean, lang);
  return (
    <div className={cx(f.text, wrap && f.wrap)} data-lang={lang ?? "text"}>
      <div className={f.lines} style={{ ["--gutter" as string]: `${String(String(lines.length).length + 2)}ch` }}>
        {lines.map((line, i) => (
          <div key={i} className={f.line}>
            <span className={f.lineNo} aria-hidden>
              {i + 1}
            </span>
            <span className={f.lineText}>{tokens?.[i] !== undefined ? renderTokens(tokens[i]) : line === "" ? "​" : line}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
