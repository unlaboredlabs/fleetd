// The train's reviewer opens in the PR's own repo (W791): `HubHost.spawnReview` passes no repo, and the tasks area
// finds it from the PR's URL, so a bot with several repos, or one whose only repo is an added checkout, starts its
// reviewer in that repo's checkout with that repo's id (which its GH_TOKEN is handed for). The cloud's train once
// started such reviewers in the bot's empty folder (fleetd-cloud a17ec5ae).
import { expect, test } from "bun:test";
import { sendRunId } from "../src/hub/executor/sessions.ts";
import * as repos from "../src/hub/repos/store.ts";
import { HubHost } from "../src/hub/train/hub_host.ts";
import { bind } from "../src/hub/work/store.ts";
import type { ProjectRef } from "../src/shared/contracts.ts";
import { P, tasksKit, until } from "./tasks-kit.ts";
import { project } from "./work-kit.ts";

const API: ProjectRef = { machineId: "lab-a", projectId: "api" };
const WEB: ProjectRef = { machineId: "lab-a", projectId: "web" };

/** The kit's bot, with `api` and `web` added as repos in checkouts of their own; its own folder bound when `own`. */
function bot(own: boolean) {
  const k = tasksKit();
  if (own) bind(k.hub.db.conn, P, { repoKey: "github.com/acme/shop", base: "main" }, k.clock.ms);
  for (const [r, name] of [
    [API, "api"],
    [WEB, "web"],
  ] as const) {
    project(k.hub, r, { workspaceRoot: `/home/me/${name}` });
    bind(k.hub.db.conn, r, { repoKey: `github.com/acme/${name}`, base: "main" }, k.clock.ms);
    repos.attach(k.hub.db.conn, P, name, r);
  }
  k.hub.area("tasks", () => k.t);
  const host = new HubHost(k.hub);
  const review = (pr: string) =>
    host.spawnReview({ projectRef: P, by: "reviews", workstreamId: k.w.workstreamId, title: "Review", prompt: "Review it", pr });
  return { ...k, review };
}

test("on a bot with several repos, the train's reviewer starts in the checkout of the repo its PR is in", async () => {
  const k = bot(true);
  for (const [pr, checkout, name] of [
    ["https://github.com/acme/web/pull/7", WEB, "web"],
    ["https://github.com/Acme/API/pull/3", API, "api"],
    ["https://github.com/acme/shop/pull/9", P, "shop"],
  ] as const) {
    const view = await k.review(pr);
    expect(view.state).toBe("running");
    const id = repos.byName(k.hub.db.conn, P, name)?.repoId;
    const launch = k.ports.launches.at(-1)!;
    expect(launch.request.kind).toBe("review");
    expect(launch.request.projectId).toBe(checkout.projectId);
    expect(id).toBeDefined();
    expect(launch.request.repoId).toBe(id!);
    expect(launch.request.worktree).toEqual({ baseRef: "main", pr });
    expect(k.t.get(view.taskId)?.repoId).toBe(id!);
  }
});

test("on a bot whose only repo is an added checkout, the train's reviewer starts there, not in the bot's own folder", async () => {
  const k = bot(false);
  // The bot's own folder holds no repo: only the two it was given.
  expect(repos.of(k.hub.db.conn, P).map((r) => r.name)).toEqual(["api", "web"]);
  const view = await k.review("https://github.com/acme/api/pull/12");
  const launch = k.ports.launches.at(-1)!;
  expect(launch.request.projectId).toBe("api");
  expect(launch.request.repoId).toBe(repos.byName(k.hub.db.conn, P, "api")!.repoId);
  expect(k.t.get(view.taskId)?.repoId).toBe(launch.request.repoId!);
});

test("the train's blocking findings reach an ended writer on the hub: it continues in its own thread and checkout", async () => {
  const k = bot(false);
  void k.t.run();
  const host = new HubHost(k.hub);
  const writer = await k.spawn("Fix the API", "write", { repo: "api" });
  expect(k.ports.launches).toHaveLength(1);
  expect(k.ports.launches[0]?.request.projectId).toBe("api");
  const findings = async (text: string) => {
    await host.messageTask(P, "hub:reviews", writer.taskId, text);
    await until(() => k.t.get(writer.taskId)?.state === "running");
    expect(k.ports.sends.at(-1)?.thread).toEqual({ machineId: "lab-a", threadId: "s1" });
    expect(k.ports.sends.at(-1)?.message.endsWith(text)).toBe(true);
    // The run the send started is the one that ends next.
    k.ports.runs.set("s1", sendRunId({ machineId: "lab-a", threadId: "s1" }, k.ports.sends.at(-1)!.id));
  };
  // Done after opening its PR: the findings start it again.
  k.ports.runs.set("s1", "r1");
  k.thread("thread.completed", "s1", { runId: "r1" });
  await until(() => k.t.get(writer.taskId)?.state === "done");
  await findings("Your PR has 1 blocking finding");
  expect(k.t.get(writer.taskId)?.attempt).toBe(2);
  // Its claude died and it waits to be resumed: the findings resume it now.
  const run = k.ports.runs.get("s1")!;
  k.thread("thread.failed", "s1", { runId: run, endCause: "exited", error: { class: "process_exited", message: "killed by signal 9" } });
  await until(() => k.t.get(writer.taskId)?.state === "queued");
  await findings("Your PR has 2 blocking findings");
  // Each time in the thread it had, in the repo's checkout: no second agent.
  expect(k.ports.launches).toHaveLength(1);
  k.hub.shutdown.abort();
});
