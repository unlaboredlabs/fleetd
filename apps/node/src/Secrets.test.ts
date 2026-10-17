import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { type GatedRun, MachineId, type SecretDeliver } from "@fleetd/contracts";
import { Effect } from "effect";
import sodium from "libsodium-wrappers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadOrCreateBoxKey, type NodeBoxKey } from "./identity.ts";
import { deliverSecret, envFileWith, runGated, type SecretsContext } from "./Secrets.ts";

const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const home = tmp("fleetd-node-home-");
const root = tmp("fleetd-sinks-");
const outside = tmp("fleetd-outside-");
fs.symlinkSync(outside, path.join(root, "escape"));
afterAll(() => {
  for (const dir of [home, root, outside]) fs.rmSync(dir, { recursive: true, force: true });
});

const lab = MachineId.make("lab-a");
const VALUE = "fake-secret-abcDEF-secretValue";
let box: NodeBoxKey;
let ctx: SecretsContext;
beforeAll(async () => {
  box = await loadOrCreateBoxKey(home);
  ctx = { machineId: lab, roots: [root], home, box };
});

/** What the browser does: libsodium's crypto_box_seal to the machine's boxPubKey. */
const seal = (value: string, publicKey = box.publicKey) =>
  Buffer.from(sodium.crypto_box_seal(new TextEncoder().encode(value), Buffer.from(publicKey, "base64"))).toString("base64");

const deliver = (sink: string, value: string, over: Partial<SecretDeliver> = {}) =>
  deliverSecret({ t: "secret_deliver", id: "s1", sink, sealed: seal(value), secretKey: "stripe.test_key", ...over } as SecretDeliver, ctx);

const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);
const mode = (file: string) => fs.statSync(file).mode & 0o777;

describe("the node box key", () => {
  it("is created 0600 once and reused on the next start", async () => {
    const again = await loadOrCreateBoxKey(home);
    expect(again.publicKey).toBe(box.publicKey);
    expect(Buffer.from(box.publicKey, "base64")).toHaveLength(32);
    expect(mode(path.join(home, "node-box-key.pem"))).toBe(0o600);
  });

  it("opens what was sealed to it and nothing else", async () => {
    expect(Buffer.from(box.open(Buffer.from(seal(VALUE), "base64"))!).toString()).toBe(VALUE);
    const other = await loadOrCreateBoxKey(tmp("fleetd-other-home-"));
    expect(box.open(Buffer.from(seal(VALUE, other.publicKey), "base64"))).toBeUndefined();
  });
});

describe("deliverSecret", () => {
  it("writes an env sink 0600 with the key's variable and answers with the fingerprint", () => {
    const file = path.join(root, "app.env");
    expect(deliver(`env:lab-a:${file}`, VALUE)).toEqual({ t: "secret_result", id: "s1", fingerprint: fingerprint(VALUE) });
    expect(fs.readFileSync(file, "utf8")).toBe(`STRIPE_TEST_KEY=${VALUE}\n`);
    expect(mode(file)).toBe(0o600);
    // No temp file is left behind.
    expect(fs.readdirSync(root).filter((name) => name.includes("fleetd-"))).toEqual([]);
  });

  it("replaces the variable's existing line in place and keeps every other line", () => {
    const file = path.join(root, "existing.env");
    fs.writeFileSync(file, "# app\nA=1\nexport STRIPE_TEST_KEY=old\nB=2\nSTRIPE_TEST_KEY=older\n", { mode: 0o644 });
    expect(deliver(`env:lab-a:${file}`, VALUE)).toMatchObject({ fingerprint: fingerprint(VALUE) });
    expect(fs.readFileSync(file, "utf8")).toBe(`# app\nA=1\nexport STRIPE_TEST_KEY=${VALUE}\nB=2\n`);
    expect(mode(file)).toBe(0o600);
    expect(deliver(`env:lab-a:${file}`, "v2", { envName: "STRIPE_KEY" })).toMatchObject({ fingerprint: fingerprint("v2") });
    expect(fs.readFileSync(file, "utf8")).toBe(`# app\nA=1\nexport STRIPE_TEST_KEY=${VALUE}\nB=2\nSTRIPE_KEY=v2\n`);
  });

  it("builds env files as bytes for a value that is not in the old content", () => {
    expect(envFileWith("", "K", Buffer.from("v")).toString()).toBe("K=v\n");
    expect(envFileWith("A=1", "K", Buffer.from("v")).toString()).toBe("A=1\nK=v\n");
  });

  it("writes a file sink raw, multi-line values included", () => {
    const file = path.join(root, "key.pem");
    expect(deliver(`file:lab-a:${file}`, "line1\nline2\n")).toMatchObject({ fingerprint: fingerprint("line1\nline2\n") });
    expect(fs.readFileSync(file, "utf8")).toBe("line1\nline2\n");
    expect(mode(file)).toBe(0o600);
  });

  it("refuses sinks outside the roots, through symlinks, and on other machines", () => {
    fs.symlinkSync(path.join(outside, "target"), path.join(root, "link.env"));
    const refused = [
      deliver(`env:lab-a:${outside}/x.env`, VALUE),
      deliver(`env:lab-a:${root}/escape/x.env`, VALUE),
      deliver(`env:lab-a:${root}/link.env`, VALUE),
      deliver(`env:lab-a:${root}/missing/x.env`, VALUE),
      deliver(`env:lab-b:${root}/x.env`, VALUE),
    ];
    for (const result of refused) expect(result).toMatchObject({ t: "secret_result", error: expect.any(String) });
    expect(fs.readdirSync(outside)).toEqual([]);
    expect(JSON.stringify(refused)).not.toContain(VALUE);
  });

  it("refuses a box sealed to another key, a multi-line env value and a key with no valid variable", () => {
    const file = path.join(root, "refused.env");
    const wrongKey = Buffer.from(sodium.crypto_box_keypair().publicKey).toString("base64");
    expect(deliver(`env:lab-a:${file}`, VALUE, { sealed: seal(VALUE, wrongKey) })).toMatchObject({ error: expect.stringContaining("box key") });
    expect(deliver(`env:lab-a:${file}`, "a\nb")).toMatchObject({ error: expect.stringContaining("one-line") });
    expect(deliver(`env:lab-a:${file}`, VALUE, { secretKey: "1password.token" } as Partial<SecretDeliver>)).toMatchObject({
      error: expect.stringContaining("--env-name"),
    });
    expect(fs.existsSync(file)).toBe(false);
  });

  it("refuses everything on a node without a box key", () => {
    const { box: _, ...noBox } = ctx;
    expect(deliverSecret({ t: "secret_deliver", id: "s9", sink: `env:lab-a:${root}/n.env`, sealed: seal(VALUE), secretKey: "a.b" } as SecretDeliver, noBox)).toMatchObject({
      error: expect.stringContaining("takes no secrets"),
    });
  });
});

describe("runGated", () => {
  const gated = (argv: ReadonlyArray<string>, over: Record<string, unknown> = {}): GatedRun =>
    ({ t: "gated_run", id: "g1", askId: "A1", argv, cwd: root, timeoutSec: 30, ...over }) as GatedRun;
  const run = (frame: GatedRun) => Effect.runPromise(runGated(frame, ctx));

  it("runs the stored argv and reports its exit code and output", async () => {
    expect(await run(gated(["sh", "-c", "echo deployed; exit 3"]))).toEqual({ t: "gated_result", id: "g1", exitCode: 3, outputTail: "deployed\n", timedOut: false });
  });

  it("injects secrets from the node's sinks and scrubs them from the output", async () => {
    deliver(`env:lab-a:${path.join(root, "app.env")}`, VALUE);
    const result = await run(
      gated(["sh", "-c", 'echo "key=$STRIPE"; echo "$STRIPE" >&2; test "$STRIPE" = "$EXPECTED"'], {
        secretEnv: [{ name: "STRIPE", secretKey: "stripe.test_key" }],
      }),
    );
    expect(result).toMatchObject({ exitCode: 1, timedOut: false });
    expect(result.outputTail).toBe("key=[secret]\n[secret]\n");
    expect(JSON.stringify(result)).not.toContain(VALUE);
  });

  it("scrubs a value the command writes in two pieces", async () => {
    deliver(`file:lab-a:${path.join(root, "split.key")}`, "abcdefghij-0123456789-tail", { secretKey: "split.key" } as Partial<SecretDeliver>);
    const result = await run(
      gated(["sh", "-c", 'printf "start%s" "$(printf %s "$K" | cut -c1-10)"; sleep 0.3; printf "%send" "$(printf %s "$K" | cut -c11-)"'], {
        secretEnv: [{ name: "K", secretKey: "split.key" }],
      }),
    );
    expect(result.outputTail).toBe("start[secret]end");
  });

  it("does not run outside the roots or without its secret", async () => {
    expect(await run(gated(["true"], { cwd: outside }))).toMatchObject({ exitCode: null, error: expect.stringContaining("outside") });
    expect(await run(gated(["true"], { secretEnv: [{ name: "K", secretKey: "never.sent" }] }))).toMatchObject({
      exitCode: null,
      error: expect.stringContaining("never delivered"),
    });
  });

  it("kills it at the timeout", async () => {
    expect(await run(gated(["sleep", "30"], { timeoutSec: 1 }))).toMatchObject({ exitCode: null, timedOut: true });
  });
});
