// Claude accounts, the hub's model list and 1Password tokens through the node's session calls: sealed to the node's
// box key, kept in the Rust node's files, tested against a stand-in claude, a stand-in Models API and a fake
// `@1password/sdk` (no real login, token or account anywhere), with every secret masked out of what comes back.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSealed, publicKeyOf } from "../../src/shared/sealed_box.ts";
import { HELPER, installDir, SDK_VERSION } from "../../src/node/actions/onepassword.ts";
import { tried } from "../../src/node/actions/accounts.ts";
import { loadOrCreateBoxKey } from "../../src/node/identity.ts";
import { SessionService } from "../../src/node/sessions/index.ts";
import { fingerprintOf } from "../../src/node/secrets/files.ts";
import { tempHome } from "../helpers.ts";

const home = tempHome();
const nodeHome = join(home.dir, "node");
const boxKey = loadOrCreateBoxKey(nodeHome);
const sealed = (value: string) => Buffer.from(boxKey.seal(Buffer.from(value))).toString("base64");
const claude = join(home.dir, "claude");
let service: SessionService;
let calls = 0;
const call = (op: string, args: Record<string, unknown> = {}) => service.handle({ id: `c${++calls}`, call: { op, ...args } as never });
const ok = async (op: string, args: Record<string, unknown> = {}) => {
  const reply = await call(op, args);
  if (!("ok" in reply.result)) throw new Error(`${op}: ${JSON.stringify(reply.result)}`);
  return reply.result.ok as Record<string, any>;
};
const alice = { kind: "person", personId: "p_aaaaaaaa" };

beforeAll(async () => {
  // A stand-in claude: it says what credential it got, and works only for the right one.
  writeFileSync(
    claude,
    `#!/bin/sh
if [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$ANTHROPIC_BASE_URL" ]; then echo '{"is_error":true,"result":"machine login leaked"}'; exit 1; fi
if [ "$CLAUDE_CODE_OAUTH_TOKEN" = "tok-alice" ]; then echo '{"is_error":false,"result":"OK"}'; exit 0; fi
echo "{\\"is_error\\":true,\\"result\\":\\"Invalid token $CLAUDE_CODE_OAUTH_TOKEN\\"}"; exit 1
`,
  );
  chmodSync(claude, 0o755);
  service = await SessionService.start({
    home: nodeHome,
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", ANTHROPIC_API_KEY: "machine-key" },
    claudeBin: claude,
    fleetd: ["/bin/false"],
    boxKey,
  });
});

afterAll(async () => {
  await service.stopAll();
  home.done();
});

test("a person's subscription is saved sealed, in the Rust node's file, and forgotten", async () => {
  const saved = await ok("claude_account_secret", { account: alice, set: { sealed: sealed("tok-alice\n") } });
  expect(saved).toEqual({ kind: "claude_account_saved", fingerprint: fingerprintOf("tok-alice") });
  const file = join(nodeHome, "claude-accounts", "p_aaaaaaaa.json");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ value: "tok-alice" });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(nodeHome, "claude-accounts")).mode & 0o777).toBe(0o700);
  // Another machine's box, or two lines, is refused without showing the value.
  const other = loadOrCreateBoxKey(join(home.dir, "other"));
  const wrong = await call("claude_account_secret", { account: alice, set: { sealed: Buffer.from(other.seal(Buffer.from("tok-x"))).toString("base64") } });
  expect(wrong.result).toMatchObject({ err: { code: "invalid", message: expect.stringContaining("not sealed to this machine") } });
  const two = await call("claude_account_secret", { account: alice, set: { sealed: sealed("tok\nmore") } });
  expect(JSON.stringify(two.result)).toContain("one line");
  expect(JSON.stringify(two.result)).not.toContain("more");
  // A person's token takes no endpoint.
  expect((await call("claude_account_secret", { account: alice, set: { endpoint: "https://gw.devbox.example" } })).result).toMatchObject({ err: { code: "invalid" } });
});

test("an account's Test runs claude on that account alone, and masks what claude echoes", async () => {
  expect(await ok("claude_account_test", { account: alice })).toEqual({ kind: "claude_account_tested", ok: true });
  await ok("claude_account_secret", { account: { kind: "person", personId: "p_bbbbbbbb" }, set: { sealed: sealed("tok-bob-wrong") } });
  const bob = await ok("claude_account_test", { account: { kind: "person", personId: "p_bbbbbbbb" } });
  expect(bob).toEqual({ kind: "claude_account_tested", ok: false, error: "Invalid token ***CLAUDE_CODE_OAUTH_TOKEN***" });
  const none = await ok("claude_account_test", { account: { kind: "person", personId: "p_cccccccc" } });
  expect(none.ok).toBe(false);
  expect(none.error).toContain("p_cccccccc's subscription");
  expect(() => tried(false, "", "boom")).toThrow("boom");
});

test("the hub's key keeps its endpoint, lists the gateway's models, and reseals to another machine", async () => {
  let seen = null as string | null;
  const api = Bun.serve({
    port: 0,
    fetch(req) {
      seen = req.headers.get("x-api-key");
      return Response.json({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5" }, { id: "claude-haiku-5-5" }] });
    },
  });
  try {
    expect((await ok("claude_models")).error).toBe("this machine holds no hub API key");
    await ok("claude_account_secret", { account: { kind: "hub" }, set: { sealed: sealed("sk-hub") } });
    const endpoint = `http://127.0.0.1:${api.port}/`;
    const kept = await ok("claude_account_secret", { account: { kind: "hub" }, set: { endpoint } });
    expect(kept.fingerprint).toBe(fingerprintOf("sk-hub"));
    expect(JSON.parse(readFileSync(join(nodeHome, "claude-accounts", "hub.json"), "utf8"))).toEqual({ value: "sk-hub", endpoint });
    expect(await ok("claude_models")).toEqual({
      kind: "claude_models",
      models: [{ id: "claude-opus-5-5", displayName: "Claude Opus 5.5" }, { id: "claude-haiku-5-5" }],
    });
    expect(seen).toBe("sk-hub");
  } finally {
    api.stop(true);
  }
  const theirs = new Uint8Array(32).fill(7);
  const resealed = await ok("claude_account_reseal", { account: { kind: "hub" }, to: Buffer.from(publicKeyOf(theirs)).toString("base64") });
  expect(Buffer.from(openSealed(theirs, Buffer.from(resealed.sealed, "base64"))!).toString()).toBe("sk-hub");
  expect(await ok("claude_account_reseal", { account: { kind: "person", personId: "p_zzzzzzzz" }, to: resealed.sealed.slice(0, 44) })).toEqual({
    kind: "claude_account_resealed",
  });
  expect(await ok("claude_account_secret", { account: { kind: "hub" } })).toEqual({ kind: "claude_account_saved" });
  expect(existsSync(join(nodeHome, "claude-accounts", "hub.json"))).toBe(false);
});

const FAKE_TOKEN = "ops_devbox-fake-service-account";
/** The Rust tests' fake `@1password/sdk` (browser/onepassword.rs `fake_sdk`), at the pinned version. */
function fakeSdk(): boolean {
  if (Bun.spawnSync(["node", "--version"]).exitCode !== 0) return false;
  const sdk = join(installDir(nodeHome), "node_modules/@1password/sdk");
  mkdirSync(sdk, { recursive: true });
  writeFileSync(join(sdk, "package.json"), JSON.stringify({ name: "@1password/sdk", version: SDK_VERSION, type: "module", main: "index.js" }));
  writeFileSync(
    join(sdk, "index.js"),
    `export class RateLimitExceededError extends Error {}
export async function createClient({ auth }) {
  if (auth !== "${FAKE_TOKEN}") throw new Error(\`invalid service account token \${auth}\`);
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN !== undefined) throw new Error("the token is in the environment");
  return {
    vaults: { list: async () => [{ id: "v1", title: "Agents" }, { id: "v2", title: "Shared" }] },
    items: {
      list: async (vault) => vault === "v1"
        ? [{ id: "i1", title: "Shop", category: "Login", websites: [{ url: "https://shop.devbox.test/login" }] }]
        : [{ id: "i2", title: "Visa", category: "CreditCard", websites: [] }],
    },
  };
}
`,
  );
  return true;
}

test("a 1Password token is saved, tested and lists cards through the Rust node's own helper, masked", async () => {
  expect(HELPER).toContain('import { createClient, RateLimitExceededError } from "@1password/sdk";');
  expect(HELPER.endsWith("}\n")).toBe(true);
  const none = await ok("onepassword_test", { personId: "p_aaaaaaaa" });
  expect(none).toEqual({ kind: "onepassword_tested", vaults: [], error: "this machine holds no 1Password token of yours: save it again while it is online" });
  if (!fakeSdk()) return console.log("no Node.js here: the 1Password helper isn't tried");
  const saved = await ok("onepassword_token", { personId: "p_aaaaaaaa", sealed: sealed(FAKE_TOKEN) });
  expect(saved).toEqual({ kind: "onepassword_saved", fingerprint: fingerprintOf(FAKE_TOKEN) });
  const before = process.env.OP_SERVICE_ACCOUNT_TOKEN;
  process.env.OP_SERVICE_ACCOUNT_TOKEN = "ops_the-nodes-own";
  try {
    expect(await ok("onepassword_test", { personId: "p_aaaaaaaa" })).toEqual({ kind: "onepassword_tested", vaults: ["Agents", "Shared"] });
  } finally {
    if (before === undefined) delete process.env.OP_SERVICE_ACCOUNT_TOKEN;
    else process.env.OP_SERVICE_ACCOUNT_TOKEN = before;
  }
  expect(await ok("onepassword_cards", { personId: "p_aaaaaaaa" })).toEqual({
    kind: "onepassword_carded",
    cards: [{ ref: "op://Shared/Visa", title: "Visa", vault: "Shared" }],
  });
  expect(readFileSync(join(installDir(nodeHome), "resolve.mjs"), "utf8")).toBe(HELPER);
  // A token 1Password refuses comes back in its words, the token itself masked.
  await ok("onepassword_token", { personId: "p_bbbbbbbb", sealed: sealed("ops_devbox-wrong-token") });
  const refused = await ok("onepassword_test", { personId: "p_bbbbbbbb" });
  expect(refused).toEqual({ kind: "onepassword_tested", vaults: [], error: "1Password: invalid service account token ***OP_SERVICE_ACCOUNT_TOKEN***" });
  expect(await ok("onepassword_token", { personId: "p_bbbbbbbb" })).toEqual({ kind: "onepassword_saved" });
});
