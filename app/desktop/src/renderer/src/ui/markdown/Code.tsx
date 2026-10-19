import { Copy, Check, WrapText } from "lucide-react";
import { memo, useEffect, useState, type ReactNode } from "react";
import { copyText } from "../lib/clipboard";
import { cx } from "../lib/cx";
import { Button } from "../primitives/Button";
import { Tooltip } from "../primitives/Tooltip";
import { Truncate } from "../text/Truncate";
import { cachedTokens, highlight, resolveLang, type CodeLang, type Tokens } from "./highlighter";
import s from "./Code.module.css";

/** Highlighted tokens for a block: plain text first, colours once the grammar is ready (same metrics, no shift). */
export function useTokens(code: string, lang: CodeLang | null): Tokens | undefined {
  const [done, setDone] = useState<{ code: string; lang: CodeLang; tokens: Tokens } | null>(null);
  useEffect(() => {
    if (!lang || cachedTokens(code, lang)) return;
    let live = true;
    highlight(code, lang).then(
      (tokens) => {
        if (live) setDone({ code, lang, tokens });
      },
      // An unknown grammar or a tokenizer failure leaves the block as plain text, which is still correct.
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [code, lang]);
  if (!lang) return undefined;
  if (done && done.code === code && done.lang === lang) return done.tokens;
  return cachedTokens(code, lang);
}

export function renderTokens(line: Tokens[number]): ReactNode {
  return line.map((t, i) => (
    <span key={i} style={{ color: t.color, fontStyle: t.italic ? "italic" : undefined }}>
      {t.content}
    </span>
  ));
}

export interface CodeProps {
  code: string;
  /** A fence tag or language name ("ts", "rust", "sh"); unknown means plain text. */
  lang?: string | null;
  /** A file name or caption for the header. */
  title?: string;
  /** Wrap long lines (default) or scroll them sideways. */
  wrap?: boolean;
  /** Hide the header (language, wrap and copy controls). */
  bare?: boolean;
  className?: string;
}

/** A block of machine text with syntax colours, a copy button and a wrap toggle. */
export const Code = memo(function Code({ code, lang, title, wrap: initialWrap = true, bare, className }: CodeProps) {
  const grammar = resolveLang(lang);
  const tokens = useTokens(code, grammar);
  const [wrap, setWrap] = useState(initialWrap);
  const [copied, setCopied] = useState(false);
  const text = code.replace(/\n$/, "");
  const lines = tokens ?? text.split("\n");

  return (
    <div className={cx(s.block, bare && s.noHead, className)}>
      {bare ? null : (
        <div className={s.head}>
          <span className={s.title}>
            <Truncate size="xs" tone="quiet">
              {title ?? lang ?? "text"}
            </Truncate>
          </span>
          <Tooltip content={wrap ? "Don't wrap lines" : "Wrap lines"}>
            <Button variant="quiet" iconOnly aria-label={wrap ? "Don't wrap lines" : "Wrap lines"} aria-pressed={wrap} onClick={() => setWrap((w) => !w)}>
              <WrapText />
            </Button>
          </Tooltip>
          <Tooltip content={copied ? "Copied" : "Copy"}>
            <Button
              variant="quiet"
              iconOnly
              aria-label="Copy code"
              onClick={() => {
                void copyText(text).then((ok) => {
                  setCopied(ok);
                  if (ok) window.setTimeout(() => setCopied(false), 1500);
                });
              }}
            >
              {copied ? <Check /> : <Copy />}
            </Button>
          </Tooltip>
        </div>
      )}
      <pre className={cx(s.pre, wrap ? s.wrap : s.nowrap)} data-text="code" tabIndex={wrap ? undefined : 0}>
        <code>
          {lines.map((line, i) => (
            <span key={i} className={s.line}>
              {typeof line === "string" ? line : renderTokens(line)}
            </span>
          ))}
        </code>
      </pre>
    </div>
  );
});

/** Inline machine text inside a sentence. */
export function InlineCode({ children }: { children: ReactNode }) {
  return (
    <code className={s.inline} data-text="code">
      {children}
    </code>
  );
}
