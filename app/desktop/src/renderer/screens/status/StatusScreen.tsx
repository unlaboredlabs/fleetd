// The Status view (⌘.): how far the fleet, a project or an order is, as fleetd verified it, and what is in the way.
// Spec: docs/build/status-spec.md §10, plus the progress model (two-tone bar, planning, sparkline) and the
// no-time rule: state and measured ages, never an estimated time.

import { useMemo, useSyncExternalStore } from "react";
import { Button, cx, Dot, Text } from "../../ui";
import type { StatusDoc, StatusScope } from "./contracts";
import { useHubNow, useStatus } from "./hooks";
import { Health } from "./Health";
import { Hero } from "./Hero";
import { Sections } from "./Sections";
import { phase, type Phase, type StatusRead } from "./session";
import { agesOnScreen, clock, scopeFromRoute, scopeRoute, sourceName, staleAge } from "./view";
import s from "./status.module.css";

const subscribeHash = (cb: () => void): (() => void) => {
  window.addEventListener("hashchange", cb);
  return () => window.removeEventListener("hashchange", cb);
};

export const go = (scope: StatusScope): void => {
  window.location.hash = scopeRoute(scope);
};

/** Routes: #/status, #/status/project/<machineId>/<projectId>, #/status/order/<id>. */
export function StatusScreen() {
  const hash = useSyncExternalStore(subscribeHash, () => window.location.hash);
  const route = (hash.split("?")[0] ?? "").split("/").slice(0, 5).join("/");
  // One scope object per route, so the query and the look restart only when the route means another scope.
  const scope = useMemo<StatusScope>(() => scopeFromRoute(route) ?? { kind: "fleet" }, [route]);
  const read = useStatus(scope);
  const p = phase(read);
  const doc = read.doc ?? null;
  const now = useHubNow(read, (n) => (doc ? agesOnScreen(doc, n) : []));

  return (
    <div className={cx(s.screen)} data-screen={`status.${scope.kind}`} data-phase={p}>
      <Header scope={scope} doc={doc} phase={p} linkUp={read.fresh} />
      <div className={cx(s.body)}>
        <div className={cx(s.measure)}>
          <Banner read={read} phase={p} />
          {doc ? (
            <>
              <StaleList doc={doc} now={now} />
              {/* Keyed by route: a scope switch mounts a new hero, whose first paint never tweens. */}
              <Hero key={route} doc={doc} live={p === "live"} now={now} />
              <Health doc={doc} now={now} />
              <Sections doc={doc} now={now} />
            </>
          ) : (
            <Skeleton />
          )}
        </div>
      </div>
    </div>
  );
}

function Header({ scope, doc, phase: p, linkUp }: { scope: StatusScope; doc: StatusDoc | null; phase: Phase; linkUp: boolean }) {
  const crumbs: { label: string; to: StatusScope }[] = [{ label: "Fleet", to: { kind: "fleet" } }];
  if (scope.kind === "project") crumbs.push({ label: doc?.title ?? scope.projectRef.projectId, to: scope });
  if (scope.kind === "order") crumbs.push({ label: doc?.title ?? scope.workstreamId, to: scope });
  const staleCount = doc?.stale.length ?? 0;
  const [tone, words] =
    p === "live"
      ? staleCount > 0
        ? (["var(--warning)", `live · ${staleCount} source${staleCount === 1 ? "" : "s"} stale · as of ${clock(doc?.now ?? "")}`] as const)
        : (["var(--success)", `live · as of ${clock(doc?.now ?? "")}`] as const)
      : p === "notLive"
        ? (["var(--warning)", `not live · data from ${clock(doc?.now ?? "")}`] as const)
        : linkUp
          ? (["var(--faint)", "syncing"] as const)
          : (["var(--warning)", "not live"] as const);
  return (
    <header className={cx(s.header)}>
      <nav className={cx(s.crumbs)} aria-label="Status scope">
        <Text strong>Status</Text>
        {crumbs.map((c, i) => (
          <span key={c.label} className={cx(s.crumb)}>
            {i > 0 ? <span aria-hidden className={cx(s.faint)}>›</span> : null}
            {i === crumbs.length - 1 ? (
              <span aria-current="page">
                <Text strong>{c.label}</Text>
              </span>
            ) : (
              <Button variant="quiet" onClick={() => go(c.to)}>
                {c.label}
              </Button>
            )}
          </span>
        ))}
        {scope.kind === "order" ? (
          <Button variant="ghost" onClick={() => (window.location.hash = `#/order/${encodeURIComponent(scope.workstreamId)}`)}>
            Open order
          </Button>
        ) : null}
      </nav>
      <div className={cx(s.liveness)} role="status">
        <Dot color={tone} />
        <Text size="xs" tone={p === "live" && staleCount === 0 ? "quiet" : "default"} tabular>
          {words}
        </Text>
      </div>
    </header>
  );
}

/** Why the view isn't live: the link, a failed read (with Retry), or the first sync after (re)connecting. */
function Banner({ read, phase: p }: { read: StatusRead & { retry: () => void }; phase: Phase }) {
  if (p === "live") return null;
  const from = read.doc ? ` · data from ${clock(read.doc.now)}` : "";
  const text = !read.fresh
    ? "Not live: reconnecting to the hub. Numbers show once it has answered."
    : read.error !== null
      ? `Not live: the hub's status answer failed: ${read.error}${from}`
      : "Syncing with the hub. Numbers show once it answers.";
  const warn = !read.fresh || read.error !== null;
  return (
    <div className={warn ? s.bannerWarn : s.banner} role={warn ? "alert" : "status"}>
      <Dot color={warn ? "var(--warning)" : "var(--faint)"} />
      <Text className={cx(s.grow)}>{text}</Text>
      {read.fresh && read.error !== null ? (
        <Button variant="secondary" onClick={read.retry}>
          Retry
        </Button>
      ) : null}
    </div>
  );
}

/** Every source the hub says is stale, with its reason and age. The parts that depend on it carry their own mark. */
function StaleList({ doc, now }: { doc: StatusDoc; now: number }) {
  if (doc.stale.length === 0) return null;
  return (
    <section className={cx(s.staleList)} aria-label="Stale sources">
      {doc.stale.map((src) => (
        <div key={src.source} className={cx(s.staleRow)}>
          <Text size="xs" strong tone="warning" tabular>
            {staleAge(src, now)}
          </Text>
          <Text size="xs">
            {sourceName(src.source)}: {src.reason}
          </Text>
          <Text size="xs" tone="quiet" tabular>
            since {clock(src.since)}
          </Text>
        </div>
      ))}
      {doc.more.stale > 0 ? (
        <Text size="xs" tone="quiet">
          and {doc.more.stale} more
        </Text>
      ) : null}
    </section>
  );
}

/** Heads and bar outlines only: no digit shows until the hub has answered. */
function Skeleton() {
  return (
    <div className={cx(s.skeleton)} aria-hidden>
      <div className={cx(s.skelNumber)} />
      <div className={cx(s.skelBar)} />
      <div className={cx(s.skelLine)} />
      <div className={cx(s.skelLine)} />
      {["Health", "Needs you", "Risks", "In progress", "Next up", "Done"].map((h) => (
        <div key={h} className={cx(s.skelSection)}>
          <Text size="xs" strong tone="quiet">
            {h}
          </Text>
          <div className={cx(s.skelLine)} />
        </div>
      ))}
    </div>
  );
}
