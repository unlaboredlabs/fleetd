// People's 1Password service account tokens (crates/fleetd/src/node/onepassword_tokens.rs, D235): one file each in
// `<node home>/onepassword-tokens/<person id>.json`, kept as a Claude subscription is (./accounts.ts). And the SDK
// helper that reads 1Password with one (browser/onepassword.rs): `@1password/sdk`, pinned, run under Node.js by the
// Rust node's own helper script, read from its source so the two never differ, in the same install directory. The
// token is the helper's first line on stdin, never in an environment or argument; errors are masked by the caller.
//
// A session launched with a person (`SessionLaunch.onepassword`) has their token among its masked secrets as
// OP_SERVICE_ACCOUNT_TOKEN when its project and order have none of their own (`fallback`). It never reaches an
// environment.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import rustSource from "../../../../../crates/fleetd/src/node/browser/onepassword.rs" with { type: "text" };
import type { OnePasswordCard } from "../../shared/contracts.ts";
import { mkdirPrivate } from "../config.ts";
import type { NodeBoxKey } from "../identity.ts";
import type { Vars } from "../secrets/env.ts";
import { fingerprintOf, writeAtomic } from "../secrets/files.ts";
import { hasControl, ioWhy, openB64, readIfThere, removeIfThere, utf8 } from "./refusal.ts";

/** The project secret variable holding the service account token. */
export const TOKEN_ENV = "OP_SERVICE_ACCOUNT_TOKEN";
/** The SDK release the node installs. */
export const SDK_VERSION = "0.5.0";
const DIR = "onepassword-tokens";
const VALUE_MAX = 4096;
const RESOLVE_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 180_000;

/** The Rust node's helper script, `HELPER` in browser/onepassword.rs. */
export const HELPER = (() => {
  const start = rustSource.indexOf('pub const HELPER: &str = r#"');
  const from = rustSource.indexOf('r#"', start) + 3;
  return rustSource.slice(from, rustSource.indexOf('"#;', from));
})();

const tokenPath = (home: string, person: string) => join(home, DIR, `${person}.json`);

/** The person's token, when the node holds one. Throws only when its file can't be read. */
export function readToken(home: string, person: string): string | undefined {
  let bytes: Buffer | undefined;
  try {
    bytes = readIfThere(() => readFileSync(tokenPath(home, person)));
  } catch (error) {
    throw new Error(`cannot read ${person}'s 1Password token: ${ioWhy(error)}`);
  }
  if (!bytes) return undefined;
  try {
    const file = JSON.parse(bytes.toString("utf8")) as { value?: unknown };
    if (typeof file.value !== "string") throw new Error();
    return file.value;
  } catch {
    throw new Error(`${person}'s 1Password token file does not parse`);
  } finally {
    bytes.fill(0);
  }
}

/** Saves the person's token, or forgets it with no `sealed`. The fingerprint of the token held afterwards. */
export function applyToken(home: string, person: string, sealed: string | undefined, boxKey: NodeBoxKey | undefined): string | undefined {
  const file = tokenPath(home, person);
  if (sealed === undefined) {
    try {
      removeIfThere(() => rmSync(file));
    } catch (error) {
      throw new Error(`cannot remove ${person}'s 1Password token: ${ioWhy(error)}`);
    }
    return undefined;
  }
  if (!boxKey) throw new Error("this node takes no secrets: it has no box key");
  const plain = openB64(boxKey, sealed);
  if (!plain) throw new Error("the 1Password token was not sealed to this machine's current box key: seal it to its boxPubKey again");
  const text = utf8(plain);
  plain.fill(0);
  if (text === undefined) throw new Error("the 1Password token is not UTF-8 text");
  const value = text.trim();
  if (!value || Buffer.byteLength(value) > VALUE_MAX || hasControl(value)) throw new Error("the 1Password token is not one line of at most 4 KiB");
  try {
    mkdirPrivate(dirname(file));
  } catch (error) {
    throw new Error(`cannot make ${dirname(file)}: ${ioWhy(error)}`);
  }
  const bytes = Buffer.from(JSON.stringify({ value }));
  try {
    writeAtomic(file, bytes);
  } catch (error) {
    throw new Error(`cannot write ${person}'s 1Password token: ${ioWhy(error)}`);
  } finally {
    bytes.fill(0);
  }
  return fingerprintOf(value);
}

/** The person's token as OP_SERVICE_ACCOUNT_TOKEN, for a session whose project and order (`secrets`) have none: the
 * project's or order's own always wins. Nothing without a person, or when the node holds no token of theirs. */
export function fallback(home: string, person: string | undefined, secrets: Vars): Vars {
  if (!person || secrets.some(([name]) => name === TOKEN_ENV)) return [];
  const token = readToken(home, person);
  return token === undefined ? [] : [[TOKEN_ENV, token]];
}

export const installDir = (home: string) => join(home, "browser", "onepassword");

let installing: Promise<unknown> = Promise.resolve();

/** The pinned SDK and the helper beside it; installed on first use. One install at a time. */
export function install(home: string): Promise<string> {
  const next = installing.catch(() => {}).then(() => installNow(home));
  installing = next;
  return next;
}

async function installNow(home: string): Promise<string> {
  const dir = installDir(home);
  const helper = join(dir, "resolve.mjs");
  let have = false;
  try {
    have = JSON.parse(readFileSync(join(dir, "node_modules/@1password/sdk/package.json"), "utf8")).version === SDK_VERSION;
  } catch {}
  if (!have) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      throw new Error(`cannot make ${dir}: ${(error as Error).message}`);
    }
    let failed: string | undefined;
    try {
      const npm = Bun.spawn(["npm", "install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", dir, `@1password/sdk@${SDK_VERSION}`], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      });
      const timer = setTimeout(() => npm.kill("SIGKILL"), INSTALL_TIMEOUT_MS);
      const code = await npm.exited;
      clearTimeout(timer);
      if (npm.signalCode) failed = `installing the 1Password SDK took over ${INSTALL_TIMEOUT_MS / 1000} s`;
      else if (code !== 0) failed = "installing the 1Password SDK failed";
    } catch (error) {
      failed = `cannot run npm (Node.js) to install the 1Password SDK: ${(error as Error).message}`;
    }
    if (failed) {
      // Half an install is none: the next use starts again.
      rmSync(join(dir, "node_modules"), { recursive: true, force: true });
      throw new Error(failed);
    }
  }
  try {
    writeFileSync(helper, HELPER);
  } catch (error) {
    throw new Error(`cannot write ${helper}: ${(error as Error).message}`);
  }
  return helper;
}

/** The SDK helper with one token: a process started on the first question, asked one line at a time. */
export class OnePassword {
  #proc: Bun.Subprocess<"pipe", "pipe", "ignore"> | undefined;
  #lines: AsyncIterator<string> | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    readonly home: string,
    readonly token: string,
  ) {}

  async #start(): Promise<void> {
    const helper = await install(this.home);
    const env = { ...process.env } as Record<string, string>;
    delete env[TOKEN_ENV];
    try {
      this.#proc = Bun.spawn(["node", helper], { cwd: installDir(this.home), env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    } catch (error) {
      throw new Error(`cannot start Node.js for the 1Password SDK: ${(error as Error).message}`);
    }
    this.#proc.stdin.write(`${JSON.stringify({ token: this.token })}\n`);
    this.#proc.stdin.flush();
    this.#lines = lines(this.#proc.stdout);
  }

  /** One line to the helper and its answer, parsed; its error thrown as `1Password: …`. */
  exchange(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    const next = this.#queue.catch(() => {}).then(() => this.#exchange(request));
    this.#queue = next;
    return next;
  }

  async #exchange(request: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!this.#proc) await this.#start();
    try {
      this.#proc!.stdin.write(`${JSON.stringify(request)}\n`);
      this.#proc!.stdin.flush();
    } catch {
      this.#proc = undefined;
      throw new Error("the 1Password helper stopped");
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answer = await Promise.race([
      this.#lines!.next().then((r) => (r.done ? undefined : r.value)),
      new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), RESOLVE_TIMEOUT_MS))),
    ]);
    clearTimeout(timer);
    if (answer === undefined) {
      this.close();
      throw new Error("1Password did not answer in 30 s");
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(answer) as Record<string, unknown>;
    } catch {
      throw new Error("the 1Password helper said nothing readable");
    }
    if (typeof parsed.error === "string") throw new Error(`1Password: ${parsed.error}`);
    return parsed;
  }

  /** The names of the vaults the token reads: a token's Test. */
  async vaultNames(): Promise<string[]> {
    const parsed = await this.exchange({ vaults: true });
    return (Array.isArray(parsed.vaults) ? parsed.vaults : []).filter((v): v is string => typeof v === "string");
  }

  /** The Credit Card items the token reads: a Navi's card picker. */
  async cards(): Promise<OnePasswordCard[]> {
    const parsed = await this.exchange({ cards: true });
    return (Array.isArray(parsed.cards) ? parsed.cards : []).filter(
      (c): c is OnePasswordCard => !!c && typeof c.ref === "string" && typeof c.title === "string" && typeof c.vault === "string",
    );
  }

  close(): void {
    try {
      this.#proc?.kill("SIGKILL");
    } catch {}
    this.#proc = undefined;
  }
}

/** A byte stream's lines, without their line ends. */
async function* lines(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      yield buffer.slice(0, at).replace(/\r$/, "");
      buffer = buffer.slice(at + 1);
    }
  }
  if (buffer) yield buffer;
}

