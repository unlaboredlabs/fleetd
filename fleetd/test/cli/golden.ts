// Golden tests: the CLI's stdout, stderr and exit code for each case, compared with what it printed when the case was
// recorded (test/cli/fixtures, `RECORD=1 bun test test/cli/golden.test.ts`), after what differs run to run (keys, ids,
// times, dates, the scratch home, ports) is replaced by a placeholder. The hub cases run against a hub started on a
// fresh home. Every call gets FLEETD_HOME and the hub URL of a scratch home under $TMPDIR: nothing reads ~/.fleetd or
// a live hub.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { listenPort } from "../ports.ts";
import { standInTools } from "../tools.ts";

export const RECORD = process.env.RECORD === "1";
const SRC = join(import.meta.dir, "../../src/main.ts");
const FIXTURES = join(import.meta.dir, "fixtures");
/** The version every run reports, so `version` and the doctor's versions line read the same. */
export const SAME_VERSION = "0.0.0-edge.202611081341+e4509af";
/** An env value that leaves the variable out. */
export const UNSET = "\u0000unset";

export type Run = { code: number; stdout: string; stderr: string };

export class Fleet {
  readonly home: string;
  readonly hubHome: string;
  readonly cwd: string;
  hubUrl = "";
  private hub: ReturnType<typeof Bun.spawn> | undefined;
  /** `tools`: the stand-ins a real node starts (../tools.ts), first on every call's PATH. */
  private readonly tools: Record<string, string> = {};

  constructor(name: string, o: { tools?: boolean } = {}) {
    this.home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", `fleetd-golden-${name}-`));
    this.hubHome = join(this.home, "hub");
    this.cwd = join(this.home, "cwd");
    mkdirSync(this.cwd, { recursive: true });
    mkdirSync(this.hubHome, { recursive: true, mode: 0o700 });
    if (o.tools) this.tools = standInTools(this.home);
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    // Never the person's own fleet, nor a session's.
    delete env.FLEETD_KEY_FILE;
    delete env.FLEETD_THREAD_ID;
    // Units go under the scratch home: `uninstall` never finds the machine's own.
    delete env.XDG_RUNTIME_DIR;
    const merged: Record<string, string> = { ...env, FLEETD_HOME: this.home, HOME: this.home, XDG_CONFIG_HOME: join(this.home, ".config"), TZ: "UTC", NO_COLOR: "1", FLEETD_VERSION: SAME_VERSION, ...this.tools, ...extra };
    // A case gives UNSET to leave a variable out: `NO_COLOR: UNSET` runs as a person's shell does.
    for (const [k, v] of Object.entries(merged)) if (v === UNSET) delete merged[k];
    return merged;
  }

  /** Starts a hub on this home and writes the setup.json the CLI reads its address from. Its port is one no other
   * process was handed (../ports.ts), and the hub is this one once its own log says it listens there: a hub that
   * couldn't take the port (another test run's took it first) is started again on another. */
  async startHub(): Promise<void> {
    const log = join(this.home, "hub.log");
    for (let tries = 1; ; tries++) {
      const listen = `127.0.0.1:${listenPort()}`;
      this.hubUrl = `http://${listen}`;
      writeFileSync(join(this.hubHome, "setup.json"), `${JSON.stringify({ listen, url: this.hubUrl, machines: {} }, null, 2)}\n`);
      const hub = Bun.spawn([process.execPath, SRC, "hub", "start", "--home", this.hubHome, "--listen", listen], {
        cwd: this.cwd,
        env: this.env(),
        stdout: "ignore",
        stderr: Bun.file(log),
      });
      this.hub = hub;
      const said = () => (existsSync(log) ? readFileSync(log, "utf8") : "");
      for (let i = 0; i < 200 && hub.exitCode === null && !said().includes(`listening on ${listen}`); i++) await Bun.sleep(50);
      if (hub.exitCode === null && said().includes(`listening on ${listen}`)) {
        for (let i = 0; i < 200; i++) {
          const ok = await fetch(`${this.hubUrl}/healthz`).then((r) => r.ok, () => false);
          if (ok) return;
          await Bun.sleep(50);
        }
      }
      if (hub.exitCode === null || tries === 3 || !/EADDRINUSE|in use/i.test(said())) throw new Error(`the hub did not answer: ${said()}`);
    }
  }

  async run(argv: string[], opts: { env?: Record<string, string>; stdin?: string; cwd?: string } = {}): Promise<Run> {
    const cmd = [process.execPath, SRC, ...argv];
    const proc = Bun.spawn(cmd, {
      cwd: opts.cwd === undefined ? this.cwd : join(this.cwd, opts.cwd),
      env: this.env(opts.env),
      stdin: opts.stdin === undefined ? "ignore" : new Blob([opts.stdin]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stdout, stderr };
  }

  normalize(run: Run): Run {
    const n = (t: string) => normalize(t, this);
    return { code: run.code, stdout: n(run.stdout), stderr: n(run.stderr) };
  }

  async stop(): Promise<void> {
    if (this.hub) {
      this.hub.kill("SIGTERM");
      await this.hub.exited;
    }
    rmSync(this.home, { recursive: true, force: true });
  }
}

export function normalize(text: string, fleet: Fleet): string {
  let t = text;
  if (fleet.hubUrl) t = t.replaceAll(fleet.hubUrl.replace("http://", ""), "HUB");
  t = t.replaceAll(fleet.home, "$HOME");
  return t
    // A QR encodes the run's own code: test/cli/qr.test.ts checks it.
    .replace(/(^[█▀▄ ]+$\n?)+/gm, "<QR>\n")
    // A test's own server (a release feed) is on a port of its own each run.
    .replace(/http:\/\/127\.0\.0\.1:\d+\//g, "http://127.0.0.1:PORT/")
    // The hub database's size, which each new table changes.
    .replace(/"storedBytes":\d+/g, '"storedBytes":0')
    .replace(/fld_[a-z2-7]{52}/g, "fld_KEY")
    .replace(/fle_[a-z2-7]{52}/g, "fle_CODE")
    .replace(/fld_[a-z2-7]{6}/g, "fld_PFX")
    .replace(/key_[a-z2-7]{8}/g, "key_ID")
    // The fleetd a machine gets is the binary running the test.
    .replace(/\(stdin: the fleetd binary .+ \(\d+ bytes\)\)/g, "(stdin: the fleetd binary)")
    .replace(/^[0-9a-f]{12}  /gm, "CODEID  ")
    .replace(/\bp_[a-z2-7]{8}\b/g, "p_ID")
    .replace(/\binv_[a-z2-7]{8}\b/g, "inv_ID")
    .replace(/\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/g, "CODE")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "TIME")
    .replace(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/g, "LOCALTIME")
    // A calendar day on its own (`fleetd metrics`' range and day list): the run's own date, another one each day.
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, "DATE")
    .replace(/\b\d{2}:\d{2} UTC\b/g, "HH:MM UTC");
}

/** A case as recorded, or undefined when there is none yet. */
export function fixture(name: string): Run | undefined {
  const file = join(FIXTURES, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Run) : undefined;
}

export function record(name: string, run: Run) {
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(join(FIXTURES, `${name}.json`), `${JSON.stringify(run, null, 2)}\n`);
}
