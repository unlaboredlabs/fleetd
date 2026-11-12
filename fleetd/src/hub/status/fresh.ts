// Which status sources are live: `hub.area("status_fresh")`. A source is
// touched on every good answer (`touch`) and told of failures (`fail`, which keeps the reason but flips nothing).
// Staleness is decided only here, by deadlines: a source is stale once `asOf + staleAfter` passes untouched. The
// status loop sleeps until `nextDeadline` and calls `check`; nothing polls.
import type { Hub } from "../api/hub.ts";
import { Fresh } from "./sources.ts";

export { type Flip, Fresh, GITHUB_STALE_MS, github, type SourceView, type Stale, train, TRAIN_STALE_MS } from "./sources.ts";

/** The hub's freshness registry: `fresh(hub).touch(github(repo), now)`. */
export const fresh = (hub: Hub) => hub.area("status_fresh", () => new Fresh());
