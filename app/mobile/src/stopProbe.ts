// Whether this phone's key may stop a lead, asked once per hub link as the desktop's chat layer does (chat-layer.ts
// probeStop): chat_stop with an empty input runs nothing. A hub with the tool and a key allowed to use it refuses
// it as invalid; one that forbids the key (a Read member) or lacks the tool (an older hub) says so, and the composer
// has no Stop then, rather than the hub's error on each tap. A link that dropped asks again the next time.
import { useEffect, useState } from "react";
import type { Session } from "./session";

const TRANSIENT = new Set(["timeout", "offline", "disconnected"]);

/** Stop is there (true), isn't (false), or the hub didn't answer yet (undefined: asked again later). */
export const stopVerdict = (r: { readonly ok: true } | { readonly ok: false; readonly error: { readonly code: string } }): boolean | undefined =>
  r.ok || r.error.code === "invalid" ? true : TRANSIENT.has(r.error.code) ? undefined : false;

const known = new WeakMap<Session, boolean>();

/** Whether the composer shows Stop: asked when the lead first works, then kept for this session. */
export const useCanStop = (session: Session, working: boolean): boolean => {
  const [can, setCan] = useState(known.get(session) === true);
  useEffect(() => {
    if (!working) return;
    const was = known.get(session);
    if (was !== undefined) return setCan(was);
    let live = true;
    void session.call("chat_stop", {} as Parameters<typeof session.call<"chat_stop">>[1]).then((r) => {
      const v = stopVerdict(r);
      if (v !== undefined) known.set(session, v);
      if (live) setCan(v === true);
    });
    return () => {
      live = false;
    };
  }, [session, working]);
  return can;
};
