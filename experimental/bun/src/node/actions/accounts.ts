// The Claude accounts sessions run on (crates/fleetd/src/node/claude_accounts.rs): the hub's API key and endpoint,
// and each person's subscription token, one file each in `<node home>/claude-accounts/<hub | person id>.json`, as the
// Rust node writes them. A secret is opened with the node's box key, files are written atomically at mode 0600 in
// 0700 directories, and errors name an account, never show a value.
//
// A session launched on an account reads it at each start of its claude (`envFor`): its variables replace every
// credential and gateway of the machine's own setup (ACCOUNT_CLEARS), and its value is masked in all the session's
// reports. One whose account is gone fails to start rather than fall back to the machine's login.
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ClaudeAccount } from "../../shared/contracts.ts";
import type { ApiModel, ClaudeSecretSet } from "../../shared/sessions.ts";
import { seal } from "../../shared/sealed_box.ts";
import { mkdirPrivate } from "../config.ts";
import type { NodeBoxKey } from "../identity.ts";
import { Masker } from "../mask.ts";
import { AUTO_MEMORY_OFF_ENV, AUTO_MEMORY_OFF_SETTINGS, FLEETD_ENV_SOURCE } from "../runner/claude.ts";
import type { Vars } from "../secrets/env.ts";
import { fingerprintOf, writeAtomic } from "../secrets/files.ts";
import type { Env } from "../util.ts";
import { hasControl, ioWhy, openB64, readIfThere, removeIfThere, utf8 } from "./refusal.ts";

const DIR = "claude-accounts";
/** A key or token is one line; anything longer is no credential. */
const VALUE_MAX = 4096;

export const OAUTH_TOKEN_ENV = "CLAUDE_CODE_OAUTH_TOKEN";
export const API_KEY_ENV = "ANTHROPIC_API_KEY";
export const BASE_URL_ENV = "ANTHROPIC_BASE_URL";
/** What a session on an account never keeps from the machine's own setup: another credential or gateway would
 * outrank or redirect the account's. */
export const ACCOUNT_CLEARS = [OAUTH_TOKEN_ENV, API_KEY_ENV, BASE_URL_ENV, "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX"];

type AccountFile = { value: string; endpoint?: string };

/** `hub`, or the person's id: how the hub and the node key an account's records. */
export const accountKey = (account: ClaudeAccount) => (account.kind === "hub" ? "hub" : account.personId);
const path = (home: string, account: ClaudeAccount) => join(home, DIR, `${accountKey(account)}.json`);
/** "the hub's API key", "p_abcdefgh's subscription": what errors name. */
const shown = (account: ClaudeAccount) => (account.kind === "hub" ? "the hub's API key" : `${account.personId}'s subscription`);
const accountVar = (account: ClaudeAccount) => (account.kind === "hub" ? API_KEY_ENV : OAUTH_TOKEN_ENV);

function read(home: string, account: ClaudeAccount): AccountFile | undefined {
  let bytes: Buffer | undefined;
  try {
    bytes = readIfThere(() => readFileSync(path(home, account)));
  } catch (error) {
    throw new Error(`cannot read ${shown(account)}: ${ioWhy(error)}`);
  }
  if (!bytes) return undefined;
  try {
    const file = JSON.parse(bytes.toString("utf8")) as AccountFile;
    if (typeof file.value !== "string") throw new Error();
    return file;
  } catch {
    throw new Error(`${shown(account)}'s file does not parse`);
  } finally {
    bytes.fill(0);
  }
}

/** Saves the account's secret (a new value, or a new endpoint for the one held), or forgets it with no `set`. The
 * fingerprint of the value held afterwards; none once forgotten. */
export function applyAccount(home: string, account: ClaudeAccount, set: ClaudeSecretSet | undefined, boxKey: NodeBoxKey | undefined): string | undefined {
  const file = path(home, account);
  if (!set) {
    try {
      removeIfThere(() => rmSync(file));
    } catch (error) {
      throw new Error(`cannot remove ${shown(account)}: ${ioWhy(error)}`);
    }
    return undefined;
  }
  if (set.endpoint !== undefined && account.kind !== "hub") throw new Error("only the hub's API key takes an endpoint");
  let value: string;
  if (set.sealed === undefined) {
    const held = read(home, account);
    if (!held) throw new Error(`this machine holds no ${shown(account)}: seal it again`);
    value = held.value;
  } else {
    if (!boxKey) throw new Error("this node takes no secrets: it has no box key");
    const plain = openB64(boxKey, set.sealed);
    if (!plain) throw new Error(`${shown(account)} was not sealed to this machine's current box key: seal it to its boxPubKey again`);
    const text = utf8(plain);
    plain.fill(0);
    if (text === undefined) throw new Error(`${shown(account)} is not UTF-8 text`);
    value = text.trim();
    if (!value) throw new Error(`${shown(account)} is empty`);
    if (Buffer.byteLength(value) > VALUE_MAX || hasControl(value)) throw new Error(`${shown(account)} is not one line of at most 4 KiB`);
  }
  const saved: AccountFile = { value, ...(set.endpoint !== undefined ? { endpoint: set.endpoint } : {}) };
  try {
    mkdirPrivate(dirname(file));
  } catch (error) {
    throw new Error(`cannot make ${dirname(file)}: ${ioWhy(error)}`);
  }
  const bytes = Buffer.from(JSON.stringify(saved));
  try {
    writeAtomic(file, bytes);
  } catch (error) {
    throw new Error(`cannot write ${shown(account)}: ${ioWhy(error)}`);
  } finally {
    bytes.fill(0);
  }
  return fingerprintOf(value);
}

/** The account's secret sealed to another machine's box key `to` (standard base64 of 32 bytes), for a cloud machine
 * to take with nobody pasting it again; none when this node holds no such secret. */
export function resealAccount(home: string, account: ClaudeAccount, to: string): string | undefined {
  const file = read(home, account);
  if (!file) return undefined;
  const key = Buffer.from(to, "base64");
  if (key.length !== 32) throw new Error("the box key to seal to is not 32 bytes");
  const plain = Buffer.from(file.value);
  try {
    return Buffer.from(seal(key, plain)).toString("base64");
  } catch {
    throw new Error(`${shown(account)} could not be sealed`);
  } finally {
    plain.fill(0);
  }
}

/** The variables a claude on `account` gets, and its secret by the variable's name for masking. Throws when the node
 * doesn't hold the account: such a session must not start on the machine's own login instead. */
export function envFor(home: string, account: ClaudeAccount): { vars: Vars; secrets: Vars } {
  const file = read(home, account);
  if (!file) throw new Error(`this machine holds no ${shown(account)}: connect it again while the machine is online`);
  const name = accountVar(account);
  const vars: Vars = [[name, file.value]];
  if (account.kind === "hub" && file.endpoint !== undefined) vars.push([BASE_URL_ENV, file.endpoint]);
  return { vars, secrets: [[name, file.value]] };
}

/** The account's secret by its variable's name, for masking a session's reports: none once the node no longer holds
 * it. Throws only when its file can't be read. */
export function accountSecrets(home: string, account: ClaudeAccount): Vars {
  const file = read(home, account);
  return file ? [[accountVar(account), file.value]] : [];
}

/** The account to probe the runner on while the machine's own claude is logged out (claude_accounts.rs `held`): the
 * hub's API key, else a person's subscription (the first by id). What the hub sealed to this node is what its work
 * runs on: a cloud machine has no login of its own. */
export function held(home: string): ClaudeAccount | undefined {
  if (existsSync(path(home, { kind: "hub" }))) return { kind: "hub" };
  let names: string[];
  try {
    names = readdirSync(join(home, DIR));
  } catch {
    return undefined;
  }
  const personId = names
    .map((n) => n.replace(/\.json$/, ""))
    .filter((id) => /^p_[a-z2-7]{8}$/.test(id))
    .sort()[0];
  return personId === undefined ? undefined : { kind: "person", personId };
}

/** `env` with the account's variables in place of every credential and gateway the machine's own setup set. */
export function putOn(env: Env, accountVars: Vars): void {
  for (const k of ACCOUNT_CLEARS) delete env[k];
  for (const [k, v] of accountVars) env[k] = v;
}

/** The models the hub's API key offers: `GET /v1/models` at its endpoint, else at the Anthropic API. Throws why not,
 * with the key masked, when the node holds no key or the endpoint lists none (a gateway without the Models API). */
export async function hubModels(home: string): Promise<ApiModel[]> {
  const file = read(home, { kind: "hub" });
  if (!file) throw new Error("this machine holds no hub API key");
  const base = (file.endpoint ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const masker = new Masker([[API_KEY_ENV, file.value]]);
  let response: Response;
  try {
    response = await fetch(`${base}/v1/models?limit=1000`, {
      headers: { "x-api-key": file.value, "anthropic-version": "2023-06-01" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    throw new Error(masker.text(`the Models API at ${base} didn't answer: ${(error as Error).message}`));
  }
  if (!response.ok) throw new Error(`the Models API at ${base} answered ${response.status} ${response.statusText}`.trimEnd());
  let page: { data?: { id?: unknown; display_name?: unknown }[] };
  try {
    page = (await response.json()) as typeof page;
    if (!Array.isArray(page.data)) throw new Error("no data");
  } catch (error) {
    throw new Error(masker.text(`the Models API at ${base} sent no model list: ${(error as Error).message}`));
  }
  const models = page.data!.flatMap((m) =>
    typeof m.id === "string" ? [{ id: m.id, ...(typeof m.display_name === "string" ? { displayName: m.display_name } : {}) }] : [],
  );
  if (!models.length) throw new Error(`the Models API at ${base} listed no models`);
  return models;
}

const ENDPOINT_PROBE_MS = 5_000;

/** Why the hub's endpoint `base` doesn't answer at all, by its host; none when it answers anything, even an error
 * status. Sends no key: a Test says first whether the endpoint is there, before claude's own words about it. */
export async function endpointSilent(base: string): Promise<string | undefined> {
  let host = base;
  try {
    host = new URL(base).host || base;
  } catch {}
  try {
    const response = await fetch(base, { signal: AbortSignal.timeout(ENDPOINT_PROBE_MS), redirect: "manual" });
    await response.body?.cancel();
    return undefined;
  } catch (error) {
    const why = (error as Error).name === "TimeoutError" ? `no answer within ${ENDPOINT_PROBE_MS / 1000}s` : (error as Error).message;
    return `the endpoint ${host} doesn't answer (${why})`;
  }
}

/** `claude -p` for an account's Test (runner/claude/conformance.rs): one short answer on the smallest model in one
 * turn, no MCP servers, the user settings sessions read. */
const TRY_ARGS = [
  "-p",
  "Reply with the word OK and nothing else.",
  "--model",
  "haiku",
  "--max-turns",
  "1",
  "--output-format",
  "json",
  "--strict-mcp-config",
  "--setting-sources",
  "user",
  "--settings",
  AUTO_MEMORY_OFF_SETTINGS,
];
const TRY_TIMEOUT_MS = 90_000;

/** One tiny `claude -p` call with exactly `env`: proves the key or token in it works. Throws claude's own words when
 * it doesn't; the caller masks the secret in them. */
export async function tryAccount(binary: string, env: Env): Promise<void> {
  const clean: Env = {};
  for (const [k, v] of Object.entries(env)) if (k !== FLEETD_ENV_SOURCE) clean[k] = v;
  clean[AUTO_MEMORY_OFF_ENV[0]] = AUTO_MEMORY_OFF_ENV[1];
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn([binary, ...TRY_ARGS], { env: clean, cwd: tmpdir(), stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
  } catch (error) {
    throw new Error(`could not run claude: ${(error as Error).message}`);
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    try {
      process.kill(-proc.pid, "SIGKILL");
    } catch {}
  }, TRY_TIMEOUT_MS);
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  clearTimeout(timer);
  if (timedOut) throw new Error(`claude did not answer within ${TRY_TIMEOUT_MS / 1000}s`);
  tried(code === 0, stdout, stderr);
}

/** What a Test's `claude -p --output-format json` said: it worked when it exited 0 with a result that is no error. */
export function tried(exitedOk: boolean, stdout: string, stderr: string): void {
  let answer: { is_error?: unknown; result?: unknown } | undefined;
  try {
    answer = JSON.parse(stdout) as typeof answer;
  } catch {}
  const isError = typeof answer?.is_error === "boolean" ? answer.is_error : true;
  if (exitedOk && !isError) return;
  const result = typeof answer?.result === "string" && answer.result.trim() ? answer.result : undefined;
  const said = [...(result ?? (stderr || stdout).trim())].slice(0, 500).join("");
  throw new Error(said || "claude failed and said nothing");
}
