// The hosted sandbox clients (boat.dev, E2B, Daytona) against stand-in servers of each provider (stand_ins.ts): the
// same behaviour from all three behind the one interface (idempotent create and destroy, the leak sweep's list,
// lifetime, a detached start whose secrets stay out of the command, the port stream, reading a file, building a
// template), each provider's own auth header and settings, and refusals in plain words.
import { afterEach, describe, expect, test } from "bun:test";
import { boatStandIn, daytonaStandIn, e2bStandIn, KEY, SECRET, type StandIn } from "./stand_ins.ts";
import { GUEST_PORT, provider, ProviderError, type Provider, type ProviderId } from "../../src/sandbox/providers/index.ts";
import { frames } from "../../src/sandbox/providers/e2b.ts";
import { typeFor } from "../../src/sandbox/providers/boat.ts";
import { hosted, parse, templateName } from "../../src/sandbox/providers/recipe.ts";
import { envFile, launcher } from "../../src/sandbox/providers/shell.ts";

const running: StandIn[] = [];
afterEach(() => {
  for (const s of running.splice(0)) s.stop();
});

function make(id: ProviderId, key = KEY): { s: StandIn; p: Provider } {
  const s = id === "e2b" ? e2bStandIn() : id === "boat" ? boatStandIn() : daytonaStandIn();
  running.push(s);
  const api = id === "boat" ? `${s.url}/api/v1` : s.url;
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

for (const id of ["e2b", "boat", "daytona"] as const) {
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
      for (const c of api) {
        if (id === "e2b") expect(c.headers.get("x-api-key")).toBe(KEY);
        else expect(c.headers.get("authorization")).toBe(`Bearer ${KEY}`);
      }
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
      if (id === "e2b") expect(got().timeout).toBe(7200);
      if (id === "boat") expect(got().ttlSeconds).toBe(7200);
      if (id === "daytona") expect(got().ttlMinutes).toBe(120);
      await p.lifetime(b.id, 5 * 3600_000);
      if (id === "e2b") expect(got().timeout).toBe(18000);
      if (id === "boat") expect(got().ttlSeconds).toBe(18000);
      if (id === "daytona") expect(got().ttlMinutes).toBe(300);
    });

    test("a detached start: the environment reaches the command, never the command's text", async () => {
      const { s, p } = make(id);
      const b = await create(p);
      await p.start(b.id, { argv: ["fleetd", "sandbox-guest", "--listen", "ws"], env: { FLEETD_BOX_SECRET: "s3cret value'x", GH_TOKEN: "ghs_abc" }, cwd: "/home/user/repo" });
      const box = s.boxes.get(b.id);
      if (id === "e2b") {
        const msgs = [];
        for await (const m of frames(new Response(box.started.body).body!)) msgs.push(m.payload);
        expect(msgs[0].process).toEqual({ cmd: "fleetd", args: ["sandbox-guest", "--listen", "ws"], envs: { FLEETD_BOX_SECRET: "s3cret value'x", GH_TOKEN: "ghs_abc" }, cwd: "/home/user/repo" });
        expect(msgs[0].stdin).toBe(false);
        expect(box.started.headers.get("x-access-token")).toBe("envd-token");
        // The account's key never goes to the box's own host.
        expect(s.calls.filter((c) => c.path.startsWith("/box/")).every((c) => c.headers.get("x-api-key") === null)).toBe(true);
        return;
      }
      const command = id === "boat" ? box.commands.at(-1).command : box.toolbox.at(-1).body.command;
      expect(command).not.toContain("ghs_abc");
      expect(command).not.toContain("s3cret");
      expect(command).toContain("sandbox-guest");
      if (id === "boat") expect(box.commands.at(-1).detached).toBe(true);
      if (id === "daytona") expect(box.toolbox.at(-1).body.runAsync).toBe(true);
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
      if (id === "e2b") {
        expect(name).toBe("tpl1");
        const tpl = s.calls.find((c) => c.path === "/v3/templates")!;
        expect(tpl.body).toEqual({ name: "fleetd-abc", cpuCount: 2, memoryMB: 4096 });
        const build = s.calls.find((c) => c.path === "/v2/templates/tpl1/builds/b1")!;
        expect(build.body.fromImage).toBe(`ubuntu@sha256:${"a".repeat(64)}`);
        expect(build.body.steps).toEqual([
          { type: "RUN", args: ["apt-get update  && apt-get install -y git curl", "root"] },
          { type: "ENV", args: ["BUN_INSTALL", "/opt/bun", "PATH", "/opt/bun/bin:/usr/bin"] },
          { type: "WORKDIR", args: ["/work"] },
          { type: "RUN", args: ["echo hi", "root"] },
        ]);
      }
      if (id === "daytona") {
        expect(name).toBe("fleetd-abc");
        const snap = s.calls.find((c) => c.path === "/snapshots" && c.method === "POST")!;
        expect(snap.body).toEqual({ name: "fleetd-abc", buildInfo: { dockerfileContent: DOCKERFILE }, cpu: 2, memory: 4, disk: 10 });
      }
      if (id === "boat") {
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
      }
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
    ["e2b", 429, { code: 429, message: "Rate limit exceeded" }, "limit", /E2B's limit/],
    ["e2b", 403, { code: 403, message: "team is blocked" }, "billing", /blocked this team's account/],
    ["e2b", 400, { code: 400, message: "The requested timeout exceeds the sandbox lifetime limit" }, "limit", /caps a sandbox's life/],
    // E2B's own words on a Hobby account, seen live.
    ["e2b", 400, { code: 400, message: "Timeout cannot be greater than 1 hours" }, "limit", /caps a sandbox's life/],
    ["e2b", 503, { code: 503, error_code: "sandbox_capacity_unavailable", message: "not enough capacity" }, "failed", /try again in a minute/],
    ["boat", 402, { ok: false, code: "billing_required", message: "Add a card", error: { code: "billing_required", message: "Add a card", status: 402 } }, "billing", /billing is sorted out/],
    ["boat", 429, { ok: false, code: "limit_reached", message: "100 at once" }, "limit", /sandboxes at once/],
    ["boat", 429, { ok: false, code: "rate_limited", message: "12 per minute", window: "minute" }, "limit", /sandbox starts/],
    ["boat", 403, { ok: false, code: "trial_machine_class_not_allowed", message: "Needs a paid plan" }, "billing", /doesn't include that sandbox size/],
    ["daytona", 403, { statusCode: 403, message: "Total CPU quota exceeded. Maximum allowed: 10" }, "limit", /Daytona's limit/],
    ["daytona", 403, { statusCode: 403, message: "Organization is suspended: insufficient credits" }, "billing", /billing is sorted out/],
    ["daytona", 429, { statusCode: 429, message: "Rate limit exceeded" }, "limit", /Daytona's limit/],
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
  test("E2B: a set timeout, no auto-pause, private ports, and the idempotency key", async () => {
    const { s, p } = make("e2b");
    await create(p);
    const c = s.calls.find((c) => c.path === "/v2/sandboxes" && c.method === "POST")!;
    expect(c.body).toMatchObject({ templateID: "fleetd-abc", timeout: 7200, autoPause: false, network: { allowPublicTraffic: false } });
    expect(c.headers.get("idempotency-key")).toBe("sess-1");
  });

  test("E2B: a create still under way on E2B's side is asked again with the same key", async () => {
    const { s, p } = make("e2b");
    s.fail({ path: /POST \/v2\/sandboxes$/, status: 409, body: { code: 409, error_code: "idempotency_in_progress", message: "in progress" }, times: 2 });
    const b = await create(p);
    expect(s.boxes.has(b.id)).toBe(true);
  });

  test("E2B: domain points the client at a self-hosted E2B", async () => {
    const seen: string[] = [];
    const fake = (async (url: string) => (seen.push(String(url)), Response.json([]))) as unknown as typeof fetch;
    await provider("e2b", { key: KEY, domain: "e2b.example.internal" }, { fetch: fake }).list();
    expect(seen[0]).toStartWith("https://api.e2b.example.internal/v2/sandboxes?");
  });

  test("boat: no account secrets, no snapshots, no history, a size that fits, and the delete's confirmation", async () => {
    const { s, p } = make("boat");
    const b = await p.create({ template: "fleetd-abc", key: "k-9", labels: {}, lifetimeMs: 60_000, size: { cpu: 4, memGb: 8 } });
    const c = s.calls.find((c) => c.path === "/api/v1/sandboxes" && c.method === "POST")!;
    expect(c.body).toMatchObject({ from: "fleetd-abc", type: "default", ttlSeconds: 60, noEnv: true, snapshots: false, monitoring: false });
    expect(c.headers.get("idempotency-key")).toBe("k-9");
    await p.destroy(b.id);
    expect(s.calls.at(-1)!.headers.get("x-ascii-confirm-delete")).toBe(b.id);
    expect(typeFor({ cpu: 2, memGb: 4 })).toBe("small");
    expect(typeFor({ cpu: 2, memGb: 6 })).toBe("default");
    expect(() => typeFor({ cpu: 32, memGb: 64 })).toThrow("largest size");
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

  test("Daytona: ephemeral, no auto-stop, private, and a size past its cap refused", async () => {
    const { s, p } = make("daytona");
    await create(p);
    const c = s.calls.find((c) => c.path === "/sandbox" && c.method === "POST")!;
    expect(c.body).toMatchObject({ name: "sess-1", snapshot: "fleetd-abc", public: false, autoStopInterval: 0, autoDeleteInterval: 0, ttlMinutes: 120 });
    const e = await p.build(DOCKERFILE, { name: "x", size: { cpu: 8, memGb: 16 } }).catch((e) => e);
    expect(e.message).toContain("Daytona's largest sandbox is 4 vCPUs and 8 GB");
  });

  test("Daytona: a name taken by a box fleetd didn't make is not answered as ours", async () => {
    const { s, p } = make("daytona");
    s.boxes.set("theirs", { id: "theirs", name: "sess-1", labels: {}, state: "started" });
    const e = await create(p).catch((e) => e);
    expect(e.message).toContain("didn't make");
  });
});

describe("the recipe", () => {
  test("parse: FROM, then RUN/ENV/WORKDIR/USER; anything else refused", () => {
    const r = parse(DOCKERFILE);
    expect(r.from).toBe(`ubuntu@sha256:${"a".repeat(64)}`);
    expect(r.steps.map((s) => s.op)).toEqual(["RUN", "ENV", "WORKDIR", "RUN"]);
    // A RUN continued over lines is one shell line, as Docker joins it: E2B ran each line as a command of its own.
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
