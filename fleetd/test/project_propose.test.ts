// A lead proposes a new project (`project_propose`, W614, D448) against a fake node: the card its prompt becomes in
// every approval mode, what a person's Approve makes and whose it is, Deny, a clone's end and failure, and every
// refusal: to a task, to a call with no approval behind it, and to what could not be made.
import { expect, test } from "bun:test";
import { leadWakes, type Trigger } from "../src/hub/api/leads.ts";
import { approvals, PROJECT_PROPOSE_TOOL } from "../src/hub/approvals/index.ts";
import { checksDone, onThreadEvent } from "../src/hub/approvals/permissions.ts";
import { executors } from "../src/hub/executor/index.ts";
import { leadCalls, type LeadResultFrame } from "../src/hub/lead_calls/index.ts";
import { start as startLeadArea } from "../src/hub/navi/loops.ts";
import { clones } from "../src/hub/projects/add.ts";
import { registerLeadCalls } from "../src/hub/projects/calls.ts";
import { PEOPLE_ONLY } from "../src/hub/projects/people_only.ts";
import { store } from "../src/hub/store/hub_store.ts";
import { type Answer, gh, node, ROOT, settle } from "./project-kit.ts";
import { AT, key, kit } from "./work-kit.ts";

const NOTES = { machineId: "devbox", projectId: "notes" };
const ada = key("operate", { human: true, person: { personId: "p-ada", name: "Ada" } });
const grace = key("operate", { human: true, name: "phone", person: { personId: "p-grace", name: "Grace" } });
const BILLING = { kind: "repo_facts" as const, exists: true, isGit: true, remote: "https://github.com/acme/billing", defaultBranch: "main", workflowFiles: [] };
const WHAT = "A new project on devbox, once you approve. Everyone on this hub can use it. Nothing is made before that.";
const WHAT_CLONED = "A new project on devbox, cloned from acme/billing once you approve. Everyone on this hub can use it. Nothing is made before that.";

/** Notes on devbox with its lead (th-lead) and a task of it (T4, th-task), the wakes its lead gets, and its prompts. */
async function rig(answer: Answer = () => undefined) {
  const k = kit();
  clones(k.hub);
  const n = await node(k, ["repos", "folder_make"], answer);
  gh(k, { "repos/acme/billing": { default_branch: "main", allow_squash_merge: true } });
  n.event({ type: "project_upserted", projectId: "notes", title: "Notes", workspaceRoot: "/home/me/notes", updatedAt: AT });
  await settle();
  const db = k.hub.db.conn;
  db.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'notes', 'th-lead', '', 1)");
  db.run(
    `INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, thread_id, data) VALUES (4, 'devbox', 'notes', 'W1', 'running', 'th-task', '{"taskId":"T4","projectRef":{"machineId":"devbox","projectId":"notes"}}')`,
  );
  const wakes: Trigger[] = [];
  leadWakes(k.hub).trigger = (_r, t) => void wakes.push(t);
  startLeadArea(k.hub);
  registerLeadCalls(k.hub);
  const a = approvals(k.hub);
  const send = (threadId: string | undefined, call: Record<string, unknown>) =>
    leadCalls(k.hub).answer("devbox", { id: "c1", cwd: "/home/me/notes", call: call as never, ...(threadId === undefined ? {} : { threadId }) });
  /** The prompt `project_propose` is in `threadId`'s session: the card it became, or the node's answer to it. */
  const prompt = async (requestId: string, input: unknown, threadId = "th-lead") => {
    const data = { permission: { requestId, toolName: PROJECT_PROPOSE_TOOL, summary: "", input } };
    await onThreadEvent(a, { seq: 1, at: AT, type: "thread.waiting", machineId: "devbox", projectId: "notes", threadId, summary: "", data });
    await checksDone(a);
    return { card: a.listQuiet({ kind: "approval" }).find((q) => q.permission?.requestId === requestId), answer: answered(requestId) };
  };
  /** The node's answer to a prompt: allow, or deny with its words. */
  const answered = (requestId: string) => {
    const got = n.calls.filter((c) => c.op === "answer" && c.requestId === requestId).at(-1);
    return got?.op === "answer" ? [got.decision.behavior, "message" in got.decision ? got.decision.message : undefined] : undefined;
  };
  const tap = (by: typeof ada, requestId: string, decision: "approve" | "deny") => k.ok(by, "approval_answer", { requestId, decision });
  /** Every project of the machine but Notes, and whether the hub marks it Only me (it never does since D491). */
  const made = () =>
    store(k.hub)
      .projectsList()
      .filter((p) => p.projectId !== "notes")
      .map((p) => {
        const row = db.query<{ only_me: number }, [string]>("SELECT only_me FROM project_settings WHERE project_id = ?").get(p.projectId);
        return { title: p.title, path: p.workspaceRoot, onlyMe: row?.only_me === 1 };
      });
  const mode = (m: "ask" | "checker" | "yolo") => k.ok(ada, "project_approvals_set", { ...NOTES, mode: m });
  return { ...k, n, db, a, wakes, send, prompt, answered, tap, made, mode };
}

const refusal = (frame: LeadResultFrame) => ("error" in frame ? frame.error : undefined);
const result = (frame: LeadResultFrame) => ("result" in frame ? frame.result : undefined);

test("a proposal is one card in every approval mode, YOLO too, and nothing is made before a person answers it", async () => {
  const k = await rig();
  try {
    for (const [i, m] of (["ask", "checker", "yolo"] as const).entries()) {
      await k.mode(m);
      const { card, answer } = await k.prompt(`p-${i}`, { title: ` Billing ${i} ` });
      // No rule, no checker and no YOLO answered it: it waits for a person.
      expect(answer).toBeUndefined();
      expect(card?.state).toBe("open");
      expect(card?.permission?.preview).toEqual({
        server: "fleetd",
        tool: "project_propose",
        action: "write",
        title: `Create the project “Billing ${i}”`,
        // onlyMe false for one release: an older app shows the card as New project only with it.
        input: JSON.stringify({ machineId: "devbox", onlyMe: false, path: `${ROOT}/billing-${i}`, repo: null, title: `Billing ${i}`, what: WHAT }, null, 2),
      });
    }
    expect(k.made()).toEqual([]);
    // The card's check made nothing on the machine.
    expect(k.n.calls.filter((c) => c.op === "folder_make" && !c.dryRun)).toEqual([]);
    expect(k.n.calls.filter((c) => c.op === "project_upsert")).toEqual([]);
    expect(k.db.query("SELECT COUNT(*) AS n FROM project_auto_approved").get()).toEqual({ n: 0 });
  } finally {
    k.hub.shutdown.abort();
  }
});

test("a person's Approve makes the project, theirs; the lead's call then returns it, once", async () => {
  const k = await rig();
  try {
    await k.mode("yolo");
    const { card } = await k.prompt("p-1", { title: "Billing" });
    const id = card?.requestId as string;
    // Only a person answers it: an agent's key is refused, and nothing is made.
    expect(await k.refused(key("operate"), "approval_answer", { requestId: id, decision: "approve" })).toBe("forbidden");
    expect(k.made()).toEqual([]);
    await k.tap(grace, id, "approve");
    await settle();
    // Made as a project Grace, who tapped, made herself: open to everyone on the hub, with no repo too (D491).
    expect(k.made()).toEqual([{ title: "Billing", path: `${ROOT}/billing`, onlyMe: false }]);
    expect(k.a.get(id)?.state).toBe("approved");
    expect(k.answered("p-1")).toEqual(["allow", undefined]);
    // The call the prompt let through returns what was made, and only once.
    const out = result(await k.send("th-lead", { op: "project_propose", title: "Billing" }));
    expect(out).toMatchObject({ created: true, title: "Billing", path: `${ROOT}/billing` });
    expect(out?.next).toBe(`Billing is a project now, at ${ROOT}/billing on devbox, in everyone's list of projects; its own lead starts with their first message there.`);
    expect(refusal(await k.send("th-lead", { op: "project_propose", title: "Billing" }))?.code).toBe("forbidden");
    expect(k.made()).toHaveLength(1);
    // The same card approved again (its answer undelivered) makes no second one.
    const shown = JSON.parse(card?.permission?.preview?.input as string);
    expect(await k.a.deps.hooks.projectProposed(NOTES, shown, { name: "phone", person: { personId: "p-grace", name: "Grace" } }, id)).toBeUndefined();
    expect(k.made()).toHaveLength(1);
    expect(k.n.calls.filter((c) => c.op === "folder_make" && !c.dryRun)).toHaveLength(1);
  } finally {
    k.hub.shutdown.abort();
  }
});

test("denied, nothing is made, in YOLO as in any mode; and the call itself never makes one", async () => {
  const k = await rig();
  try {
    for (const [i, m] of (["ask", "yolo"] as const).entries()) {
      await k.mode(m);
      const { card } = await k.prompt(`p-${i}`, { title: "Billing" });
      await k.tap(ada, card?.requestId as string, "deny");
      expect(k.a.get(card?.requestId as string)?.state).toBe("denied");
      expect(k.answered(`p-${i}`)?.[0]).toBe("deny");
    }
    expect(k.made()).toEqual([]);
    // A lead's call with no approval behind it (a prompt it went around) makes nothing and says so.
    const direct = refusal(await k.send("th-lead", { op: "project_propose", title: "Billing" }));
    expect([direct?.code, direct?.message]).toEqual([
      "forbidden",
      "Nothing was created: no approval of a project named Billing is waiting here. Only a person's Approve on the card project_propose shows them makes one.",
    ]);
    // No setup call makes one either: it is refused with the line that names the proposal.
    expect(refusal(await k.send("th-lead", { op: "project_setup", create: true, title: "Billing" }))?.message).toBe(`project_setup has no create. ${PEOPLE_ONLY.create}`);
    expect(PEOPLE_ONLY.create).toContain("project_propose");
    expect(k.made()).toEqual([]);
    expect(k.n.calls.filter((c) => c.op === "folder_make" && !c.dryRun)).toEqual([]);
  } finally {
    k.hub.shutdown.abort();
  }
});

test("a task can't propose a project: its call is refused, and its prompt is no card", async () => {
  const k = await rig();
  try {
    expect(refusal(await k.send("th-task", { op: "project_propose", title: "Billing" }))?.message).toBe("project_propose is a lead's call, and T4 is a task.");
    const { card, answer } = await k.prompt("p-1", { title: "Billing" }, "th-task");
    expect([card, answer]).toEqual([undefined, undefined]);
    // A person's shell, with no session, is no lead either.
    const shell = refusal(await k.send(undefined, { op: "project_propose", title: "Billing" }));
    expect([shell?.message, shell?.fix]).toEqual(["project_propose is a project's lead's call, from its own session.", "A person makes a project themselves with New project in the app."]);
    expect(k.made()).toEqual([]);
  } finally {
    k.hub.shutdown.abort();
  }
});

test("what could not be made is refused before a person is asked", async () => {
  const k = await rig((call) => {
    if (call.op === "repo_inspect" && call.path === "/home/me/src/billing") return { ok: BILLING };
    return undefined;
  });
  try {
    const denied = async (id: string, input: unknown) => {
      const { card, answer } = await k.prompt(id, input);
      expect(card).toBeUndefined();
      expect(answer?.[0]).toBe("deny");
      return answer?.[1];
    };
    expect(await denied("p-1", { title: "  " })).toBe(
      "Blocked by fleetd: no card was shown. Give title: the new project's name, on one line of at most 200 characters. Propose it under another title, or: The person makes it themselves with New project in the app.",
    );
    expect(await denied("p-2", { title: "Two\nlines" })).toContain("on one line");
    // A folder that holds files already, a repository gh can't see, and a clone's folder that is taken.
    expect(await denied("p-3", { title: "Full" })).toContain(`${ROOT}/full on devbox already holds files. Propose it under another title`);
    expect(await denied("p-4", { title: "Secret", url: "acme/secret" })).toContain("acme/secret");
    expect(await denied("p-5", { title: "Billing", url: "https://github.com/acme/billing" })).toBe(
      "Blocked by fleetd: no card was shown. /home/me/src/billing already exists on devbox, so acme/billing can't be cloned there. " +
        "The person makes it themselves with New project in the app, where a checkout that is there can be added as it is.",
    );
    expect(k.a.listQuiet({ kind: "approval" })).toEqual([]);
    expect(k.made()).toEqual([]);
  } finally {
    k.hub.shutdown.abort();
  }
});

test("a project that can't be made once approved is said on the card and to the lead, and none exists", async () => {
  let taken = false;
  const k = await rig((call) => {
    if (taken && call.op === "folder_make") return { err: { code: "invalid", message: `folder not empty: ${call.path}` } };
    return undefined;
  });
  try {
    const { card } = await k.prompt("p-1", { title: "Billing" });
    const id = card?.requestId as string;
    // Files landed in the folder between the card and the tap.
    taken = true;
    await k.tap(ada, id, "approve");
    const why = `the project was not created: ${ROOT}/billing on devbox already holds files. Propose it again once that is sorted, or: The person makes it themselves with New project in the app`;
    expect([k.a.get(id)?.state, k.a.get(id)?.evidence]).toEqual(["failed", why]);
    expect(k.answered("p-1")).toEqual(["deny", `human:desk approved it (${id}), but ${why}`]);
    expect(k.made()).toEqual([]);
    expect(refusal(await k.send("th-lead", { op: "project_propose", title: "Billing" }))?.code).toBe("forbidden");
  } finally {
    k.hub.shutdown.abort();
  }
});

test("a proposal with a repo clones it once approved: the project exists when the clone ends, and the lead is woken", async () => {
  let cloned: (() => void) | undefined;
  const k = await rig((call) => {
    if (call.op === "repo_inspect" && call.path === "/home/me/src/billing") return cloned === undefined ? { ok: { kind: "repo_facts", exists: false, isGit: false } } : { ok: BILLING };
    return undefined;
  });
  try {
    const ex = executors(k.hub);
    const real = ex.call.bind(ex);
    ex.call = (async (m, op, call, wait) => {
      if (call.op !== "repo_clone") return real(m, op, call, wait);
      k.n.calls.push(call);
      return new Promise((resolve) => {
        cloned = () => resolve(BILLING);
      });
    }) as typeof ex.call;
    await k.mode("yolo");
    const { card } = await k.prompt("p-1", { title: "Billing", url: "https://github.com/acme/billing" });
    expect(card?.permission?.preview?.input).toBe(JSON.stringify({ machineId: "devbox", onlyMe: false, path: "/home/me/src/billing", repo: "acme/billing", title: "Billing", what: WHAT_CLONED }, null, 2));
    // Nothing is cloned for a card.
    expect(k.n.calls.filter((c) => c.op === "repo_clone")).toEqual([]);
    await k.tap(ada, card?.requestId as string, "approve");
    expect(k.n.calls.find((c) => c.op === "repo_clone")).toMatchObject({ dest: "/home/me/src/billing" });
    expect(k.answered("p-1")).toEqual(["allow", undefined]);
    const out = result(await k.send("th-lead", { op: "project_propose", title: "Billing", url: "https://github.com/acme/billing" }));
    expect(out).toMatchObject({ cloning: true, title: "Billing", path: "/home/me/src/billing" });
    expect(out?.next).toContain("You are woken when it ends, or when it fails: tell the person then, and never before that it exists.");
    // No project and no wake until the clone ends; a restart meanwhile would find its row.
    expect([k.made(), k.wakes]).toEqual([[], []]);
    expect(k.db.query("SELECT machine_id, project_id, repo, path, proposed FROM project_setup_clones").all()).toEqual([
      { machine_id: "devbox", project_id: "notes", repo: "acme/billing", path: "/home/me/src/billing", proposed: "Billing" },
    ]);
    cloned?.();
    await settle();
    await settle();
    // A project with a repo is as one Ada added herself: open to everyone on the hub.
    expect(k.made()).toEqual([{ title: "Billing", path: "/home/me/src/billing", onlyMe: false }]);
    expect(k.wakes).toHaveLength(1);
    expect(k.wakes[0]).toMatchObject({ kind: "line", line: "request" });
    expect((k.wakes[0] as { text: string }).text).toMatch(
      /^project_propose: acme\/billing is cloned, and Billing is a project now \(.+\), at \/home\/me\/src\/billing on devbox, as one Ada added themselves; its own lead starts with their first message there\.$/u,
    );
    expect(k.db.query("SELECT COUNT(*) AS n FROM project_setup_clones").get()).toEqual({ n: 0 });
  } finally {
    k.hub.shutdown.abort();
  }
});

test("an approved proposal's clone that fails wakes the lead with why, and no project exists", async () => {
  const k = await rig((call) => {
    if (call.op === "repo_inspect" && call.path === "/home/me/src/billing") return { ok: { kind: "repo_facts", exists: false, isGit: false } };
    if (call.op === "repo_clone") return { err: { code: "git", message: "repository 'https://github.com/acme/billing/' not found" } };
    return undefined;
  });
  try {
    const { card } = await k.prompt("p-1", { title: "Billing", url: "acme/billing" });
    await k.tap(ada, card?.requestId as string, "approve");
    await settle();
    expect(k.made()).toEqual([]);
    expect(k.wakes).toEqual([
      {
        kind: "line",
        line: "request",
        text:
          "project_propose: the project Billing was not created. cloning acme/billing on devbox failed: repository 'https://github.com/acme/billing/' not found " +
          "On devbox, run `gh auth login` with an account that can read acme/billing, then add it again. Tell the person.",
      },
    ]);
    expect(k.db.query("SELECT COUNT(*) AS n FROM project_setup_clones").get()).toEqual({ n: 0 });
  } finally {
    k.hub.shutdown.abort();
  }
});

test("a lead whose proposal's clone a hub restart cut off is told at the hub's next start", async () => {
  const k = await rig();
  try {
    k.db.run("INSERT INTO project_setup_clones (add_id, machine_id, project_id, repo, path, proposed) VALUES ('a1', 'devbox', 'notes', 'acme/billing', '/home/me/src/billing', 'Billing')");
    registerLeadCalls(k.hub);
    expect(k.wakes).toEqual([
      {
        kind: "line",
        line: "request",
        text:
          "project_propose: the hub restarted while cloning acme/billing into /home/me/src/billing, so the project Billing was not created. " +
          "Tell the person: they can add it with New project in the app, where a clone that finished on the machine is added as it is.",
      },
    ]);
    expect(k.db.query("SELECT COUNT(*) AS n FROM project_setup_clones").get()).toEqual({ n: 0 });
  } finally {
    k.hub.shutdown.abort();
  }
});
