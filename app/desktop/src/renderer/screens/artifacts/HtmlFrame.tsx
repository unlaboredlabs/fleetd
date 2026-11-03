// An HTML artifact, in a frame of its own (main/artifactFrames.ts): main keeps the page and answers its frame at a
// one-off fleetd-artifact:// address with a CSP that lets its inline scripts run and nothing load. The frame is
// sandboxed here too, allow-scripts alone: an opaque origin, so it can't reach this page, its storage or the bridge.
// Its page draws on white unless it sets its own background, as a page in a browser would.
import { useEffect, useState } from "react";
import s from "./artifacts.module.css";

export function HtmlFrame({ html, title }: { html: string; title: string }) {
  // The address main gave for the page it was handed; none while it answers for a new one.
  const [framed, setFramed] = useState<{ html: string; url: string } | null>(null);
  useEffect(() => {
    let live = true;
    void window.fleetd.artifactFrame(html).then((url) => {
      if (live) setFramed({ html, url });
    });
    return () => {
      live = false;
    };
  }, [html]);
  const src = framed?.html === html ? framed.url : null;
  return (
    <div className={s.frameWrap}>
      {src === null ? <div className={s.frame} aria-busy="true" /> : <iframe className={s.frame} src={src} sandbox="allow-scripts" referrerPolicy="no-referrer" title={title} />}
    </div>
  );
}
