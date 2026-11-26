// `repo_create` (W762): a no-repo bot's lead makes a GitHub repo with the hub's own gh login, and the bot holds it as
// `repo_add` by URL adds one. Against a fake node and a stand-in gh: what GitHub is asked, the clone and its line, and
// each refusal (a name already taken, a permission the login lacks, gh signed out, a task, a bad call). And the
// no-repo lead's prompt that tells it when to offer a repo and the steps for a yes and a no.
import { expect, test } from "bun:test";
import { leadWakes, type Trigger } from "../src/hub/api/leads.ts";
import { chat } from "../src/hub/chat/index.ts";
import { executors } from "../src/hub/executor/index.ts";
import { leadCalls, type LeadResultFrame } from "../src/hub/lead_calls/index.ts";
import { renderLeadStart } from "../src/hub/leads/prompt.ts";
import { clones } from "../src/hub/projects/add.ts";
import { registerLeadCalls } from "../src/hub/projects/calls.ts";
import { addingGh } from "../src/hub/projects/discover.ts";
import { checkCreate, createRequest } from "../src/hub/projects/repo_create_rules.ts";
import { ENTRIES } from "../src/hub/prompts/entry.ts";
import { prompts } from "../src/hub/prompts/store.ts";
import * as repos from "../src/hub/repos/store.ts";
import { TrainGitHub } from "../src/hub/train/github.ts";
import type { ChatMessage } from "../src/shared/contracts.ts";
import { node, settle } from "./project-kit.ts";
import { AT, kit } from "./work-kit.ts";

const NOTES = { machineId: "devbox", projectId: "notes" };
const MADE = { kind: "repo_facts" as const, exists: true, isGit: true, remote: "https://github.com/ada/email-client", defaultBranch: "main", workflowFiles: [] };

/** What the stand-in gh answers: `[status, body]` by `METHOD path`, else 404. A `signedOut` gh fails every run as gh does. */
type Replies = Record<string, [number, unknown]>;

async function rig(replies: Replies, signedOut = false) {
  const k = kit();
  clones(k.hub);
  let cloned = false;
  const n = await node(k, ["repos", "project_env_copy"], (call) => {
    if (call.op === "repo_inspect" && call.path === "/home/me/src/email-client") return { ok: cloned ? MADE : { kind: "repo_facts", exists: false, isGit: false } };
    return undefined;
  });
  n.event({ type: "project_upserted", projectId: "notes", title: "Notes", workspaceRoot: "/home/me/notes", updatedAt: AT });
  await settle();
  const ran: string[][] = [];
  const runner = {
    run: async (args: string[]) => {
      ran.push(args);
      if (signedOut) return { exitCode: 4, stdout: "", stderr: "To get started with GitHub CLI, please run:  gh auth login" };
      const said = replies[`${args[3]} ${args[6]}`];
      const [status, body] = said ?? [404, { message: "Not Found" }];
      // A repo GitHub made is there from then on.
      const made = (body as { full_name?: string }).full_name;
      if (args[3] === "POST" && status < 300 && made) replies[`GET repos/${made}`] = [200, { ...(body as object), default_branch: "main", allow_squash_merge: true }];
      return { exitCode: status < 300 ? 0 : 1, stdout: `HTTP/2.0 ${status} X\r\n\r\n${JSON.stringify(body)}`, stderr: status < 300 ? "" : `gh: (HTTP ${status})` };
    },
  };
  const noFresh = { expect() {}, forget() {}, touch() {}, fail() {} };
  Object.assign(addingGh(k.hub), { github: () => new TrainGitHub(runner, noFresh, Date.now, async () => {}) });
  const ex = executors(k.hub);
  const real = ex.call.bind(ex);
  ex.call = (async (m, op, call, wait) => {
    if (call.op !== "repo_clone") return real(m, op, call, wait);
    cloned = true;
    return MADE;
  }) as typeof ex.call;
  k.hub.db.conn.run("INSERT INTO leads (machine_id, project_id, thread_id, started_at, session_generation) VALUES ('devbox', 'notes', 'th-lead', '', 1)");
  k.hub.db.conn.run(
    `INSERT INTO tasks (n, machine_id, project_id, workstream_id, state, thread_id, data) VALUES (4, 'devbox', 'notes', 'W1', 'running', 'th-task', '{"taskId":"T4","projectRef":{"machineId":"devbox","projectId":"notes"}}')`,
  );
  const wakes: Trigger[] = [];
  leadWakes(k.hub).trigger = (_r, t) => void wakes.push(t);
  registerLeadCalls(k.hub);
  const send = (threadId: string, call: Record<string, unknown>) =>
    leadCalls(k.hub).answer("devbox", { id: "c1", cwd: "/home/me/notes", call: call as never, threadId });
  const lines = () => chat(k.hub).page(NOTES, undefined, undefined, 50).messages.filter((m: ChatMessage) => m.setupChanged !== undefined);
  const names = () => repos.of(k.hub.db.conn, NOTES).map((r) => r.name);
  const posts = () => ran.filter((a) => a[3] === "POST");
  return { ...k, send, lines, names, posts, wakes };
}

const refusal = (frame: LeadResultFrame) => ("error" in frame ? frame.error : undefined);
const result = (frame: LeadResultFrame): Record<string, any> => {
  if ("error" in frame) throw new Error(JSON.stringify(frame.error));
  return frame.result;
};

const SIGNED_IN: Replies = { "GET user": [200, { login: "ada" }] };

test("a lead makes a private repo with the workspace's gh login, and the bot holds it once its clone ends", async () => {
  const replies: Replies = { ...SIGNED_IN, "POST user/repos": [201, { full_name: "ada/email-client", html_url: "https://github.com/ada/email-client" }] };
  const k = await rig(replies);
  const out = result(await k.send("th-lead", { op: "repo_create", name: "email-client", private: true, description: "Ada's mail" }));
  expect(out).toMatchObject({ created: "ada/email-client", url: "https://github.com/ada/email-client", private: true });
  expect(out.next).toStartWith("Created ada/email-client on GitHub, private, with a README as its first commit. ");
  const [post] = k.posts();
  expect(post?.slice(6)).toEqual(["user/repos", "-f", "name=email-client", "-f", "description=Ada's mail", "-F", "private=true", "-F", "auto_init=true"]);
  await settle();
  await settle();
  expect(k.names()).toEqual(["email-client"]);
  expect(k.lines().map((m) => m.text)).toEqual(["Added the repo email-client"]);
}, 15_000);

test("a repo already on GitHub, an org that refuses, gh signed out: each is refused with its fix, and nothing is added", async () => {
  const taken = await rig({ ...SIGNED_IN, "GET repos/ada/email-client": [200, { full_name: "ada/email-client" }] });
  const there = refusal(await taken.send("th-lead", { op: "repo_create", name: "email-client", private: false }));
  expect(there).toMatchObject({ code: "invalid", message: "ada/email-client already exists on GitHub." });
  expect(there?.fix).toContain("repo_add");
  expect(taken.posts()).toEqual([]);

  const org = await rig({ ...SIGNED_IN, "POST orgs/acme/repos": [403, { message: "You need admin access to the organization before adding a repository to it." }] });
  const refused = refusal(await org.send("th-lead", { op: "repo_create", name: "email-client", private: true, owner: "acme" }));
  expect(refused).toMatchObject({ code: "forbidden" });
  expect(refused?.message).toBe("The workspace's GitHub login ada may not create repos in acme: You need admin access to the organization before adding a repository to it.");
  expect(refused?.fix).toContain("An owner of acme lets ada create repos there");
  expect(org.names()).toEqual([]);

  const out = await rig({}, true);
  const signedOut = refusal(await out.send("th-lead", { op: "repo_create", name: "email-client", private: true }));
  expect(signedOut?.code).toBe("forbidden");
  expect(signedOut?.message).toContain("gh auth login");
  expect(signedOut?.message).not.toMatch(/token/i);
}, 15_000);

test("an organisation's policy refusal (GitHub's 422) says GitHub's own reason and is never offered a retry; an unknown organisation is named", async () => {
  // GitHub's real answer: the reason is in errors[], under a top-level "Repository creation failed."
  const policy = await rig({
    ...SIGNED_IN,
    "POST orgs/acme/repos": [
      422,
      {
        message: "Repository creation failed.",
        errors: [{ resource: "Repository", code: "custom", field: "visibility", message: "Due to policy, repository visibility can not be set to public." }],
        documentation_url: "https://docs.github.com/rest/repos/repos#create-an-organization-repository",
        status: "422",
      },
    ],
  });
  const refused = refusal(await policy.send("th-lead", { op: "repo_create", name: "open", private: false, owner: "acme" }));
  expect(refused).toMatchObject({ code: "forbidden", message: "GitHub refused to create acme/open (422): Repository creation failed: Due to policy, repository visibility can not be set to public." });
  expect(refused?.fix).toStartWith("Tell the person GitHub's words: acme's own settings on GitHub decide this");
  expect(refused?.fix).not.toMatch(/try again/i);
  expect(policy.names()).toEqual([]);

  // A name GitHub took between the lookup and the create: its 422 says so in errors[] too.
  const raced = await rig({
    ...SIGNED_IN,
    "POST user/repos": [422, { message: "Repository creation failed.", errors: [{ resource: "Repository", code: "custom", field: "name", message: "name already exists on this account" }] }],
  });
  expect(refusal(await raced.send("th-lead", { op: "repo_create", name: "email-client", private: true }))).toMatchObject({ code: "invalid", message: "ada/email-client already exists on GitHub." });

  // GitHub's 404 for an organisation is the same for a misspelled name and for one whose members don't include the
  // login: the line says both, and the fix keeps the owner's grant beside checking the name.
  const hidden = await rig({ ...SIGNED_IN, "POST orgs/acme/repos": [404, { message: "Not Found", documentation_url: "https://docs.github.com/rest/repos/repos#create-an-organization-repository", status: "404" }] });
  const unseen = refusal(await hidden.send("th-lead", { op: "repo_create", name: "open", private: true, owner: "acme" }));
  expect(unseen).toMatchObject({ code: "forbidden", message: "The workspace's GitHub login ada found no organisation acme it may create repos in: Not Found." });
  expect(unseen?.fix).toStartWith("Check the organisation's name with the person; if it is right: An owner of acme lets ada create repos there");
  expect(hidden.names()).toEqual([]);
}, 15_000);

test("only a lead makes a repo, and only with a name and private said", async () => {
  const k = await rig(SIGNED_IN);
  expect(refusal(await k.send("th-task", { op: "repo_create", name: "email-client", private: true }))?.code).toBe("forbidden");
  expect(refusal(await k.send("th-lead", { op: "repo_create", name: "email-client" }))?.code).toBe("invalid");
  expect(refusal(await k.send("th-lead", { op: "repo_create", name: "a b", private: true }))?.code).toBe("invalid");
  expect(k.posts()).toEqual([]);
  // The shared rules: the account's own repos at user/repos, an organisation's at its own, always with a README.
  const call = checkCreate({ name: "email-client", private: false });
  expect(createRequest(call, "ada")).toEqual({ path: "user/repos", body: { name: "email-client", private: false, auto_init: true } });
  expect(createRequest({ ...call, owner: "ADA" }, "ada").path).toBe("user/repos");
  expect(createRequest({ ...call, owner: "acme" }, "ada").path).toBe("orgs/acme/repos");
  expect(() => checkCreate({ name: "email-client", private: "yes" })).toThrow("Give private");
});

test("a no-repo lead's prompt offers a repo once for real software, with the steps for a yes and a no; a repo bot's lead has none of it", () => {
  const k = kit();
  const set = prompts(k.hub.db).current(NOTES);
  const own = renderLeadStart(set, NOTES, "Notes", [], "", "", "", "/home/me/notes").system;
  for (const line of [
    "When what you build for them turns into real software (an app, a service, a codebase of several files you'll keep changing), say so once, in one plain line, and ask",
    "history, reviews, agents working on it in parallel, and nothing is lost if this folder goes",
    "A small script, a document or a one-off file never gets this line.",
    "the question never holds the work up",
    "- No: carry on in your folder, `remember` (project scope) that they want no repo for that work, and never ask again for it.",
    "`repo_create` with a short name from the work and `private` as they said",
    "Never ask them for a token, or to make the repo by hand.",
    "put the zip in the chat with `chat_file`, and start a writer with `spawn_agent` on the new repo",
    "change it through agents (`spawn_agent` with the repo)",
  ]) {
    expect(own).toContain(line);
  }
  const lead = renderLeadStart(set, NOTES, "Notes", [], "", "", "", undefined).system;
  expect(lead).not.toContain("When the work becomes software");
  // Its rules' needles are in the text they guard.
  const entry = ENTRIES.find((e) => e.id === "assistant.start")!;
  for (const id of ["suggests-repo", "repo-on-yes"]) {
    const rule = entry.rules.find((r) => r.id === id)!;
    expect(entry.default).toMatch(new RegExp(rule.needle));
  }
});
