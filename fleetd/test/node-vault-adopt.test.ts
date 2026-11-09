// The node's side of the vault's migration and import (vault-design §6-7; secrets/adopt.ts, actions/onepassword.ts),
// through the hub's session calls as the node answers them: `vault_adopt` hands over every variable and sink the node
// holds, in both runtimes' file shapes, each value sealed to the hub alone; `vault_import_search` lists 1Password items
// by title and site, never a value; `vault_import_read` reads the picked ones and seals their fields to the hub. No
// value is in an answer in the clear, in the node's log, or anywhere but the files it already was in.
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installDir, SDK_VERSION } from "../src/node/actions/onepassword.ts";
import { loadOrCreateBoxKey } from "../src/node/identity.ts";
import { fingerprintOf } from "../src/node/secrets/files.ts";
import { SessionService } from "../src/node/sessions/index.ts";
import { openSealed, publicKeyOf } from "../src/shared/sealed_box.ts";
import { tempHome } from "./helpers.ts";

const home = tempHome();
const nodeHome = join(home.dir, "node");
const work = join(home.dir, "work");
const boxKey = loadOrCreateBoxKey(nodeHome);
/** The hub's box key: what every value is sealed to. */
const hubSecret = crypto.getRandomValues(new Uint8Array(32));
const to = Buffer.from(publicKeyOf(hubSecret)).toString("base64");
const opened = (sealed: string) => {
  const plain = openSealed(hubSecret, Buffer.from(sealed, "base64"));
  if (!plain) throw new Error("not sealed to the hub");
  return Buffer.from(plain).toString("utf8");
};
let service: SessionService;
let calls = 0;
const ok = async (op: string, args: Record<string, unknown> = {}) => {
  const reply = await service.handle({ id: `c${++calls}`, call: { op, ...args } as never });
  if (!("ok" in reply.result)) throw new Error(`${op}: ${JSON.stringify(reply.result)}`);
  return reply.result.ok as Record<string, any>;
};
const lines: string[] = [];

/** The planted values. */
const PROJECT_SECRET = "sk_devbox_project-Secr3t+/=";
const PLAIN = "https://api.devbox.test";
const RUST_SECRET = "rust-shaped-value-0042";
const ORDER_SECRET = "order-Secr3t-\"quoted\"";
const ENV_SINK = "env-sink-value-9931";
const FILE_SINK = "-----BEGIN KEY-----\nfile-sink-body\n-----END KEY-----\n";
const PASSWORD = "1p-Import-Pw!77";
const CARD = "4000056655665556";

beforeAll(async () => {
  for (const level of ["log", "info", "warn", "error", "debug"] as const) spyOn(console, level).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(" ")));
  mkdirSync(join(nodeHome, "project-env"), { recursive: true });
  mkdirSync(join(nodeHome, "order-env", "p1"), { recursive: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(join(nodeHome, "node.json"), JSON.stringify({ hub: "http://127.0.0.1:1", machineId: "devbox", name: "devbox", enrolled: true, cmdRoots: [work] }));
  // The Bun node's shape, and the Rust node's (no `secret` on a plain one).
  writeFileSync(join(nodeHome, "project-env", "p1.json"), JSON.stringify({ vars: { API_URL: { value: PLAIN, secret: false }, STRIPE_KEY: { value: PROJECT_SECRET, secret: true } } }));
  writeFileSync(join(nodeHome, "project-env", "p2.json"), JSON.stringify({ vars: { OLD: { value: RUST_SECRET, secret: true }, BARE: { value: "bare" } } }));
  writeFileSync(join(nodeHome, "project-env", "broken.json"), "{ not json");
  writeFileSync(join(nodeHome, "order-env", "p1", "W7.json"), JSON.stringify({ vars: { DEPLOY_TOKEN: ORDER_SECRET } }));
  writeFileSync(join(nodeHome, "order-env", "p1", "W7.sh"), `export DEPLOY_TOKEN='x'\n`);
  // Two sinks, and one whose file is gone.
  writeFileSync(join(work, ".env"), `OTHER=1\nSTRIPE_TEST_KEY=${ENV_SINK}\n`);
  writeFileSync(join(work, "key.pem"), FILE_SINK);
  writeFileSync(
    join(nodeHome, "secret-sinks.json"),
    JSON.stringify({
      "stripe.test_key": { kind: "env", path: join(work, ".env"), envName: "STRIPE_TEST_KEY" },
      "deploy.key": { kind: "file", path: join(work, "key.pem") },
      "gone.key": { kind: "file", path: join(work, "gone.pem") },
    }),
  );
  service = await SessionService.start({
    home: nodeHome,
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin" },
    claudeBin: "/bin/false",
    fleetd: ["/bin/false"],
    boxKey,
  });
});

afterAll(async () => {
  await service.stopAll();
  home.done();
});

const planted = [PROJECT_SECRET, RUST_SECRET, ORDER_SECRET, ENV_SINK, "file-sink-body", PASSWORD, CARD];
const expectClean = (what: string, text: string) => {
  for (const value of planted) for (const form of [value, JSON.stringify(value).slice(1, -1), Buffer.from(value).toString("base64")]) if (text.includes(form)) throw new Error(`${what} holds ${form}`);
};

test("vault_adopt hands every variable and sink to the hub sealed, in both runtimes' file shapes, and leaves the files", async () => {
  const before = readFileSync(join(nodeHome, "project-env", "p1.json"), "utf8");
  const answer = await ok("vault_adopt", { to });
  expect(answer.kind).toBe("vault_adopted");
  expectClean("vault_adopt's answer", JSON.stringify(answer));
  const vars: Record<string, unknown>[] = (answer.vars as Record<string, any>[]).map((v) => ({ ...v, value: opened(v.sealed), sealed: undefined }));
  const row = (value: string, scope: string, projectId: string, name: string, secret: boolean, orderId?: string) => ({
    scope,
    projectId,
    ...(orderId ? { orderId } : {}),
    name,
    secret,
    value,
    sealed: undefined,
    fingerprint: fingerprintOf(value),
    bytes: Buffer.byteLength(value),
  });
  expect(vars).toEqual([
    row(PLAIN, "project", "p1", "API_URL", false),
    row(PROJECT_SECRET, "project", "p1", "STRIPE_KEY", true),
    row("bare", "project", "p2", "BARE", false),
    row(RUST_SECRET, "project", "p2", "OLD", true),
    row(ORDER_SECRET, "order", "p1", "DEPLOY_TOKEN", true, "W7"),
  ]);
  const sinks: Record<string, unknown>[] = (answer.sinks as Record<string, any>[]).map((s) => ({ ...s, value: opened(s.sealed), sealed: undefined }));
  expect(sinks).toEqual([
    { secretKey: "deploy.key", kind: "file", path: join(work, "key.pem"), value: FILE_SINK, sealed: undefined, fingerprint: fingerprintOf(FILE_SINK) },
    { secretKey: "stripe.test_key", kind: "env", path: join(work, ".env"), envName: "STRIPE_TEST_KEY", value: ENV_SINK, sealed: undefined, fingerprint: fingerprintOf(ENV_SINK) },
  ]);
  // Sealed to the hub alone: this node's own key doesn't open them.
  expect(boxKey.open(Buffer.from(String(answer.vars[0].sealed), "base64"))).toBeNull();
  // What it couldn't read is named by its file, never by a value; the files stay as they were.
  const log = lines.join("\n");
  expect(log).toContain("broken.json left out");
  expect(log).toContain(`${join(work, "gone.pem")} left out`);
  expectClean("the node's log", log);
  expect(readFileSync(join(nodeHome, "project-env", "p1.json"), "utf8")).toBe(before);
  // A key that isn't one is refused.
  const bad = await service.handle({ id: "bad", call: { op: "vault_adopt", to: "AAAA" } as never });
  expect(JSON.stringify(bad.result)).toContain("not 32 bytes");
});

const FAKE_TOKEN = "ops_devbox-fake-import-token";

/** A fake `@1password/sdk` at the pinned version: a login with a one-time code, a card, an identity with an address,
 * and a document (not imported). It takes FAKE_TOKEN only. None without Node.js. */
function fakeSdk(): boolean {
  if (Bun.spawnSync(["node", "--version"]).exitCode !== 0) return false;
  const sdk = join(installDir(nodeHome), "node_modules/@1password/sdk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@1password/sdk", version: SDK_VERSION, type: "module", main: "index.js" }));
  writeFileSync(
    join(sdk, "index.js"),
    `export class RateLimitExceededError extends Error {}
const overviews = [
  { id: "i1", title: "Shop", category: "Login", websites: [{ url: "https://shop.devbox.test/login" }] },
  { id: "i2", title: "Visa", category: "CreditCard", websites: [] },
  { id: "i3", title: "Home", category: "Identity", websites: [] },
  { id: "i4", title: "Shop manual", category: "Document", websites: [] },
];
const items = {
  i1: { title: "Shop", category: "Login", websites: [{ url: "https://shop.devbox.test/login" }], notes: "",
    fields: [{ id: "username", title: "username", fieldType: "Text", value: "ada@shop.devbox.test" },
      { id: "password", title: "password", fieldType: "Concealed", value: "${PASSWORD}" },
      { id: "otp", title: "one-time password", fieldType: "Totp", value: "otpauth://totp/Shop?secret=JBSWY3DPEHPK3PXP" }] },
  i2: { title: "Visa", category: "CreditCard", websites: [],
    fields: [{ id: "cardholder", title: "cardholder name", fieldType: "Text", value: "Ada Devbox" },
      { id: "ccnum", title: "number", fieldType: "CreditCardNumber", value: "4000 0566 5566 5556" },
      { id: "cvv", title: "verification number", fieldType: "Concealed", value: "321" },
      { id: "expiry", title: "expiry date", fieldType: "MonthYear", value: "07/2031" }] },
  i3: { title: "Home", category: "Identity", websites: [],
    fields: [{ id: "firstname", title: "first name", fieldType: "Text", value: "Ada" },
      { id: "lastname", title: "last name", fieldType: "Text", value: "Devbox" },
      { id: "address", title: "address", fieldType: "Address", value: "", details: { content: { street: "12 Canary Lane\\nFlat 3b", city: "Springfield", state: "OR", zip: "97477", country: "us" } } },
      { id: "email", title: "email", fieldType: "Email", value: "ada@mail.devbox.test" }] },
};
export async function createClient({ auth }) {
  if (auth !== "${FAKE_TOKEN}") throw new Error(\`invalid service account token \${auth}\`);
  return {
    vaults: { list: async () => [{ id: "v1", title: "Personal" }] },
    items: { list: async () => overviews, get: async (vault, id) => items[id] },
  };
}
`,
  );
  return true;
}

test("1Password import: a search lists titles, kinds and sites only; a read seals each item's fields to the hub", async () => {
  if (!fakeSdk()) return console.warn("no Node.js here: the import isn't tried");
  const person = "p_aaaaaaaa";
  const none = await ok("vault_import_search", { personId: person, query: "" });
  expect(none).toEqual({ kind: "vault_import_found", items: [], error: "this machine holds no 1Password token of yours: save it again while it is online" });
  await ok("onepassword_token", { personId: person, sealed: Buffer.from(boxKey.seal(Buffer.from(FAKE_TOKEN))).toString("base64") });

  const all = await ok("vault_import_search", { personId: person, query: "" });
  expect(all).toEqual({
    kind: "vault_import_found",
    items: [
      { ref: "op://Personal/Shop", title: "Shop", kind: "login", vault: "Personal", sites: ["shop.devbox.test"] },
      { ref: "op://Personal/Visa", title: "Visa", kind: "card", vault: "Personal" },
      { ref: "op://Personal/Home", title: "Home", kind: "address", vault: "Personal" },
    ],
  });
  expect((await ok("vault_import_search", { personId: person, query: "shop.devbox" })).items.map((i: { ref: string }) => i.ref)).toEqual(["op://Personal/Shop"]);
  expect((await ok("vault_import_search", { personId: person, query: "", kinds: ["card"] })).items.map((i: { ref: string }) => i.ref)).toEqual(["op://Personal/Visa"]);

  const read = await ok("vault_import_read", { personId: person, refs: ["op://Personal/Shop", "op://Personal/Visa", "op://Personal/Home", "op://Personal/Shop manual"], to });
  expectClean("vault_import_read's answer", JSON.stringify(read));
  expect(read.errors).toEqual([{ ref: "op://Personal/Shop manual", message: "1Password: Shop manual is not a login, card or identity item" }]);
  const fields = Object.fromEntries((read.items as { ref: string; kind: string; sealed: string }[]).map((i) => [i.ref, { kind: i.kind, ...JSON.parse(opened(i.sealed)) }]));
  expect(fields).toEqual({
    "op://Personal/Shop": {
      kind: "login",
      title: "Shop",
      sites: ["shop.devbox.test"],
      login: { username: "ada@shop.devbox.test", password: PASSWORD, totp: "otpauth://totp/Shop?secret=JBSWY3DPEHPK3PXP" },
    },
    "op://Personal/Visa": { kind: "card", title: "Visa", card: { number: CARD, month: "07", year: "2031", cvc: "321", name: "Ada Devbox" } },
    "op://Personal/Home": {
      kind: "address",
      title: "Home",
      address: { name: "Ada Devbox", line1: "12 Canary Lane", line2: "Flat 3b", city: "Springfield", region: "OR", postalCode: "97477", country: "US", email: "ada@mail.devbox.test" },
    },
  });
  // Another token's errors come back with the token masked.
  await ok("onepassword_token", { personId: "p_bbbbbbbb", sealed: Buffer.from(boxKey.seal(Buffer.from("ops_devbox-wrong-token"))).toString("base64") });
  const wrong = await ok("vault_import_search", { personId: "p_bbbbbbbb", query: "" });
  expect(wrong.error).toBe("1Password: invalid service account token ***OP_SERVICE_ACCOUNT_TOKEN***");
  const wrongRead = await ok("vault_import_read", { personId: "p_bbbbbbbb", refs: ["op://Personal/Shop"], to });
  expect(wrongRead).toEqual({ kind: "vault_import_read", items: [], errors: [{ ref: "op://Personal/Shop", message: "1Password: invalid service account token ***OP_SERVICE_ACCOUNT_TOKEN***" }] });
  expectClean("the node's log", lines.join("\n"));
});
