// An HTML artifact, in a frame of its own (main/artifactFrames.ts): main keeps the page and answers its frame at a
// one-off fleetd-artifact:// address with a CSP that lets its inline scripts run and nothing load. The frame is
// sandboxed here too, allow-scripts alone: an opaque origin, so it can't reach this page, its storage or the bridge.
// Its page draws on white unless it sets its own background, as a page in a browser would. A link a person clicks in it
// comes here as a message (ARTIFACT_LINK) with the page's key, which only main's first script in the page holds, and
// opens in the browser as a Markdown link does: the page's own scripts can't open anything.
import { useEffect, useRef, useState } from "react";
import { linkOf } from "../../../shared/artifactLink";
import { Button, Text } from "../../ui";
import s from "./artifacts.module.css";

export function HtmlFrame({ html, title }: { html: string; title: string }) {
  // The address main gave for the page it was handed; none while it answers for a new one.
  const [framed, setFramed] = useState<{ html: string; url: string; key: string } | { html: string; failed: true } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const frame = useRef<HTMLIFrameElement>(null);
  useEffect(() => {
    let live = true;
    window.fleetd.artifactFrame(html).then(
      ({ url, key }) => {
        if (live) setFramed({ html, url, key });
      },
      () => {
        if (live) setFramed({ html, failed: true });
      },
    );
    return () => {
      live = false;
    };
  }, [html, attempt]);
  const shown = framed?.html === html ? framed : null;
  const key = shown !== null && "key" in shown ? shown.key : null;
  useEffect(() => {
    if (key === null) return;
    const onMessage = (e: MessageEvent) => {
      const href = linkOf(e.data, key);
      if (href === undefined || frame.current === null || e.source !== frame.current.contentWindow) return;
      void window.fleetd.openExternal(href);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [key]);
  return (
    <div className={s.frameWrap}>
      {shown === null ? (
        <div className={s.frame} aria-busy="true" />
      ) : "failed" in shown ? (
        <div className={s.note} role="alert">
          <Text tone="quiet">Couldn’t show this page.</Text>
          <Button onClick={() => setAttempt((n) => n + 1)}>Retry</Button>
        </div>
      ) : (
        <iframe ref={frame} className={s.frame} src={shown.url} sandbox="allow-scripts" referrerPolicy="no-referrer" title={title} />
      )}
    </div>
  );
}
