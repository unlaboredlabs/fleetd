// agent-mcp's `vault_store` (src/cli/agent_mcp/store.ts): the file read by the tool server, sealed to the key the
// workspace sends, only the sealed value on the wire, the file shredded once stored; and every file it refuses.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { handle, type LeadDeps } from "../src/cli/agent_mcp/index.ts";
import { shred, STORE_MAX_BYTES } from "../src/cli/agent_mcp/store.ts";
import { storedValue } from "../src/hub/vault/fields.ts";
import { openSealed, publicKeyOf } from "../src/shared/sealed_box.ts";
import { tempHome } from "./helpers.ts";

const VALUE = "AGE-SECRET-KEY-1PLANTED0VALUE0NEVER0SHOWN";
const fp = (value: string) => new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 8);

let home: ReturnType<typeof tempHome>;
let worktree: string;
let tmp: string;
let frames: Record<string, unknown>[];
let stored: string | undefined;
let answer: ((call: Record<string, unknown>) => Record<string, unknown>) | undefined;
const hubSecret = crypto.getRandomValues(new Uint8Array(32));

beforeEach(() => {
  home = tempHome();
  worktree = join(home.dir, "worktree");
  tmp = join(home.dir, "tmp");
  mkdirSync(worktree);
  mkdirSync(tmp);
  frames = [];
  stored = undefined;
  answer = undefined;
});
afterEach(() => home.done());

/** A workspace that answers the box key, then opens what it gets as the hub would. */
const deps = (): LeadDeps => ({
  pwd: worktree,
  sock: "/nowhere.sock",
  thread: "t-1",
  cwd: worktree,
  tmp,
  send: async (_socket, frame) => {
    frames.push(frame);
    const call = frame.call as Record<string, unknown>;
    if (answer) return answer(call);
    if (call.sealed === undefined) return { result: { op: "vault_store", name: call.name, sealTo: Buffer.from(publicKeyOf(hubSecret)).toString("base64") } };
    // The workspace works the value out of the file's bytes as agent_store.ts does.
    stored = storedValue(openSealed(hubSecret, new Uint8Array(Buffer.from(String(call.sealed), "base64")))!);
    return { result: { op: "vault_store", name: call.name, fingerprint: fp(stored), bytes: stored.length } };
  },
});

async function call(args: Record<string, unknown>, role: "lead" | "worker" = "worker") {
  const out = (await handle(role, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "vault_store", arguments: args } }, deps())) as {
    result: { content: { text: string }[]; isError: boolean };
  };
  return { text: out.result.content[0]!.text, isError: out.result.isError };
}

function secretFile(dir: string, name: string, body: string | Buffer, mode = 0o600) {
  const path = join(dir, name);
  writeFileSync(path, body, { mode });
  chmodSync(path, mode);
  return path;
}

test("stored: sealed on the wire, the value never in the answer, the file shredded and gone", async () => {
  const file = secretFile(tmp, "age.key", `${VALUE}\n`);
  const out = await call({ name: "CLOUD_DR_AGE_KEY", file, note: "DR age key" });
  expect(out).toEqual({ isError: false, text: `Stored CLOUD_DR_AGE_KEY in this bot's vault (fingerprint ${fp(VALUE)}); ${file} is shredded and deleted.` });
  // One trailing newline dropped, as `$(cat file)` would.
  expect(stored).toBe(VALUE);
  expect(existsSync(file)).toBe(false);
  // First the box key, then only the sealed value: the path and the value never leave the session.
  expect(frames.map((f) => Object.keys(f.call as object).sort())).toEqual([["name", "op"], ["name", "note", "op", "sealed"]]);
  for (const f of frames) {
    expect(JSON.stringify(f)).not.toContain(VALUE);
    expect(JSON.stringify(f)).not.toContain(file);
  }
  // A leading BOM goes on both ends alike, so the fingerprints agree and the file goes.
  const bom = secretFile(tmp, "bom.key", `\uFEFF${VALUE}\r\n`);
  expect(await call({ name: "WITH_BOM", file: bom })).toEqual({
    isError: false,
    text: `Stored WITH_BOM in this bot's vault (fingerprint ${fp(VALUE)}); ${bom} is shredded and deleted.`,
  });
  expect(stored).toBe(VALUE);
  expect(existsSync(bom)).toBe(false);
});

test("a lead stores only from its TMPDIR, never from its working directory (the person's checkout)", async () => {
  const checkout = secretFile(worktree, ".env", "PERSON_KEY=keep-me");
  expect((await call({ name: "LEAD_KEY", file: checkout }, "lead")).text).toBe(`Not stored: ${checkout} is outside your TMPDIR: write the file there.`);
  expect(readFileSync(checkout, "utf8")).toBe("PERSON_KEY=keep-me");
  expect(frames).toEqual([]);
  const lead = secretFile(tmp, "lead.key", "lead-value");
  expect((await call({ name: "LEAD_KEY", file: lead }, "lead")).isError).toBe(false);
  expect(stored).toBe("lead-value");
});

test("shred overwrites the bytes before it unlinks", () => {
  const file = secretFile(tmp, "s", "x".repeat(STORE_MAX_BYTES + 10));
  // A second name for the same inode shows what the bytes are once the file's own name is gone.
  const witness = join(tmp, "witness");
  linkSync(file, witness);
  shred(file);
  expect(existsSync(file)).toBe(false);
  expect(readFileSync(witness).equals(Buffer.alloc(STORE_MAX_BYTES + 10))).toBe(true);
});

test("refused, nothing sent and the file kept: not 0600, not a regular file, a symlink, too big, empty, outside, relative", async () => {
  const loose = secretFile(tmp, "loose", VALUE, 0o644);
  expect((await call({ name: "A", file: loose })).text).toBe(`Not stored: ${loose} is mode 644: make it 0600 (chmod 600) first.`);
  const dir = join(tmp, "dir");
  mkdirSync(dir, { mode: 0o600 });
  expect((await call({ name: "A", file: dir })).text).toBe(`Not stored: ${dir} isn't a regular file.`);
  const target = secretFile(tmp, "target", VALUE);
  const link = join(tmp, "link");
  symlinkSync(target, link);
  expect((await call({ name: "A", file: link })).text).toBe(`Not stored: ${link} is a symlink: name the file itself.`);
  const big = secretFile(tmp, "big", "x".repeat(STORE_MAX_BYTES + 1));
  expect((await call({ name: "A", file: big })).text).toBe(`Not stored: ${big} is over 64 KB.`);
  const empty = secretFile(tmp, "empty", "");
  expect((await call({ name: "A", file: empty })).text).toBe(`Not stored: ${empty} is empty.`);
  const binary = secretFile(tmp, "binary", Buffer.from([0xff, 0xfe]));
  expect((await call({ name: "A", file: binary })).text).toContain("isn't UTF-8 text");
  const outside = secretFile(home.dir, "outside", VALUE);
  expect((await call({ name: "A", file: outside })).text).toBe(`Not stored: ${outside} is outside your worktree and TMPDIR: write the file there.`);
  // A hard link to a key elsewhere (~/.ssh/id_ed25519) would be stored and then wiped through the shared bytes.
  const key = secretFile(home.dir, "id_ed25519", "PRIVATE KEY");
  const linked = join(tmp, "linked");
  linkSync(key, linked);
  expect((await call({ name: "A", file: linked })).text).toBe(`Not stored: ${linked} has 2 hard links: write the value to a file of its own.`);
  expect(readFileSync(key, "utf8")).toBe("PRIVATE KEY");
  // A name that would run code in every later session is refused before the file is read.
  for (const risky of ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "BASH_ENV", "ENV", "NODE_OPTIONS", "PYTHONSTARTUP", "GIT_SSH_COMMAND", "npm_config_script_shell"]) {
    expect((await call({ name: risky, file: target })).text).toBe(
      `Not stored: ${risky} changes what later sessions run: an agent can't store it. Store it under a plain name; a person may set it in the bot's Vault.`,
    );
  }
  expect((await call({ name: "PATH", file: target })).text).toContain("fleetd's or claude's own");
  // A worktree path that leads out through a symlinked folder is outside too.
  symlinkSync(home.dir, join(worktree, "up"));
  expect((await call({ name: "A", file: join(worktree, "up", "outside") })).text).toContain("is outside your worktree and TMPDIR");
  expect((await call({ name: "A", file: "rel/key" })).isError).toBe(true);
  expect((await call({ name: "1BAD", file: target })).isError).toBe(true);
  expect(frames).toEqual([]);
  for (const f of [loose, target, big, outside]) expect(existsSync(f)).toBe(true);
  expect(statSync(target).mode & 0o777).toBe(0o600);
});

test("a workspace refusal keeps the file, so the agent may try again", async () => {
  const file = secretFile(tmp, "k", VALUE);
  answer = () => ({ error: { code: "invalid", message: "This bot has a variable TOKEN already.", fix: "Store it under another name; only a person replaces or deletes a variable." } });
  const out = await call({ name: "TOKEN", file });
  expect(out.isError).toBe(true);
  expect(out.text).toBe(
    `Refused: This bot has a variable TOKEN already.\nNext: Store it under another name; only a person replaces or deletes a variable.\n${file} is kept: fix it and try again, or delete it.`,
  );
  expect(existsSync(file)).toBe(true);
  // A fingerprint that doesn't match the file's keeps it too.
  answer = (c) => (c.sealed === undefined ? { result: { sealTo: Buffer.from(publicKeyOf(hubSecret)).toString("base64") } } : { result: { fingerprint: "00000000" } });
  expect((await call({ name: "TOKEN", file })).text).toContain("another fingerprint");
  expect(existsSync(file)).toBe(true);
});
