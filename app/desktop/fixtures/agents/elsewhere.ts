// The Agents tab's Elsewhere group (work_list): storefront and checkout are two projects on one repo, acme/shop, so
// each sees the other's agents and PRs. On it too: a person's claim from their laptop, an agent key's claim, an open
// PR made outside fleetd, a direct push and a PR merged by hand in the last day, and a claim that expired this
// morning. storefront has agents of its own; checkout has none, so its group sits under a note.
import type { Fixture } from "../kit/fixture.ts";
import { at, sha } from "../kit/ids.ts";
import type { JsonObject } from "../kit/json.ts";
import { ELSEWHERE_IDLE } from "./route.ts";

const STOREFRONT = { machineId: "devbox", projectId: "dcffccea-c5a7-40a6-940d-7f70239ffa22" };
const CHECKOUT = { machineId: ELSEWHERE_IDLE.machineId, projectId: ELSEWHERE_IDLE.projectId };
const H = 3_600_000;

/** A claim on the repo, renewed `renewedMs` ago: it expires 12 h after that. */
const claim = (now: string, id: string, owner: JsonObject, title: string, renewedMs: number, state = "active"): JsonObject => ({
  id,
  kind: "claim",
  claimId: id,
  projectRef: STOREFRONT,
  owner,
  title,
  state,
  keys: [],
  paths: [],
  since: at(now, -renewedMs),
  expiresAt: at(now, 12 * H - renewedMs),
});

const work = (now: string, id: string, kind: string, projectRef: JsonObject | undefined, title: string, state: string, agoMs: number): JsonObject => ({
  id,
  kind,
  ...(projectRef === undefined ? {} : { projectRef }),
  title,
  state,
  keys: [],
  paths: [],
  ...(kind === "task" ? { taskId: id } : kind === "change" ? { changeId: id } : {}),
  since: at(now, -agoMs),
});

export const withElsewhere = (f: Fixture): Fixture => {
  const now = f.now;
  const items: JsonObject[] = [
    claim(
      now,
      "C12",
      { kind: "human_session", keyId: "k-laptop", label: "laptop" },
      "Dark mode toggle in settings, with the choice kept per device and the system setting as the default until someone picks one",
      3 * H,
    ),
    work(now, "T1", "task", STOREFRONT, "Receipt dates use the store's time zone", "running", 14 * 60_000),
    work(now, "T52", "task", CHECKOUT, "Share the cart's price rounding with checkout", "running", 25 * 60_000),
    claim(now, "C14", { kind: "agent_key", keyId: "k-ci", label: "ci-bot" }, "Regenerate the API client from the new schema", 10 * H),
    work(now, "X9", "change", CHECKOUT, "Move the coupon field above the totals", "ci", 50 * 60_000),
    work(now, "acme/shop#88", "pr", undefined, "Bump the image CDN client to v4", "open", 2 * H),
    claim(now, "C9", { kind: "human_session", keyId: "k-desktop", label: "desktop" }, "Try the new font stack on the product page", 17 * H, "expired"),
  ];
  const recentLandings: JsonObject[] = [
    {
      sha: sha("elsewhere push"),
      at: at(now, -40 * 60_000),
      route: "direct_push",
      subject: "fix: the search box keeps its query on back",
      authorEmail: "ada@example.com",
      covers: ["P7"],
    },
    { sha: sha("elsewhere merge"), at: at(now, -3 * H), route: "pr_outside", pr: "#86", subject: "feat: gift cards at checkout", authorEmail: "grace@example.com", covers: [] },
  ];
  const scope = { repoKey: "github.com/acme/shop", base: "main" };
  for (const projectRef of [STOREFRONT, CHECKOUT]) f.answer("work_list", { projectRef }, { scope, items, recentLandings });
  return f;
};
