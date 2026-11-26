// `vault_store` on the workspace (src/hub/vault/agent_store.ts): the box key first, then a value sealed to it kept as a
// secret variable of the caller's bot, audited with the task that stored it, never answered back; and its refusals.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { leadCalls, type LeadCaller } from "../src/hub/lead_calls/index.ts";
import { registerLeadCalls } from "../src/hub/vault/calls.ts";
import { openSealed, publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import { ToolError } from "../src/shared/errors.ts";
import { M, OTHER, PROJECT, type VaultHub, vaultHub } from "./vault-kit.ts";

let k: VaultHub;
const task: LeadCaller = { projectRef: PROJECT, by: "lead:devbox/p1", agent: { kind: "task", taskId: "T7" }, via: M };
const VALUE = "AGE-SECRET-KEY-1PLANTED0VALUE0NEVER0SHOWN";

beforeEach(async () => {
  k = vaultHub();
  await k.v.load();
  registerLeadCalls(k.hub);
});
afterEach(() => k.done());

const store = async (call: Record<string, unknown>, caller: LeadCaller = task) =>
  (await leadCalls(k.hub).handler("vault_store")!(caller, { op: "vault_store", ...call } as never)) as Record<string, unknown>;
const sealed = (value: string | Uint8Array, to = k.hubPub()) => Buffer.from(seal(to, typeof value === "string" ? Buffer.from(value) : value)).toString("base64");
const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    if (e instanceof ToolError) return e;
    throw e;
  }
  throw new Error("expected a refusal");
};
const fp = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 8);

test("without sealed it answers the box key and stores nothing; sealed, a secret variable of the caller's bot", async () => {
  const key = await store({ name: "CLOUD_DR_AGE_KEY" });
  expect(key).toEqual({ name: "CLOUD_DR_AGE_KEY", sealTo: Buffer.from(k.hubPub()).toString("base64") });
  expect(k.hub.db.all("SELECT 1 FROM vault_items")).toHaveLength(0);

  const out = await store({ name: "CLOUD_DR_AGE_KEY", sealed: sealed(VALUE, new Uint8Array(Buffer.from(String(key.sealTo), "base64"))), note: "DR age key" });
  expect(out).toMatchObject({ name: "CLOUD_DR_AGE_KEY", fingerprint: fp(VALUE), bytes: VALUE.length });
  expect(JSON.stringify(out)).not.toContain(VALUE);

  const row = k.v.store.get(String(out.itemId))!;
  expect(row).toMatchObject({ kind: "env", scope: "project", machineId: M, projectId: PROJECT.projectId, envName: "CLOUD_DR_AGE_KEY" });
  expect(row.meta.secret).toBe(true);
  expect(k.v.store.open(row).value).toBe(VALUE);
  // Kept sealed at rest, like every item.
  expect(Buffer.from(row.sealed).toString("utf8")).not.toContain(VALUE);

  // The audit names the task and the note, never the value.
  const audit = k.hub.db.all<{ action: string; task_id: string | null; data: string }>("SELECT action, task_id, data FROM vault_audit WHERE item_id = ? ORDER BY n", [row.itemId]);
  expect(audit.map((a) => [a.action, a.task_id])).toEqual([["create", "T7"], ["deliver", null]]);
  expect(JSON.parse(audit[0]!.data)).toMatchObject({ names: ["CLOUD_DR_AGE_KEY"], via: "vault_store", message: "DR age key" });
  for (const a of audit) expect(a.data).not.toContain(VALUE);
  // Delivered to the bot's machine like any of its variables, sealed to that node.
  expect(k.node.projectFiles.get(PROJECT.projectId)?.get("CLOUD_DR_AGE_KEY")).toBe(VALUE);

  // The owner reveals it on their device; an agent's key never reaches the vault's tools.
  const reply = crypto.getRandomValues(new Uint8Array(32));
  const shown = await k.call<{ sealed: string }>(k.ownerDevice, "vault_reveal", { itemId: row.itemId, fields: ["value"], replyKey: Buffer.from(publicKeyOf(reply)).toString("base64") });
  expect(JSON.parse(Buffer.from(openSealed(reply, new Uint8Array(Buffer.from(shown.sealed, "base64")))!).toString("utf8"))).toEqual({ value: VALUE });
  expect((await refused(k.call(k.agent(), "vault_reveal", { itemId: row.itemId, fields: ["value"], replyKey: "x" }))).code).toBe("forbidden");
});

test("refused: a name the bot has, a bad or reserved name, a value not sealed to the workspace, too big, a person's shell", async () => {
  await store({ name: "TOKEN", sealed: sealed("first") });
  const again = await refused(store({ name: "TOKEN", sealed: sealed("second") }));
  expect(again.message).toContain("has a variable TOKEN already");
  expect((await refused(store({ name: "TOKEN" }))).code).toBe("invalid");
  // Another bot's variable of the same name is another variable.
  expect((await store({ name: "TOKEN", sealed: sealed("other") }, { ...task, projectRef: OTHER })).fingerprint).toBe(fp("other"));

  expect((await refused(store({ name: "1BAD", sealed: sealed("x") }))).code).toBe("invalid");
  expect((await refused(store({ name: "FLEETD_THREAD_ID", sealed: sealed("x") }))).code).toBe("invalid");
  const elsewhere = publicKeyOf(crypto.getRandomValues(new Uint8Array(32)));
  expect((await refused(store({ name: "WRONG_KEY", sealed: sealed("x", elsewhere) }))).message).toContain("wasn't sealed to this workspace's key");
  expect((await refused(store({ name: "BIG", sealed: sealed("x".repeat(64 * 1024 + 1)) }))).code).toBe("invalid");
  expect((await refused(store({ name: "BINARY", sealed: sealed(new Uint8Array([0xff, 0xfe])) }))).message).toContain("UTF-8");
  // Names that run code in later sessions: refused even for the box key, so nothing is sealed for them.
  for (const risky of ["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV", "NODE_OPTIONS", "PYTHONSTARTUP", "GIT_SSH_COMMAND", "GIT_CONFIG_GLOBAL", "PROMPT_COMMAND"]) {
    expect((await refused(store({ name: risky }))).message).toBe(`${risky} changes what later sessions run: an agent can't store it.`);
  }
  expect((await refused(store({ name: "PATH" }))).message).toContain("fleetd's or claude's own");
  // A plain name that merely starts like one is fine.
  expect((await store({ name: "GITHUB_TOKEN" })).sealTo).toBeString();
  const shell = await refused(store({ name: "MINE", sealed: sealed("x") }, { ...task, agent: { kind: "person" } }));
  expect(shell.code).toBe("forbidden");
  expect(k.v.store.select("kind = 'env' AND env_name IN ('1BAD', 'WRONG_KEY', 'BIG', 'BINARY', 'MINE')", [])).toHaveLength(0);
});

test("the value is worked out of the file's bytes: one leading BOM and one trailing newline go", async () => {
  const out = await store({ name: "WITH_BOM", sealed: sealed(`\uFEFF${VALUE}\n`) });
  expect(out.fingerprint).toBe(fp(VALUE));
  expect(k.v.store.open(k.v.store.get(String(out.itemId))!).value).toBe(VALUE);
  expect((await refused(store({ name: "ONLY_NEWLINE", sealed: sealed("\n") }))).message).toBe("The value is empty.");
  expect((await refused(store({ name: "NUL", sealed: sealed("a\0b") }))).message).toContain("NUL");
});

test("a lead stores too, audited with no task", async () => {
  const lead: LeadCaller = { ...task, agent: { kind: "lead" } };
  const out = await store({ name: "LEAD_KEY", sealed: sealed("lead-value") }, lead);
  const audit = k.hub.db.all<{ action: string; task_id: string | null }>("SELECT action, task_id FROM vault_audit WHERE item_id = ? AND action = 'create'", [String(out.itemId)]);
  expect(audit).toEqual([{ action: "create", task_id: null }]);
});
