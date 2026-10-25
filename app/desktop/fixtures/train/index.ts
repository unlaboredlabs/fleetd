// The panel's Train (changes_list, with pr_list and pr_get for titles and the head's checks) for the first project,
// storefront. The shared fixtures answer changes_list from the PRs fixtures/prs put on the train, so the tab agrees
// with the PRs tab; the group's own show a full train (a PR in CI, a queue in every state, merges and a refusal), a
// batch of three in CI, a project with nothing on its train, the read on its way, and the read failing.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { firstProject } from "../kit/chat.ts";
import { asText, isObject, type JsonObject, type JsonValue } from "../kit/json.ts";
import { trainFixture } from "../../src/renderer/screens/train/fixture.ts";

/** The changes behind the PRs a fixture's pr_list has on the train, newest first as the hub sends them. */
const changesOfPrs = (f: Fixture): JsonObject[] => {
  const projectRef = firstProject(f);
  const out = f.output("pr_list", { projectRef });
  const rows = isObject(out) && Array.isArray(out["prs"]) ? out["prs"].filter(isObject) : [];
  return rows
    .filter((r) => isObject(r["queue"]))
    .map((r): JsonObject => {
      const q = r["queue"] as JsonObject;
      const number = Number(r["number"]);
      const reason = q["reason"];
      return {
        changeId: q["changeId"] as JsonValue,
        projectRef,
        repo: r["repo"] as JsonValue,
        prNumber: number,
        prUrl: r["url"] as JsonValue,
        branch: typeof r["branch"] === "string" ? r["branch"] : `fleetd/pr-${number}`,
        headSha: `${number}`.padStart(40, "a"),
        state: q["state"] as JsonValue,
        reviews: [],
        workstreamId: "W3",
        createdAt: r["createdAt"] as JsonValue,
        updatedAt: (r["mergedAt"] ?? r["updatedAt"]) as JsonValue,
        ...(typeof q["position"] === "number" ? { position: q["position"] } : {}),
        ...(typeof reason === "string" ? { lastError: reason } : {}),
        ...(q["state"] === "merged" ? { mergedSha: `${number}`.padStart(40, "b") } : {}),
      };
    })
    .toSorted((a, b) => asText(b["createdAt"]).localeCompare(asText(a["createdAt"])));
};

const changesInput = (f: Fixture): JsonObject => ({ projectRef: firstProject(f), limit: 100 });

/** The pane's own train: its changes, the PR list that titles them, and the head's checks. */
const answerTrain = (f: Fixture, batch = false): Fixture => {
  const projectRef = firstProject(f);
  const t = trainFixture(projectRef, f.now, batch);
  f.answer("changes_list", changesInput(f), { changes: t.changes as unknown as JsonValue });
  f.answer("pr_list", { projectRef }, { at: f.now, prs: t.prs as unknown as JsonValue });
  for (const h of t.heads) f.answer("pr_get", { repo: h.pr.repo, number: h.pr.number }, h);
  return f;
};

const fromPrs = (f: Fixture): void => {
  f.answer("changes_list", changesInput(f), { changes: changesOfPrs(f) });
};

export default defineGroup({
  extend: {
    typical: fromPrs,
    "many-agents": fromPrs,
    "long-text": fromPrs,
  },
  fixtures: (base) => [
    answerTrain(Fixture.from(base("typical"), "train-full", "storefront's train: a PR in CI, four in line and one sent back, merges, a batch and a refusal.")),
    answerTrain(Fixture.from(base("typical"), "train-batch", "storefront's train merging a batch of three together."), true),
    (() => {
      const f = Fixture.from(base("typical"), "train-empty", "Nothing on storefront's train, and nothing landed lately.");
      f.answer("changes_list", changesInput(f), { changes: [] });
      return f;
    })(),
    (() => {
      const f = answerTrain(Fixture.from(base("typical"), "train-loading", "The train still on its way from the hub."));
      for (const a of f.answers("changes_list")) f.answer("changes_list", a.input, a.output, 600_000);
      // The answer never comes in a shot: shoot without waiting for it.
      return f.settleAt(0);
    })(),
    (() => {
      const f = Fixture.from(base("typical"), "train-error", "The hub fails to read storefront's train.");
      f.fail("changes_list", changesInput(f), { code: "failed", message: "the hub's database is busy" });
      return f;
    })(),
  ],
});
