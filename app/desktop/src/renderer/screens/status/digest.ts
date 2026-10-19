// The optional morning/evening digest notification (Settings → Notifications, off by default). On the hub's
// `digest.ready` (09:00/18:00) the app asks a FRESH `status_get {fleet}` (never a kept doc) and posts one
// notification. "Since" counts from the previous digest, not the reader's seen mark: a notification is not a look.

import { useEffect, useSyncExternalStore } from "react";
import { asGetOutput, type StatusDoc } from "./contracts";
import { onHubEvent } from "./controller";
import { figure, headlineText } from "./view";

const PREF = "fleetd.status.digest";
const LAST_SEQ = "fleetd.status.digestSeq";

const prefListeners = new Set<() => void>();
export const digestEnabled = (): boolean => localStorage.getItem(PREF) === "on";
export const setDigestEnabled = (on: boolean): void => {
  localStorage.setItem(PREF, on ? "on" : "off");
  for (const l of prefListeners) l();
};
export const useDigestEnabled = (): boolean =>
  useSyncExternalStore((cb) => {
    prefListeners.add(cb);
    return () => prefListeners.delete(cb);
  }, digestEnabled);

/** "fleetd · 72% · 3 need you", then the headline (with its Not live clause) and what changed since the last
 * digest. The count sits in the title because a generated headline may not say it. */
export const digestText = (doc: StatusDoc): { title: string; body: string } => {
  const f = figure(doc.progress, doc.virtualTier);
  const counted = doc.progress.total > 0 || doc.progress.polishTotal > 0 || doc.progress.estimate !== undefined;
  const n = doc.needsYou.count;
  const title = [
    "fleetd",
    ...(f.pct === null ? ["planning"] : counted ? [`${f.pct}%`] : []),
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

export const useStatusDigest = (post: (n: { title: string; body: string }) => void, quiet: (nowMs: number) => boolean): void => {
  useEffect(
    () =>
      onHubEvent((event) => {
        if (event.type !== "digest.ready" || !digestEnabled() || quiet(Date.now())) return;
        const last = Number(localStorage.getItem(LAST_SEQ) ?? Number.NaN);
        const input = Number.isFinite(last) ? { scope: { kind: "fleet" }, sinceSeq: last } : { scope: { kind: "fleet" } };
        void window.fleetd.hub.call("status_get", input, { timeoutMs: 30_000 }).then((outcome) => {
          const out = outcome.ok ? asGetOutput(outcome.output) : undefined;
          if (!out) return;
          localStorage.setItem(LAST_SEQ, String(out.doc.seq));
          post(digestText(out.doc));
        });
      }),
    [post, quiet],
  );
};
