// The vault's promise, checked end to end: planted values go through save, list, fill, variables, reveal, import,
// adoption, a secret request, a purchase and a rotation, and never show up in a log line, an event, the chat, the
// audit, any tool or call answer other than the sealed boxes, or any byte of the hub's database.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { approvals } from "../src/hub/approvals/index.ts";
import { leadCalls, type LeadCaller } from "../src/hub/lead_calls/index.ts";
import { answer, start as startPurchases } from "../src/hub/navi/purchases.ts";
import { putToken } from "../src/hub/onepassword/index.ts";
import { deliveries } from "../src/hub/vault/deliver.ts";
import { injected, start as startVault } from "../src/hub/vault/loops.ts";
import { adopt } from "../src/hub/vault/migrate.ts";
import { openSealed, publicKeyOf, seal } from "../src/shared/sealed_box.ts";
import { browserSession, M, PROJECT, type VaultHub, vaultHub } from "./vault-kit.ts";

const CANARIES = {
  password: "canary-pw-Zq81x",
  card: "4000056655665556",
  env: "canary-env-Pp42",
  address: "canary 77 Quiet Lane",
  imported: "canary-op-Lm03",
  sink: "canary-sink-Rr55",
  adopted: "canary-adopt-Tt66",
  order: "canary-order-Ww77",
};

let k: VaultHub;
const logged: string[] = [];
const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
beforeEach(async () => {
  logged.length = 0;
  for (const name of Object.keys(originals) as (keyof typeof originals)[]) {
    console[name] = (...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  }
  k = vaultHub();
  startVault(k.hub);
  startPurchases(k.hub);
  await k.v.load();
});
afterEach(() => {
  Object.assign(console, originals);
  k.done();
});

const b64 = (b: Uint8Array) => Buffer.from(b).toString("base64");
const fp = (v: string) => new Bun.CryptoHasher("sha256").update(v).digest("hex").slice(0, 8);

test("no planted value reaches logs, events, chat, audit, answers or the database", async () => {
  const answers: unknown[] = [];
  const keep = <T>(x: T) => {
    answers.push(x);
    return x;
  };
  const save = (input: Record<string, unknown>) => k.call<{ item: { itemId: string } }>(k.ownerDevice, "vault_save", input).then(keep);
  const login = await save({ kind: "login", label: "Shop", sites: ["shop.example"], sealed: k.sealToHub({ username: "ada", password: CANARIES.password }) });
  const card = await save({ kind: "card", label: "Visa", sealed: k.sealToHub({ number: CANARIES.card, month: "01", year: "2030", cvc: "917" }) });
  await save({ kind: "address", label: "Home", sites: ["shop.example"], sealed: k.sealToHub({ line1: CANARIES.address, country: "US" }) });
  await save({ kind: "env", scope: "project", ...PROJECT, envName: "API_KEY", sealed: k.sealToHub({ value: CANARIES.env }) });
  keep(await k.call(k.ownerDevice, "vault_list", {}));
  keep(await k.call(k.ownerDevice, "vault_get", { itemId: login.item.itemId }));
  keep(await k.call(k.ownerDevice, "vault_status", {}));

  // Fills: the value only in the box sealed to the node.
  browserSession(k, "B0123456789abcdef0123456789abcdef");
  const lead: LeadCaller = { projectRef: PROJECT, by: "lead:devbox/p1", agent: { kind: "lead" }, threadId: "t", via: M };
  const fill = async (input: Record<string, unknown>) =>
    (await leadCalls(k.hub).handler("vault_fill")!(lead, { op: "vault_fill", sessionId: "B0123456789abcdef0123456789abcdef", ...input } as never)) as { sealed: string; auditId: number };
  const filled = await fill({ item: "Shop", field: "password", page: "https://shop.example/" });
  expect(JSON.parse(k.open(filled.sealed)).value).toBe(CANARIES.password);
  answers.push({ ...filled, sealed: undefined });
  await leadCalls(k.hub).handler("vault_filled")!(lead, { op: "vault_filled", auditId: filled.auditId, ok: true, typed: true, message: "typed into #password" } as never);
  const addr = await fill({ item: "Home", field: "address", page: "https://shop.example/checkout" });
  answers.push({ ...addr, sealed: undefined });
  await expect(fill({ item: "Shop", field: "password", page: "https://evil.test/" })).rejects.toThrow();
  answers.push(await leadCalls(k.hub).handler("vault_items")!(lead, { op: "vault_items" } as never));

  // Variables: delivered to the node file, an inject row with names only.
  await deliveries(k.hub).reconcile(M);
  expect(k.node.projectFiles.get("p1")!.get("API_KEY")).toBe(CANARIES.env);
  injected(k.hub, PROJECT, undefined, "t");

  // Reveal: only inside the box sealed to the device's one-time key.
  const reply = crypto.getRandomValues(new Uint8Array(32));
  const revealed = await k.call<{ sealed: string }>(k.ownerDevice, "vault_reveal", { itemId: card.item.itemId, fields: ["number"], replyKey: b64(publicKeyOf(reply)) });
  expect(Buffer.from(openSealed(reply, new Uint8Array(Buffer.from(revealed.sealed, "base64")))!).toString()).toContain(CANARIES.card);

  // Import from 1Password, sealed to the hub by the node.
  putToken(k.hub.db, k.owner.personId, { fingerprint: "abcd1234", sealedOn: [{ machineId: M, fingerprint: "abcd1234" }], savedAt: new Date(0).toISOString() } as never);
  k.node.onepassword = {
    items: [{ ref: "op://Fleet/Mail", title: "Mail", kind: "login", vault: "Fleet", sites: ["mail.example"] }],
    read: { "op://Fleet/Mail": { title: "Mail", sites: ["mail.example"], login: { password: CANARIES.imported } } },
  };
  answers.push(await leadCalls(k.hub).handler("vault_import_search")!(lead, { op: "vault_import_search", query: "" } as never));
  const proposal = (await leadCalls(k.hub).handler("vault_import_propose")!(lead, { op: "vault_import_propose", refs: ["op://Fleet/Mail"], why: "to read mail" } as never)) as { proposalId: string };
  keep(await k.call(k.ownerDevice, "vault_import", { proposalId: proposal.proposalId }));

  // Adoption from a node and a secret request sealed to the hub.
  k.node.adopt = { vars: [{ scope: "project", projectId: "p1", name: "ADOPTED", secret: true, sealed: b64(seal(k.hubPub(), Buffer.from(CANARIES.adopted))), fingerprint: fp(CANARIES.adopted), bytes: 10 }], sinks: [] };
  keep(await adopt(k.hub, M));
  const request = await approvals(k.hub).requestSecret(PROJECT, { key: "stripe.key", sink: `env:${M}:/srv/p1/.env`, text: "Stripe" });
  keep(await k.call(k.ownerDevice, "secret_submit", { requestId: request.requestId, sealed: b64(seal(k.hubPub(), Buffer.from(CANARIES.sink))) }));
  expect(k.node.sinks.get(`env:${M}:/srv/p1/.env`)).toBe(CANARIES.sink);

  // A purchase with the vault card.
  keep(await k.call(k.ownerDevice, "project_card_set", { ...PROJECT, card: `vault:${card.item.itemId}` }));
  const opened = (await answer(k.hub, lead, {
    op: "purchase_open",
    sessionId: "B0123456789abcdef0123456789abcdef",
    page: "https://shop.example/pay",
    purchase: { shop: { name: "Shop", domain: "shop.example" }, total: { amount: "1.00", currency: "EUR" }, items: [] },
  } as never)) as { requestId: string };
  await k.call(k.ownerDevice, "approval_answer", { requestId: opened.requestId, decision: "approve" });
  const claim = (await answer(k.hub, lead, { op: "purchase_claim", requestId: opened.requestId, sessionId: "B0123456789abcdef0123456789abcdef" } as never)) as { sealedCard: string };
  expect(k.open(claim.sealedCard)).toContain(CANARIES.card);
  answers.push({ ...claim, sealedCard: undefined });
  await answer(k.hub, lead, { op: "purchase_filled", requestId: opened.requestId, ok: true, typed: true, message: "paid" } as never);

  // A rotation and the audit as the apps read it.
  keep(await k.call(k.ownerDevice, "vault_rotate", {}));
  keep(await k.call(k.ownerDevice, "vault_audit", {}));
  keep(await k.call(k.ownerDevice, "vault_audit", { ...PROJECT }));

  const everywhere = {
    logs: logged.join("\n"),
    answers: JSON.stringify(answers),
    events: JSON.stringify(k.hub.db.all("SELECT * FROM events")),
    chat: JSON.stringify(k.hub.db.all("SELECT * FROM chat_messages")),
    audit: JSON.stringify(k.hub.db.all("SELECT * FROM vault_audit")),
    requests: JSON.stringify(k.hub.db.all("SELECT * FROM requests")),
  };
  const db = Buffer.from(k.hub.db.conn.serialize());
  for (const [what, value] of Object.entries(CANARIES)) {
    for (const [where, text] of Object.entries(everywhere)) {
      if (text.includes(value)) throw new Error(`the planted ${what} shows in ${where}`);
    }
    if (db.includes(Buffer.from(value))) throw new Error(`the planted ${what} is in the database`);
  }
  // The audit saw every kind of use.
  const actions = new Set(k.hub.db.all<{ action: string }>("SELECT action FROM vault_audit").map((r) => r.action));
  for (const a of ["create", "fill", "fill_refused", "deliver", "inject", "reveal", "import", "adopt", "purchase", "rotate"]) expect(actions).toContain(a);
});
