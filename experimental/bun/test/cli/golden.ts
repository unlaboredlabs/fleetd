// Golden tests: the Bun CLI and the Rust one run on the same inputs, their stdout, stderr and exit code compared after
// what differs run to run (keys, ids, times, the scratch home, ports) is replaced by a placeholder.
//
// With FLEETD_RUST_BIN set (a Rust `fleetd` binary), every case runs both live, the hub ones against a Rust hub
// started on a fresh home. Without it (CI's Bun job) the cases that need no hub compare against what the Rust binary
// printed when they were recorded (test/cli/fixtures, `RECORD=1 FLEETD_RUST_BIN=… bun test test/cli`).
// Every call gets FLEETD_HOME and the hub URL of a scratch home under $TMPDIR: nothing reads ~/.fleetd or a live hub.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const RUST = process.env.FLEETD_RUST_BIN;
export const RECORD = process.env.RECORD === "1";
const SRC = join(import.meta.dir, "../../src/main.ts");
const FIXTURES = join(import.meta.dir, "fixtures");
/** The version both report, so `version` and the doctor's versions line read the same. */
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

  constructor(name: string) {
    this.home = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", `fleetd-golden-${name}-`));
    this.hubHome = join(this.home, "hub");
    this.cwd = join(this.home, "cwd");
    mkdirSync(this.cwd, { recursive: true });
    mkdirSync(this.hubHome, { recursive: true, mode: 0o700 });
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    // Never the person's own fleet, nor a session's.
    delete env.FLEETD_KEY_FILE;
    delete env.FLEETD_THREAD_ID;
    // Units go under the scratch home: `uninstall` never finds the machine's own.
    delete env.XDG_RUNTIME_DIR;
    const merged: Record<string, string> = { ...env, FLEETD_HOME: this.home, HOME: this.home, XDG_CONFIG_HOME: join(this.home, ".config"), TZ: "UTC", NO_COLOR: "1", FLEETD_VERSION: SAME_VERSION, ...extra };
    // A case gives UNSET to leave a variable out: `NO_COLOR: UNSET` runs as a person's shell does.
    for (const [k, v] of Object.entries(merged)) if (v === UNSET) delete merged[k];
    return merged;
  }

  /** Starts the Rust hub on this home and writes the setup.json the CLI reads its address from. */
  async startRustHub(): Promise<void> {
    if (!RUST) throw new Error("FLEETD_RUST_BIN is not set");
    const probe = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
    const port = probe.port;
    await probe.stop(true);
    const listen = `127.0.0.1:${port}`;
    this.hubUrl = `http://${listen}`;
    writeFileSync(join(this.hubHome, "setup.json"), `${JSON.stringify({ listen, url: this.hubUrl, machines: {} }, null, 2)}\n`);
    this.hub = Bun.spawn([RUST, "hub", "start", "--home", this.hubHome, "--listen", listen], {
      cwd: this.cwd,
      env: this.env(),
      stdout: "ignore",
      stderr: Bun.file(join(this.home, "hub.log")),
    });
    for (let i = 0; i < 200; i++) {
      const ok = await fetch(`${this.hubUrl}/healthz`).then((r) => r.ok, () => false);
      if (ok) return;
      await Bun.sleep(50);
    }
    throw new Error(`the Rust hub did not answer: ${readFileSync(join(this.home, "hub.log"), "utf8")}`);
  }

  async run(which: "rust" | "bun", argv: string[], opts: { env?: Record<string, string>; stdin?: string; cwd?: string } = {}): Promise<Run> {
    const cmd = which === "rust" ? [RUST!, ...argv] : [process.execPath, SRC, ...argv];
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
    // A QR encodes the run's own code: test/cli/qr.test.ts checks it against the Rust one.
    .replace(/(^[█▀▄ ]+$\n?)+/gm, "<QR>\n")
    .replace(/fld_[a-z2-7]{52}/g, "fld_KEY")
    .replace(/fle_[a-z2-7]{52}/g, "fle_CODE")
    .replace(/fld_[a-z2-7]{6}/g, "fld_PFX")
    .replace(/key_[a-z2-7]{8}/g, "key_ID")
    .replace(/^[0-9a-f]{12}  /gm, "CODEID  ")
    .replace(/\bp_[a-z2-7]{8}\b/g, "p_ID")
    .replace(/\binv_[a-z2-7]{8}\b/g, "inv_ID")
    .replace(/\b[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}\b/g, "CODE")
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "TIME")
    .replace(/\b\d{4}-\d{2}-\d{2} \d{2}:\d{2}\b/g, "LOCALTIME")
    .replace(/\b\d{2}:\d{2} UTC\b/g, "HH:MM UTC");
}

/** A case recorded from the Rust binary, or undefined when there is none yet. */
export function fixture(name: string): Run | undefined {
  const file = join(FIXTURES, `${name}.json`);
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as Run) : undefined;
}

export function record(name: string, run: Run) {
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(join(FIXTURES, `${name}.json`), `${JSON.stringify(run, null, 2)}\n`);
}
