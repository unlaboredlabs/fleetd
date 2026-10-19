// The optional morning/evening digest notification (Settings → General, off by default). On the hub's
// `digest.ready` (09:00/18:00) the app asks a FRESH `status_get {fleet}` (never a kept doc) and posts one
// notification. "Since" counts from the previous digest, not the reader's seen mark: a notification is not a look.

import { useEffect, useRef } from "react";
import { digestNotifications } from "../settings/prefs";
import { useData, useDataLayer } from "../../src/data/react";
import { asGetOutput, type StatusDoc } from "./contracts";
import { figure, headlineText } from "./view";

const LAST_SEQ = "fleetd.status.digestSeq";


/** "fleetd · 72% · 3 need you", then the headline (with its Not live clause) and what changed since the last
 * digest. The count sits in the title because a generated headline may not say it. */
export const digestText = (doc: StatusDoc): { title: string; body: string } => {
  const f = figure(doc.progress, doc.virtualTier);
  const n = doc.needsYou.count;
  const title = [
    "fleetd",
    ...(f.pct !== null ? [`${f.pct}%`] : f.planning !== null ? ["planning"] : []),
    ...(n === 0 ? [] : [n === 1 ? "1 needs you" : `${n} need you`]),
  ].join(" · ");
  const parts = [headlineText(doc, true)];
  const s = doc.since;
  const counts = (
    [
      [s.merged, "merged"],
      [s.verified, "verified"],
      [s.started, "started"],
      [s.failed, "failed"],
    ] as const
  )
    .filter(([n]) => n > 0)
    .map(([n, w]) => `${n} ${w}`);
  if (counts.length > 0) parts.push(`Since the last digest: ${counts.join(", ")}.`);
  return { title, body: parts.join(" ") };
};

/** Posts the digest through main's notifications (F1); clicking it opens Status. */
export const postDigest = ({ title, body }: { title: string; body: string }): void => {
  // Main's notify contract caps the title at 120 and the body at 400 characters.
  const clip = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
  void window.fleetd.app.notify({ tag: "digest", title: clip(title, 120), body: clip(body, 400), target: { kind: "status" } });
};

/** Settings → General's "Status digest" toggle (settings/prefs.ts owns its one key) and the hub's quiet hours. */
export const digestDue = (nowMs: number, quiet: (nowMs: number) => boolean): boolean => digestNotifications() && !quiet(nowMs);

const latestDigest = (events: readonly { readonly seq: number; readonly type: string }[]): number | undefined =>
  events.findLast((e) => e.type === "digest.ready")?.seq;

/** Mounted once by the shell. `post` shows a system notification; `quiet` is the hub's quiet hours. The digest is a
 * fresh status_get through the data layer, never a kept doc; nothing is posted from an old or failed answer: no
 * digest beats a wrong one. A digest.ready already in the stream when the app connected is not news. */
export const useStatusDigest = (post: (n: { title: string; body: string }) => void, quiet: (nowMs: number) => boolean): void => {
  const layer = useDataLayer();
  const latest = useData((s) => (s.fresh ? latestDigest(s.events) : undefined));
  const handled = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (latest === undefined) return;
    const first = handled.current === undefined;
    if (!first && latest <= (handled.current ?? 0)) return;
    handled.current = latest;
    if (first || !digestDue(Date.now(), quiet)) return;
    const last = Number(localStorage.getItem(LAST_SEQ) ?? Number.NaN);
    const input = Number.isFinite(last) ? { scope: { kind: "fleet" as const }, sinceSeq: last } : { scope: { kind: "fleet" as const } };
    void layer.queryClient
      .query(layer.toolQuery("status_get", input))
      .then((output) => {
        const out = asGetOutput(output);
        if (!out) return;
        localStorage.setItem(LAST_SEQ, String(out.doc.seq));
        post(digestText(out.doc));
      })
      .catch(() => undefined);
  }, [latest, layer, post, quiet]);
};
