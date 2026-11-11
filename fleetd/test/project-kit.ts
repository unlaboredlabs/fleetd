// devbox's node and gh on the hub, as the project tests fake them (project_add.test.ts, project_setup.test.ts).
import type { Hub } from "../src/hub/api/hub.ts";
import { executors } from "../src/hub/executor/index.ts";
import { link } from "../src/hub/link/index.ts";
import { addingGh } from "../src/hub/projects/discover.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { TrainGitHub } from "../src/hub/train/github.ts";
import type { SessionCall, SessionReplyFrame } from "../src/shared/sessions.ts";
import { AT } from "./work-kit.ts";

export const ROOT = "/home/me/fleetd/projects";
export const settle = () => Bun.sleep(5);
export type Answer = (call: SessionCall) => SessionReplyFrame["result"] | undefined;

/** devbox's node, listing `caps`: answers each call with `answer`, else the defaults below, and records them. */
export async function node(k: { hub: Hub }, caps: string[], answer: Answer = () => undefined) {
  store(k.hub).machineUpsert({ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT });
  const ex = executors(k.hub);
  const calls: SessionCall[] = [];
  // Each folder made, and whether git init ran in it.
  const made = new Map<string, boolean>();
  let seq = 1;
  const event = (e: unknown) => ex.handleFrame("devbox", { t: "machine_event", seq: ++seq, at: AT, event: e as never });
  const defaults = (call: SessionCall): SessionReplyFrame["result"] => {
    switch (call.op) {
      case "repo_scan":
        return { ok: { kind: "repos", cloneRoot: "/home/me/src", repos: [], projectsRoot: ROOT } };
      case "folder_make":
        if (call.path === `${ROOT}/full`) return { err: { code: "invalid", message: `folder not empty: ${call.path}` } };
        if (!call.dryRun) made.set(call.path, call.gitInit === true);
        return { ok: { kind: "folder", path: call.path } };
      case "repo_inspect": {
        const git = made.get(call.path);
        return { ok: { kind: "repo_facts", exists: git !== undefined, isGit: git === true, workflowFiles: [] } };
      }
      case "project_upsert":
        event({ type: "project_upserted", projectId: call.projectId, title: call.title, workspaceRoot: call.workspaceRoot, updatedAt: AT });
        return { ok: { kind: "done" } };
      case "project_remove":
        event({ type: "project_removed", projectId: call.projectId });
        return { ok: { kind: "done" } };
      default:
        return { ok: { kind: "done" } };
    }
  };
  ex.attach("devbox", {
    linkId: 1,
    send(frame) {
      if (frame.call.op !== "subscribe") calls.push(frame.call);
      queueMicrotask(() => ex.handleFrame("devbox", { t: "session_reply", id: frame.id, result: answer(frame.call) ?? defaults(frame.call) }));
    },
  });
  await ex.awaitLive("devbox");
  event({ type: "snapshot", projects: [], sessions: [] });
  (link(k.hub) as unknown as { capabilities: Map<string, Set<string>> }).capabilities.set("devbox", new Set(caps));
  await settle();
  return { calls, made, event };
}

/** gh on the hub answering `paths` (404 for any other), and no `gh repo list`. */
export function gh(k: { hub: Hub }, paths: Record<string, unknown>) {
  const noFresh = { expect() {}, forget() {}, touch() {}, fail() {} };
  const runner = {
    run: async (args: string[]) => {
      const path = args[args.length - 1] as string;
      return path in paths
        ? { exitCode: 0, stdout: JSON.stringify(paths[path]), stderr: "" }
        : { exitCode: 1, stdout: '{"message":"Not Found"}', stderr: "gh: Not Found (HTTP 404)" };
    },
  };
  Object.assign(addingGh(k.hub), {
    github: () => new TrainGitHub(runner, noFresh, Date.now, async () => {}),
    repoList: async () => ({ owners: [], repos: [], problem: "gh is not logged in" }),
  });
}
