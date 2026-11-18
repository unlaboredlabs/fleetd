import { memo, useEffect, useState } from "react";
import { cx } from "../lib/cx";
import { Button } from "../primitives/Button";
import s from "./Markdown.module.css";
import type MarkdownBody from "./MarkdownBody";

type Body = typeof MarkdownBody;

// Its own chunk (the parser is most of it), loaded as the app starts (preloadMarkdown, and named in index.html so it
// is fetched beside the entry) rather than when the first message renders. Not React's lazy: a row that mounts before
// it has loaded would suspend, and React holds a suspended list's reveal back ~300 ms after the chunk is in. Here the
// row shows its busy box and fills in as soon as the parser is there.
let loaded: Body | undefined;
let loading: Promise<Body> | undefined;
const loadBody = (): Promise<Body> =>
  (loading ??= import("./MarkdownBody").then(
    (m) => (loaded = m.default),
    (e: unknown) => {
      // Tried again by the next row that asks (offline on the web, a new build's chunk names).
      loading = undefined;
      throw e;
    },
  ));

/** Starts loading the markdown parser; main.tsx calls it as the app starts. */
export const preloadMarkdown = (): void => void loadBody().catch(() => undefined);

/** Whether the parser has loaded; a failed load throws to the nearest error boundary, as a lazy component's would. */
const useParser = (): boolean => {
  const [ready, setReady] = useState(() => loaded !== undefined);
  const [failed, setFailed] = useState<Error>();
  if (failed !== undefined) throw failed;
  useEffect(() => {
    if (ready) return;
    let live = true;
    loadBody().then(
      () => {
        if (live) setReady(true);
      },
      (e: unknown) => {
        if (live) setFailed(e instanceof Error ? e : new Error("The markdown parser didn't load."));
      },
    );
    return () => {
      live = false;
    };
  }, [ready]);
  return ready;
};

/** The loaded parser's body; rendered only once useParser says it is there. */
function Parsed(props: Parameters<Body>[0]) {
  const Loaded = loaded;
  return Loaded === undefined ? null : <Loaded {...props} />;
}

export interface MarkdownProps {
  /** The message or prompt as written (markdown). */
  source: string;
  className?: string | undefined;
  /** Show a Formatted/Raw switch, for places where "exactly as sent" matters (prompts, what an agent was told). */
  rawToggle?: boolean;
  /** Start in raw view. */
  initialRaw?: boolean;
  /**
   * On (the default): a fleetd-block fence that reaches markdown is a lead's block that didn't show, drawn as a
   * small chip, never its JSON. Off for words a person wrote, where it is code like any other.
   */
  blocks?: boolean;
  /** A chat's words: each line break inside a paragraph shows, as written. Off, markdown's own rule (a space). */
  breaks?: boolean;
}

/**
 * Rendered markdown (GFM: tables, task lists, strikethrough, autolinks). Raw HTML is dropped, never rendered.
 * Memoized on its props, so a message parses once and re-renders of the list around it cost nothing.
 */
export const Markdown = memo(function Markdown({ source, className, rawToggle, initialRaw = false, blocks = true, breaks = false }: MarkdownProps) {
  const [raw, setRaw] = useState(initialRaw);
  const ready = useParser();
  const body =
    raw && rawToggle ? (
      <pre className={s.raw} data-text="code">
        {source}
      </pre>
    ) : (
      <div className={cx(s.root, !rawToggle && className)} data-text="wrap">
        {/* aria-busy until the parser has loaded, which the QA gate waits out. */}
        {ready ? <Parsed source={source} blocks={blocks} breaks={breaks} /> : <div aria-busy="true" />}
      </div>
    );
  if (!rawToggle) return body;
  return (
    <div className={cx(s.frame, className)}>
      <div className={s.toggle}>
        <Button variant="quiet" aria-pressed={raw} onClick={() => setRaw((r) => !r)}>
          {raw ? "Formatted" : "Raw"}
        </Button>
      </div>
      {body}
    </div>
  );
});

