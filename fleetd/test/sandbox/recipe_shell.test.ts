// What the hosted template's recipe and a box's start put into a shell line, run through a real shell with stand-ins
// on PATH: each value reaches its command whole (a signed link's `&`s, `;`, `$`, backticks, spaces and quotes among
// them), nothing of it runs as a command, what can't be quoted is refused in plain words, and no URL's query reaches
// an error or a log line (W756: the cloud's template build ran its fleetd link's query as commands on 2026-11-22).
// And `deliver`, against the box's own bootstrap script, says which way fleetd reached the box.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { boatStandIn, KEY, type StandIn } from "./stand_ins.ts";
import { listenPort } from "../ports.ts";
import { provider } from "../../src/sandbox/providers/index.ts";
import { FLEETD_PATH, fetched, hosted, parse, word } from "../../src/sandbox/providers/recipe.ts";
import { noQuery } from "../../src/sandbox/providers/shell.ts";
import { dial } from "../../src/sandbox/providers/stream.ts";
import { TESTED } from "../../src/node/runner/claude_pins.ts";
import { bootArgv, deliver, firstWord } from "../../src/node/sandbox/remote/bootstrap.ts";

const root = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-recipe-shell-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let made = 0;
const fresh = () => {
  const d = join(root, `t${++made}`);
  mkdirSync(d, { recursive: true });
  return d;
};

const BASE = "FROM ubuntu:24.04\nRUN echo base\n";
const SHA = "c".repeat(64);
/** A made-up signed link, shaped as R2's are (never a real one), with a probe command after its last `&`. */
const SIGNED =
  "https://releases.example.invalid/fleetd/edge/fleetd-linux-x64?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=MADEUP%2F20261122%2Fauto%2Fs3%2Faws4_request&X-Amz-Date=20261122T064200Z&X-Amz-Expires=21600&X-Amz-Signature=0123madeup&X-Amz-SignedHeaders=host&fleetd_probe";

/** A directory of stand-ins: `curl` records its arguments (NUL-separated) and, with `CURL_WRITES`, writes that text to
 * its `-o` path; every probe name records that it ran. */
function standIns(): { bin: string; args: string; probed: string } {
  const bin = join(fresh(), "bin");
  mkdirSync(bin);
  const args = join(bin, "..", "curl.args");
  const probed = join(bin, "..", "probed");
  writeFileSync(
    join(bin, "curl"),
    `#!/bin/sh
for a in "$@"; do printf '%s\\0' "$a" >> "$CURL_ARGS"; done
[ -n "$CURL_WRITES" ] || exit 7
while [ $# -gt 0 ]; do [ "$1" = -o ] && { printf '%s' "$CURL_WRITES" > "$2"; exit 0; }; shift; done
exit 9
`,
  );
  for (const p of ["fleetd_probe", "X-Amz-Expires=21600", "X-Amz-SignedHeaders=host"]) writeFileSync(join(bin, p), `#!/bin/sh\necho ${p} >> "$PROBED"\n`);
  for (const f of ["curl", "fleetd_probe", "X-Amz-Expires=21600", "X-Amz-SignedHeaders=host"]) chmodSync(join(bin, f), 0o755);
  return { bin, args, probed };
}

/** `line` as boat's build runs a recipe's RUN (sandbox/providers/boat.ts): `bash -c 'set -e; …'`. */
function bash(line: string, s: ReturnType<typeof standIns>, env: Record<string, string> = {}) {
  const r = Bun.spawnSync(["bash", "-c", `set -e; ${line}`], { env: { PATH: `${s.bin}:/usr/bin:/bin`, CURL_ARGS: s.args, PROBED: s.probed, ...env }, stderr: "pipe", stdout: "pipe" });
  return { code: r.exitCode, err: r.stderr.toString() };
}
const curlGot = (s: ReturnType<typeof standIns>) => readFileSync(s.args, "utf8").split("\0").slice(0, -1);

describe("the recipe's shell lines", () => {
  test("the fleetd step hands curl a signed link whole, every `&`-joined part of it, and runs none of it as a command", () => {
    const run = parse(hosted(BASE, { claude: TESTED, fleetd: { url: SIGNED, sha256: SHA } })).steps.find((st) => st.op === "RUN" && st.args[0]!.includes(FLEETD_PATH))!;
    const s = standIns();
    const r = bash(run.args[0]!, s);
    // curl's stand-in ends the step (exit 7) before anything is written to FLEETD_PATH.
    expect(r.code).toBe(7);
    expect(curlGot(s)).toEqual(["-fsSL", SIGNED, "-o", FLEETD_PATH]);
    expect(r.err).not.toContain("command not found");
    expect(existsSync(s.probed)).toBe(false);
  });

  test("a URL with `;`, `$`, backticks, quotes, `|` or `&` reaches curl byte for byte, nothing of it run", () => {
    for (const tail of [";fleetd_probe", "$(fleetd_probe)", "`fleetd_probe`", "'q'fleetd_probe", '"q"$HOME', "|fleetd_probe", "&&fleetd_probe&", "${PATH}\\"]) {
      const url = `https://releases.example.invalid/f?a=1&b=${tail}`;
      const run = parse(hosted(BASE, { claude: TESTED, fleetd: { url, sha256: SHA } })).steps.find((st) => st.args[0]!.includes(FLEETD_PATH))!;
      const s = standIns();
      const r = bash(run.args[0]!, s);
      expect({ tail, got: curlGot(s) }).toEqual({ tail, got: ["-fsSL", url, "-o", FLEETD_PATH] });
      expect(existsSync(s.probed)).toBe(false);
      expect(r.code).toBe(7);
    }
  });

  test("a path with spaces, quotes, `;`, `&`, `$` and backticks is fetched to, checked and made executable at itself", () => {
    const body = "#!/bin/sh\necho fleetd\n";
    const sha = new Bun.CryptoHasher("sha256").update(body).digest("hex");
    for (const name of ["a b", "it's", 'say "hi"', "x;fleetd_probe", "y&fleetd_probe", "$(fleetd_probe)", "`fleetd_probe`", "$HOME"]) {
      const s = standIns();
      const path = join(dirname(s.bin), name);
      const r = bash(fetched("https://releases.example.invalid/f?a=1&b=2", sha, path), s, { CURL_WRITES: body });
      expect({ name, code: r.code, err: r.err }).toEqual({ name, code: 0, err: "" });
      expect(readFileSync(path, "utf8")).toBe(body);
      expect(statSync(path).mode & 0o777).toBe(0o755);
      expect(existsSync(s.probed)).toBe(false);
    }
  });

  test("what can't be quoted safely is refused in plain words, a URL's query left out of the words", () => {
    expect(() => word("a\nb")).toThrow("the recipe can't take");
    expect(() => word("a\tb")).toThrow("control character");
    expect(() => fetched("https://h.example.invalid/x?X-Amz-Signature=madeup\n", SHA, "/p")).toThrow("the recipe can't take");
    const e = (() => {
      try {
        fetched("https://h.example.invalid/x?X-Amz-Signature=madeup\nRUN evil", SHA, "/p");
      } catch (e) {
        return (e as Error).message;
      }
    })();
    expect(e).toContain("h.example.invalid");
    expect(e).not.toContain("madeup");
    for (const url of ["https://h.example.invalid/a b?X-Amz-Signature=madeup", "https://h.example.invalid/a?b=1\nRUN evil", "http://h.example.invalid/f"]) {
      expect(() => hosted(BASE, { claude: TESTED, fleetd: { url, sha256: SHA } })).toThrow("fleetd's pin needs an https URL");
      try {
        hosted(BASE, { claude: TESTED, fleetd: { url, sha256: SHA } });
      } catch (e) {
        expect((e as Error).message).not.toContain("madeup");
      }
    }
    // Claude Code's and the tunnel's steps take their URLs and paths quoted the same way.
    const d = hosted(BASE, { claude: TESTED });
    expect(d).toMatch(/curl -fsSL 'https:\/\/downloads\.claude\.ai\/[^']+' -o '\/opt\/claude\/claude-[0-9.]+'/);
    expect(d).toMatch(/curl -fsSL 'https:\/\/github\.com\/heiher\/[^']+' -o '\/usr\/local\/bin\/hev-socks5-tunnel'/);
  });

  test("a build step that fails says the step, the host and the HTTP status, and no part of a signed link's query", async () => {
    const said = "curl: (22) The requested URL returned error: 400";
    const s: StandIn = boatStandIn(undefined, (c) => (c.includes(FLEETD_PATH) && c.includes("curl") ? { exitCode: 22, stderr: `* fetching ${SIGNED}\n${said}` } : { exitCode: 0 }));
    try {
      const p = provider("boat", { key: KEY }, { urls: { api: `${s.url}/api/v1` }, pollMs: 5 });
      const logs: string[] = [];
      const e: Error = await p.build(hosted(BASE, { claude: TESTED, fleetd: { url: SIGNED, sha256: SHA } }), { name: "fleetd-tabc", onLog: (l) => logs.push(l) }).then(() => new Error("it built"), (e: Error) => e);
      expect(e.message).toContain("a step failed in boat.dev's build box (exit 22), RUN curl -fsSL 'https://releases.example.invalid/fleetd/edge/fleetd-linux-x64?");
      expect(e.message).toContain(said);
      for (const text of [e.message, ...logs]) for (const part of ["X-Amz", "MADEUP", "0123madeup", "21600", "fleetd_probe"]) expect({ text, has: text.includes(part) }).toEqual({ text, has: false });
      expect(logs.some((l) => l.startsWith("RUN curl -fsSL 'https://releases.example.invalid/fleetd/edge/fleetd-linux-x64?…"))).toBe(true);
    } finally {
      s.stop();
    }
  });

  test("noQuery leaves every URL's host and path and cuts its query and fragment", () => {
    expect(noQuery(`a ${SIGNED} b https://x.example.invalid/p#t=1 c`)).toBe("a https://releases.example.invalid/fleetd/edge/fleetd-linux-x64?… b https://x.example.invalid/p?… c");
    expect(noQuery("no url here, X=1&Y=2")).toBe("no url here, X=1&Y=2");
  });
});

describe("a box's start", () => {
  test("bootArgv makes each machine path whole, whatever it holds, and runs none of it", () => {
    const s = standIns();
    writeFileSync(join(s.bin, "bun"), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(s.bin, "sudo"), "#!/bin/sh\nexit 1\n");
    chmodSync(join(s.bin, "bun"), 0o755);
    chmodSync(join(s.bin, "sudo"), 0o755);
    const top = join(dirname(s.bin), "machine");
    const dirs = ["a b", "it's", 'say "hi"', "x;fleetd_probe", "y&fleetd_probe", "$(fleetd_probe)", "`fleetd_probe`", "new\nline", "$HOME"].map((n) => join(top, n, "inner"));
    const { argv } = bootArgv(dirs);
    const r = Bun.spawnSync(argv, { env: { PATH: `${s.bin}:/usr/bin:/bin`, PROBED: s.probed }, stderr: "pipe" });
    expect({ code: r.exitCode, err: r.stderr.toString() }).toEqual({ code: 0, err: "" });
    for (const d of dirs) expect({ d, there: existsSync(d) }).toEqual({ d, there: true });
    expect(existsSync(s.probed)).toBe(false);
  });
});

describe("deliver: which way fleetd reached the box", () => {
  const FLEETD = new TextEncoder().encode("#!/bin/sh\nexit 0\n");
  const sha = new Bun.CryptoHasher("sha256").update(FLEETD).digest("hex");
  const SECRET = "a-made-up-box-secret-0123456789";
  const procs: Bun.Subprocess[] = [];
  const servers: { stop(close?: boolean): void }[] = [];
  afterEach(() => {
    for (const p of procs.splice(0)) p.kill();
    for (const s of servers.splice(0)) s.stop(true);
  });

  /** The box's bootstrap script, run here as a box runs it (bootArgv), on a port of its own; `baked`: what the
   * template holds at FLEETD_PATH. */
  async function box(baked?: Uint8Array) {
    const dir = fresh();
    const port = listenPort();
    const at = join(dir, "baked-fleetd");
    if (baked) writeFileSync(at, baked);
    const { argv, env } = bootArgv();
    const p = Bun.spawn(argv, {
      env: { ...env, PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, FLEETD_BOX_SECRET: SECRET, FLEETD_BOOT_PORT: String(port), FLEETD_BOOT_DIR: join(dir, "box"), FLEETD_BOOT_BAKED: at },
      stdout: "ignore",
      stderr: "ignore",
    });
    procs.push(p);
    for (let i = 0; ; i++) {
      try {
        const link = await dial({ name: "the box", url: `http://127.0.0.1:${port}`, headers: { "x-fleetd-box-secret": SECRET }, secrets: [SECRET] });
        expect(await firstWord(link)).toBe("bootstrap");
        return { link, log: () => readFileSync(join(dir, "box", "boot.log"), "utf8") };
      } catch (e) {
        if (i > 100) throw e;
        await Bun.sleep(50);
      }
    }
  }

  /** A release host answering `status` (and fleetd's bytes on 200). */
  function host(status: number): string {
    const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (status === 200 ? new Response(FLEETD) : new Response("no", { status })) });
    servers.push(s);
    return `http://127.0.0.1:${s.port}`;
  }

  test("fetched by its address when the box's own fetch works", async () => {
    const b = await box();
    const got = await deliver(b.link, { sha256: sha, url: `${host(200)}/fleetd?X-Amz-Signature=madeup&X-Amz-Expires=21600`, bytes: async () => FLEETD });
    expect(got).toEqual({ way: "address" });
    b.link.close();
  });

  test("its bytes over the link when the box's own fetch fails, with the cause: the host and the HTTP status, no query", async () => {
    const b = await box();
    const at = host(400);
    let sent = false;
    const got = await deliver(b.link, { sha256: sha, url: `${at}/fleetd?X-Amz-Signature=madeup&X-Amz-Expires=21600`, bytes: async () => ((sent = true), FLEETD) });
    expect(sent).toBe(true);
    expect(got).toEqual({ way: "link", cause: `fetching fleetd from ${at.slice("http://".length)} answered HTTP 400` });
    b.link.close();
    // The box's own log says the same, with no part of the query either.
    expect(b.log()).toContain("answered HTTP 400");
    expect(b.log()).not.toContain("madeup");
    expect(b.log()).not.toContain("X-Amz");
  });

  test("its bytes over the link when there's no address, with no cause; the template's own when it is the same build", async () => {
    const b = await box();
    expect(await deliver(b.link, { sha256: sha, bytes: async () => FLEETD })).toEqual({ way: "link" });
    b.link.close();
    const t = await box(FLEETD);
    expect(await deliver(t.link, { sha256: sha, url: `${host(500)}/fleetd?X-Amz-Signature=madeup`, bytes: async () => FLEETD })).toEqual({ way: "template" });
    t.link.close();
  });
});
