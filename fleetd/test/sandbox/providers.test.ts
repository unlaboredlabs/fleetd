// The hosted sandbox client (boat.dev) against a stand-in server (stand_ins.ts): the one interface's behaviour
// (idempotent create and destroy, the leak sweep's list, lifetime, a detached start whose secrets stay out of the
// command, the port stream, reading a file, building a template), its own auth header and settings, and refusals in
// plain words. A provider added later runs the same tests (the loop below).
import { afterEach, describe, expect, test } from "bun:test";
import { boatStandIn, KEY, SECRET, type StandIn } from "./stand_ins.ts";
import { GUEST_PORT, provider, ProviderError, type Provider, type ProviderId } from "../../src/sandbox/providers/index.ts";
import { TYPES, typeFor } from "../../src/sandbox/providers/boat.ts";
import { DEFAULT_SIZE, SIZES } from "../../src/sandbox/providers/common.ts";
import { hosted, parse, templateName } from "../../src/sandbox/providers/recipe.ts";
import { envFile, launcher } from "../../src/sandbox/providers/shell.ts";

const running: StandIn[] = [];
afterEach(() => {
  for (const s of running.splice(0)) s.stop();
});

function make(id: ProviderId, key = KEY): { s: StandIn; p: Provider } {
  const s = boatStandIn();
  running.push(s);
  const api = `${s.url}/api/v1`;
  const p = provider(id, { key }, { urls: { api, sandbox: (box, port) => `${s.url}/box/${box}/${port}` }, pollMs: 5 });
  return { s, p };
}

const create = (p: Provider, key = "sess-1", labels: Record<string, string> = { session: "s1" }) =>
  p.create({ template: "fleetd-abc", key, labels, lifetimeMs: 2 * 3600_000 });

const DOCKERFILE = `FROM ubuntu@sha256:${"a".repeat(64)}
# tools
RUN apt-get update \\
 && apt-get install -y git curl
ENV BUN_INSTALL=/opt/bun PATH="/opt/bun/bin:/usr/bin"
WORKDIR /work
RUN echo hi
`;

for (const id of ["boat"] as const) {
  describe(id, () => {
    test("a create with the same key makes one box; destroy twice is fine; the box leaves the list", async () => {
      const { s, p } = make(id);
      const a = await create(p);
      const b = await create(p);
      expect(b.id).toBe(a.id);
      expect(s.boxes.size).toBe(1);
      expect(a.labels).toMatchObject({ session: "s1", fleetd: "1", "fleetd-key": "sess-1" });
      expect((await p.list()).map((x) => x.id)).toEqual([a.id]);
      await p.destroy(a.id);
      await p.destroy(a.id);
      expect(await p.list()).toEqual([]);
    });

    test("the leak sweep's list is fleetd's own boxes only, every page", async () => {
      const { s, p } = make(id);
      const ids = [];
      for (const k of ["k-1", "k-2", "k-3"]) ids.push((await create(p, k)).id);
      // Someone else's box in the same account.
      s.boxes.set("other", { id: "other", sandboxID: "other", name: "other", labels: { team: "x" }, metadata: { team: "x" }, state: "running" });
      const listed = await p.list();
      expect(listed.map((b) => b.id).sort()).toEqual(ids.sort());
      expect(listed.every((b) => b.labels.fleetd === "1")).toBe(true);
    });

    test("every call carries the key in the provider's header, and a wrong key is refused in plain words", async () => {
      const { s, p } = make(id);
      await create(p);
      const api = s.calls.filter((c) => !c.path.startsWith("/box/") && !c.path.startsWith("/toolbox/"));
      for (const c of api) expect(c.headers.get("authorization")).toBe(`Bearer ${KEY}`);
      const wrong = make(id, "wrong-key-987654321").p;
      const e = await wrong.list().catch((e) => e);
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.reason).toBe("invalid_key");
      expect(e.message).not.toContain("wrong-key-987654321");
    });

    test("lifetime: set at create, extended from now", async () => {
      const { s, p } = make(id);
      const b = await create(p);
      const got = () => s.boxes.get(b.id);
      expect(got().ttlSeconds).toBe(7200);
      await p.lifetime(b.id, 5 * 3600_000);
      expect(got().ttlSeconds).toBe(18000);
    });

    test("a detached start: the environment reaches the command, never the command's text", async () => {
      const { s, p } = make(id);
      const b = await create(p);
      await p.start(b.id, { argv: ["fleetd", "sandbox-guest", "--listen", "ws"], env: { FLEETD_BOX_SECRET: "s3cret value'x", GH_TOKEN: "ghs_abc" }, cwd: "/home/user/repo" });
      const box = s.boxes.get(b.id);
      const command = box.commands.at(-1).command;
      expect(command).not.toContain("ghs_abc");
      expect(command).not.toContain("s3cret");
      expect(command).toContain("sandbox-guest");
      expect(box.commands.at(-1).detached).toBe(true);
      // The environment went to a file the command reads and removes.
      const at = /\/tmp\/\.fleetd-env-[0-9a-f-]+/.exec(command)![0];
      expect(command).toContain(`. '\\''${at}'\\'' && rm -f '\\''${at}'\\''`);
      expect(new TextDecoder().decode(s.files.get(at))).toBe(envFile({ FLEETD_BOX_SECRET: "s3cret value'x", GH_TOKEN: "ghs_abc" }));
    });

    test("the guest's port as a byte stream: the provider's access header and fleetd's secret", async () => {
      const { s, p } = make(id);
      const b = await create(p);
      const d = await p.connect(b.id, GUEST_PORT, SECRET);
      const w = d.writable.getWriter();
      await w.write(new Uint8Array([1, 2, 3, 255]));
      const r = d.readable.getReader();
      const { value } = await r.read();
      expect([...value!]).toEqual([1, 2, 3, 255]);
      expect(s.upgrades.at(-1)!.get("x-fleetd-box-secret")).toBe(SECRET);
      d.close();
      await d.closed;
      const bad = await p.connect(b.id, GUEST_PORT, "not-the-secret").catch((e) => e);
      expect(bad).toBeInstanceOf(ProviderError);
      expect(bad.reason).toBe("unreachable");
      expect(bad.message).not.toContain("not-the-secret");
    });

    test("read: a file's bytes, refused past the cap or when missing", async () => {
      const { s, p } = make(id);
      const b = await create(p);
      s.files.set("/home/user/repo/out.png", new Uint8Array([9, 8, 7, 6, 5]));
      expect([...(await p.read(b.id, "/home/user/repo/out.png", 10))]).toEqual([9, 8, 7, 6, 5]);
      const big = await p.read(b.id, "/home/user/repo/out.png", 3).catch((e) => e);
      expect(big.message).toContain("larger than 3 bytes");
      const none = await p.read(b.id, "/home/user/nope", 3).catch((e) => e);
      expect(none.message).toContain("no file /home/user/nope");
    });

    test("build: the recipe becomes the provider's template", async () => {
      const { s, p } = make(id);
      const logs: string[] = [];
      const name = await p.build(DOCKERFILE, { name: "fleetd-abc", onLog: (l) => logs.push(l) });
      expect(name).toBe("fleetd-abc");
      const cmds = s.calls.filter((c) => /\/commands$/.test(c.path)).map((c) => c.body.command as string);
      expect(cmds).toHaveLength(3);
      expect(cmds[0]).toContain("apt-get install -y git curl");
      expect(cmds[1]).toContain("cd '\\''/work'\\''");
      expect(cmds[1]).toContain("export BUN_INSTALL='\\''/opt/bun'\\''");
      expect(cmds[2]).toContain("/etc/environment");
      expect(s.calls.some((c) => c.path === "/api/v1/saved-snapshots" && c.body.name === "fleetd-abc")).toBe(true);
      // The build's box goes once the snapshot is saved.
      expect(s.boxes.size).toBe(0);
      expect(logs[0]).toContain("boat's own Ubuntu 24.04");
    });

    test("a provider that can't be reached says so", async () => {
      const p = provider(id, { key: KEY }, { urls: { api: "http://127.0.0.1:1" } });
      const e = await p.list().catch((e) => e);
      expect(e.reason).toBe("unreachable");
      expect(e.message).toContain("127.0.0.1:1");
    });

    test("a bad idempotency key is refused before any call", async () => {
      const { s, p } = make(id);
      const e = await create(p, "Not Valid").catch((e) => e);
      expect(e.message).toContain("idempotency key");
      expect(s.calls).toHaveLength(0);
    });
  });
}

describe("refusals in plain words", () => {
  const cases: [ProviderId, number, unknown, string, RegExp][] = [
    ["boat", 402, { ok: false, code: "billing_required", message: "Add a card", error: { code: "billing_required", message: "Add a card", status: 402 } }, "billing", /billing is sorted out/],
    ["boat", 429, { ok: false, code: "limit_reached", message: "100 at once" }, "limit", /sandboxes at once/],
    ["boat", 429, { ok: false, code: "rate_limited", message: "12 per minute", window: "minute" }, "limit", /sandbox starts/],
    ["boat", 403, { ok: false, code: "trial_machine_class_not_allowed", message: "Needs a paid plan" }, "billing", /doesn't include that sandbox size/],
  ];
  for (const [id, status, body, reason, words] of cases) {
    test(`${id} ${status} ${JSON.stringify(body).slice(0, 60)}`, async () => {
      const { s, p } = make(id);
      s.fail({ path: /POST \/(api\/v1\/)?(v2\/)?sandbox(es)?$/, status, body });
      const e = await create(p).catch((e) => e);
      expect(e).toBeInstanceOf(ProviderError);
      expect(e.reason).toBe(reason);
      expect(e.message).toMatch(words);
      expect(e.status).toBe(status);
    });
  }

  test("a key a provider echoes back is masked", async () => {
    const { s, p } = make("boat");
    s.fail({ path: /GET \/api\/v1\/sandboxes/, status: 401, body: { ok: false, code: "unauthorized", message: `key ${KEY} is revoked` } });
    const e = await p.list().catch((e) => e);
    expect(e.reason).toBe("invalid_key");
    expect(e.message).not.toContain(KEY);
  });
});

describe("each provider's own settings", () => {



  test("boat: no account secrets, no snapshots, no history, a size that fits, and the delete's confirmation", async () => {
    const { s, p } = make("boat");
    const b = await p.create({ template: "fleetd-abc", key: "k-9", labels: {}, lifetimeMs: 60_000, size: { cpu: 4, memGb: 8 } });
    const c = s.calls.find((c) => c.path === "/api/v1/sandboxes" && c.method === "POST")!;
    expect(c.body).toMatchObject({ from: "fleetd-abc", type: "default", ttlSeconds: 60, noEnv: true, snapshots: false, monitoring: false });
    expect(c.headers.get("idempotency-key")).toBe("k-9");
    await p.destroy(b.id);
    expect(s.calls.at(-1)!.headers.get("x-ascii-confirm-delete")).toBe(b.id);
    expect(typeFor({ cpu: 2, memGb: 4 })).toBe("small");
    expect(typeFor({ cpu: 16, memGb: 32 })).toBe("xlarge");
  });

  test("boat: a build after a failed one gets a fresh box, though boat keeps keys after their box is gone", async () => {
    const { s, p } = make("boat");
    s.fail({ path: /GET \/api\/v1\/saved-snapshots\//, status: 500, body: { ok: false, code: "http_500", message: "save broke" } });
    const e = await p.build(DOCKERFILE, { name: "fleetd-abc" }).catch((e) => e);
    expect(e.message).toContain("save broke");
    expect(s.boxes.size).toBe(0);
    expect(await p.build(DOCKERFILE, { name: "fleetd-abc" })).toBe("fleetd-abc");
    const keys = s.calls.filter((c) => c.path === "/api/v1/sandboxes" && c.method === "POST").map((c) => c.headers.get("idempotency-key"));
    expect(keys).toHaveLength(2);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys.every((k) => /^build-[0-9a-f]{8}-fleetd-abc$/.test(k!))).toBe(true);
  });


});

describe("exact sizes, never rounded", () => {
  test("each provider lists exact sizes, the default first", () => {
    for (const k of ["vm", "boat"] as const) {
      expect(SIZES[k][0]).toEqual(DEFAULT_SIZE);
      expect(SIZES[k].every((s) => Number.isInteger(s.cpu) && Number.isInteger(s.memGb))).toBe(true);
    }
    // boat's list is exactly its machine types.
    expect(SIZES.boat).toEqual(TYPES.map(({ cpu, memGb }) => ({ cpu, memGb })));
  });

  test("boat: each listed size reaches create as its own type, and one boat has no type of is refused, not rounded up", async () => {
    for (const t of TYPES) {
      const { s, p } = make("boat");
      await p.create({ template: "fleetd-abc", key: "k-1", labels: {}, lifetimeMs: 60_000, size: { cpu: t.cpu, memGb: t.memGb } });
      expect(s.calls.find((c) => c.path === "/api/v1/sandboxes" && c.method === "POST")!.body.type).toBe(t.type);
    }
    // 2 vCPU / 6 GB once became "default" (4 vCPU / 8 GB): now no box is made at all.
    const { s, p } = make("boat");
    const e = await p.create({ template: "fleetd-abc", key: "k-2", labels: {}, lifetimeMs: 60_000, size: { cpu: 2, memGb: 6 } }).catch((e) => e);
    expect(e.message).toBe("boat.dev comes in no 2 vCPU / 6 GB: its sizes are 2 vCPU / 4 GB, 4 vCPU / 8 GB, 8 vCPU / 16 GB, 16 vCPU / 32 GB");
    expect(s.calls.some((c) => c.path === "/api/v1/sandboxes" && c.method === "POST")).toBe(false);
    expect(() => typeFor({ cpu: 32, memGb: 64 })).toThrow("comes in no 32 vCPU / 64 GB");
  });

});

describe("the recipe", () => {
  test("parse: FROM, then RUN/ENV/WORKDIR/USER; anything else refused", () => {
    const r = parse(DOCKERFILE);
    expect(r.from).toBe(`ubuntu@sha256:${"a".repeat(64)}`);
    expect(r.steps.map((s) => s.op)).toEqual(["RUN", "ENV", "WORKDIR", "RUN"]);
    // A RUN continued over lines is one shell line, as Docker joins it, not a command a line.
    expect(r.steps[0]!.args[0]).toBe("apt-get update  && apt-get install -y git curl");
    expect(parse("FROM x\nRUN a \\\n  b \\\n  && c\n").steps[0]!.args).toEqual(["a   b   && c"]);
    expect(() => parse("FROM x\nCOPY a b\n")).toThrow("COPY");
    expect(() => parse("FROM x\nRUN cat <<EOF > f\nhi\nEOF\n")).toThrow("heredoc");
    expect(() => parse("FROM x\nRUN cat <<<hi\n")).not.toThrow();
    expect(() => parse("FROM x AS a\nFROM y\n")).toThrow("second FROM");
    expect(() => parse("RUN x\n")).toThrow("not FROM");
    expect(() => parse('FROM x\nRUN ["a"]\n')).toThrow("JSON form");
  });

  test("hosted: Claude Code and fleetd pinned on top of the base, and the name follows the text", () => {
    const sha = "b".repeat(64);
    const d = hosted(DOCKERFILE, { claude: "2.1.314", fleetd: { url: "https://github.com/unlaboredlabs/fleetd/releases/download/edge/fleetd-linux-x64-0123456789abcdef", sha256: sha } });
    expect(d.startsWith(DOCKERFILE.trimEnd())).toBe(true);
    expect(d).toContain("bash /tmp/claude-install.sh 2.1.314");
    expect(d).toContain(`echo '${sha}  /usr/local/bin/fleetd' | sha256sum -c -`);
    expect(parse(d).steps.at(-1)).toEqual({ op: "ENV", args: ["DISABLE_AUTOUPDATER", "1"] });
    expect(templateName(d)).toMatch(/^fleetd-[0-9a-f]{12}$/);
    expect(templateName(d)).not.toBe(templateName(DOCKERFILE));
    expect(() => hosted(DOCKERFILE, { claude: "latest", fleetd: { url: "https://x", sha256: sha } })).toThrow("isn't a version");
  });

  test("launcher: quoted argv, the environment file read and removed, no stdin", () => {
    const l = launcher(["fleetd", "sandbox-guest", "it's"], { envAt: "/tmp/.e", cwd: "/home/user/r" });
    expect(l).toBe(`sh -c '. '\\''/tmp/.e'\\'' && rm -f '\\''/tmp/.e'\\'' && cd '\\''/home/user/r'\\'' && exec '\\''fleetd'\\'' '\\''sandbox-guest'\\'' '\\''it'\\''\\'\\'''\\''s'\\'' </dev/null >>'\\''/dev/null'\\'' 2>&1'`);
    expect(() => envFile({ "BAD-NAME": "x" })).toThrow("not a variable name");
  });
});
