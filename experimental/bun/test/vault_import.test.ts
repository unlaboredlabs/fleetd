// 1Password as an optional source (src/hub/vault/import.ts): a lead searches (metadata only) and proposes; the person
// imports with one tap; values come sealed to the hub from a node holding their token and are never read again.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chat } from "../src/hub/chat/index.ts";
import { leadCalls, type LeadCaller } from "../src/hub/lead_calls/index.ts";
import { putToken } from "../src/hub/onepassword/index.ts";
import { registerLeadCalls } from "../src/hub/vault/import.ts";
import { ToolError } from "../src/shared/errors.ts";
import { M, PROJECT, type VaultHub, vaultHub } from "./vault-kit.ts";
import { refusal } from "./people-kit.ts";

let k: VaultHub;
const lead: LeadCaller = { projectRef: PROJECT, by: "lead:devbox/p1", agent: { kind: "lead" }, threadId: "t", via: M };
beforeEach(async () => {
  k = vaultHub();
  await k.v.load();
  registerLeadCalls(k.hub);
  putToken(k.hub.db, k.owner.personId, { fingerprint: "abcd1234", sealedOn: [{ machineId: M, fingerprint: "abcd1234" }], savedAt: new Date(0).toISOString() } as never);
  k.node.onepassword = {
    items: [
      { ref: "op://Fleet/Shop", title: "Shop", kind: "login", vault: "Fleet", sites: ["shop.example"] },
      { ref: "op://Fleet/Visa", title: "Visa", kind: "card", vault: "Fleet" },
    ],
    read: {
      "op://Fleet/Shop": { title: "Shop", sites: ["https://shop.example/login"], login: { username: "ada", password: "planted-op-1" } },
      "op://Fleet/Visa": { title: "Visa", card: { number: "4242424242424242", cvc: "123" } },
    },
  };
});
afterEach(() => k.done());

const call = async (op: string, input: Record<string, unknown>, caller = lead) => (await leadCalls(k.hub).handler(op)!(caller, { op, ...input } as never)) as Record<string, unknown>;

test("a lead searches metadata only, proposes, and the person's one tap imports them into the vault", async () => {
  const found = (await call("vault_import_search", { query: "shop" })) as { items: { ref: string; title: string }[] };
  expect(found.items.map((i) => i.ref)).toEqual(["op://Fleet/Shop", "op://Fleet/Visa"]);
  expect(JSON.stringify(found)).not.toContain("planted-op-1");
  const { proposalId } = (await call("vault_import_propose", { refs: ["op://Fleet/Shop", "op://Fleet/Visa"], why: "to sign in and pay" })) as { proposalId: string };
  const card = chat(k.hub).bySource(PROJECT, `vault_import:${proposalId}`)!;
  expect(card.vaultImport).toMatchObject({ proposalId, state: "open", scope: "person", items: [{ ref: "op://Fleet/Shop", title: "Shop", kind: "login", site: "shop.example" }, { ref: "op://Fleet/Visa", kind: "card" }] });
  // A task's agent can't search or propose.
  const task: LeadCaller = { ...lead, agent: { kind: "task", taskId: "T1" } };
  await expect(call("vault_import_propose", { refs: ["op://Fleet/Shop"], why: "x" }, task)).rejects.toBeInstanceOf(ToolError);
  const out = await k.call<{ items: { label: string; kind: string; meta: Record<string, unknown> }[]; errors: unknown[] }>(k.ownerDevice, "vault_import", { proposalId, refs: ["op://Fleet/Shop"] });
  expect(out.items.map((i) => [i.label, i.kind, i.meta.sites, i.meta.source])).toEqual([["Shop", "login", ["shop.example"], { kind: "1password", ref: "op://Fleet/Shop", importedMs: k.clock.now() }]]);
  expect(chat(k.hub).bySource(PROJECT, `vault_import:${proposalId}`)!.vaultImport).toMatchObject({ state: "imported", imported: 1 });
  expect((await refusal(k.call(k.ownerDevice, "vault_import", { proposalId }))).code).toBe("invalid");
  // Searching again marks it imported.
  const again = (await call("vault_import_search", { query: "" })) as { items: { ref: string; imported?: string }[] };
  expect(again.items.find((i) => i.ref === "op://Fleet/Shop")!.imported).toMatch(/^V[0-9a-f]{32}$/);
});

test("dismiss closes the card; the person's own pick needs no proposal; a search without a token says why", async () => {
  await call("vault_import_search", { query: "" });
  const { proposalId } = (await call("vault_import_propose", { refs: ["op://Fleet/Visa"], why: "to pay" })) as { proposalId: string };
  await k.call(k.ownerDevice, "vault_import", { proposalId, dismiss: true });
  expect(chat(k.hub).bySource(PROJECT, `vault_import:${proposalId}`)!.vaultImport).toMatchObject({ state: "dismissed" });
  const own = await k.call<{ items: { kind: string; meta: Record<string, unknown> }[] }>(k.ownerDevice, "vault_import", { refs: ["op://Fleet/Visa"] });
  expect(own.items[0]).toMatchObject({ kind: "card", meta: { brand: "visa", last4: "4242" } });
  const none = await k.call<{ items: unknown[]; error?: string }>(k.memberDevice, "vault_import_search", { query: "" });
  expect(none.error).toContain("No 1Password token");
});
