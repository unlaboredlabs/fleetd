// The Vault (D492). vault-team: a hub with the team vault, as Sam (an admin) sees it: the team's logins, cards and
// addresses; storefront's variables and an order's; and two of Sam's own items set aside from before the team vault.
// vault-team-member: the same team vault as Bob, a member, with a team card someone else added that only its creator
// or an admin may show or change. vault-old-hub: a hub from before the team vault, whose items
// (Sam's own among them) are one list and nothing is set aside.
import { Fixture } from "../kit/fixture.ts";
import { defineGroup } from "../kit/group.ts";
import { at } from "../kit/ids.ts";
import type { JsonObject } from "../kit/json.ts";
import { AGENT } from "../agents/route.ts";
import { answerHub, bob, sam } from "../admin/index.ts";

const STOREFRONT = { machineId: AGENT.machineId, projectId: AGENT.projectId };
const id = (n: number) => `V${n.toString(16).padStart(32, "0")}`;

const item = (f: Fixture, n: number, over: JsonObject): JsonObject => ({
  itemId: id(n),
  canEdit: true,
  canReveal: true,
  createdMs: Date.parse(at(f.now, -9 * 86_400_000)),
  updatedMs: Date.parse(at(f.now, -2 * 86_400_000)),
  updatedBy: "human:laptop",
  version: 1,
  ...over,
});

const typed = { kind: "typed" };

/** The team's items; `admin`: whether the person may show and change one someone else added. */
const teamItems = (f: Fixture, admin: boolean): JsonObject[] => [
  item(f, 1, { kind: "login", scope: "hub", label: "GitHub (bot)", meta: { source: typed, sites: ["github.com"], fields: ["username", "password", "totp"] } }),
  item(f, 2, { kind: "login", scope: "hub", label: "Stripe dashboard", meta: { source: { kind: "1password", ref: "op://Shared/Stripe", importedMs: Date.parse(at(f.now, -5 * 86_400_000)) }, sites: ["dashboard.stripe.com", "stripe.com"], fields: ["username", "password"] } }),
  item(f, 3, { kind: "card", scope: "hub", label: "Team Visa", canEdit: admin, canReveal: admin, meta: { source: typed, brand: "visa", last4: "4242" } }),
  item(f, 4, { kind: "address", scope: "hub", label: "Office", meta: { source: typed, country: "DE" } }),
];

const setAside = (f: Fixture): JsonObject[] => [
  item(f, 5, { kind: "card", scope: "person", label: "Sam's Amex", meta: { source: typed, brand: "amex", last4: "0005" } }),
  item(f, 6, { kind: "env", scope: "person", label: "OPENAI_API_KEY", envName: "OPENAI_API_KEY", meta: { source: typed, secret: true, bytes: 51 } }),
];

const variables = (f: Fixture): JsonObject[] => [
  item(f, 7, { kind: "env", scope: "project", ...STOREFRONT, label: "STRIPE_SECRET_KEY", envName: "STRIPE_SECRET_KEY", meta: { source: typed, secret: true, bytes: 107 } }),
  item(f, 8, { kind: "env", scope: "project", ...STOREFRONT, label: "NODE_ENV", envName: "NODE_ENV", value: "production", meta: { source: typed, secret: false, bytes: 10 } }),
  item(f, 9, { kind: "env", scope: "order", ...STOREFRONT, workstreamId: "W12", label: "SANDBOX_TOKEN", envName: "SANDBOX_TOKEN", meta: { source: typed, secret: true, bytes: 40 } }),
];

const status = { hubBoxKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=", keyMode: "file", keyId: "k1", locked: false, keyMissing: false, recoverySaved: true, migration: { done: true, machines: [] } };

const vault = (f: Fixture, features: string[], list: JsonObject[], admin: boolean): Fixture => {
  answerHub(f, admin ? sam : bob, admin);
  if (f.state.phase === "live") f.state = { ...f.state, features: [...(f.state.features ?? []), ...features] };
  f.answer("vault_status", {}, status);
  f.answer("vault_list", {}, { items: list });
  f.answer("vault_list", { trash: true }, { items: [] });
  f.answer("vault_list", STOREFRONT, { items: variables(f) });
  for (const i of [...list, ...variables(f)]) {
    const fill = { n: 1, atMs: Date.parse(at(f.now, -3_600_000)), action: "fill", outcome: "ok", data: { site: "github.com", fields: ["password"] }, ...STOREFRONT, taskId: "T41" };
    f.answer("vault_get", { itemId: i["itemId"] as string }, { item: i, activity: i["kind"] === "login" ? [fill] : [] });
  }
  return f;
};

export default defineGroup({
  fixtures: (base) => [
    vault(Fixture.from(base("typical"), "vault-team", "Vault: the team's items, storefront's variables and two of Sam's set aside."), ["vault", "vault_team"], [...teamItems(base("typical"), true), ...setAside(base("typical"))], true),
    vault(Fixture.from(base("typical"), "vault-team-member", "Vault as a member: a team card someone else added, which only its creator or an admin may show or change."), ["vault", "vault_team"], teamItems(base("typical"), false), false),
    vault(Fixture.from(base("typical"), "vault-old-hub", "Vault on a hub from before the team vault: one list, Sam's own among them, nothing set aside."), ["vault"], [...teamItems(base("typical"), true), ...setAside(base("typical"))], true),
  ],
});
