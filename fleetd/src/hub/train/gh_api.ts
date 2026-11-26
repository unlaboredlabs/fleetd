// `gh api` answered in the workspace's own process: the same request gh sends and the same stdout, stderr and exit
// code it prints, without starting gh. The train, the PR views and the GitHub App poll GitHub several times a second;
// a gh process each cost ~0.1 s of CPU, three quarters of a core on a busy workspace. What this doesn't read the way
// gh does (a flag it doesn't know, a typed field read from a file, another host) still runs gh.
import { readFileSync } from "node:fs";
import type { GhOut } from "./gh.ts";

/** One `gh api` call, its flags read. */
export type ApiCall = {
  method: string;
  path: string;
  headers: [string, string][];
  /** `-f`/`-F` fields in order: a string, or what `-F` turns "true", "false", "null" and integers into. */
  fields: [string, string | number | boolean | null][];
  /** `--input`'s file. */
  input?: string;
  include: boolean;
};

/**
 * `gh api <args>` as an {@link ApiCall}, or undefined for anything gh reads in a way this doesn't: those run gh.
 * gh's own defaults: GET, or POST once a field or `--input` is given; `graphql` is a POST of the query.
 */
export function parseApi(args: string[]): ApiCall | undefined {
  if (args[0] !== "api") return undefined;
  let method: string | undefined;
  let path: string | undefined;
  const headers: [string, string][] = [];
  const fields: ApiCall["fields"] = [];
  let input: string | undefined;
  let include = false;
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    const value = () => args[++i];
    if (arg === "-i" || arg === "--include") include = true;
    else if (arg === "--allow-escape-sequences") {
      // Only how gh prints an answer to a terminal; the text is the same.
    } else if (arg === "-X" || arg === "--method") {
      const m = value();
      if (m === undefined) return undefined;
      method = m.toUpperCase();
    } else if (arg === "-H" || arg === "--header") {
      const h = value();
      const colon = h?.indexOf(":") ?? -1;
      if (h === undefined || colon <= 0) return undefined;
      headers.push([h.slice(0, colon).trim(), h.slice(colon + 1).trim()]);
    } else if (arg === "-f" || arg === "--raw-field" || arg === "-F" || arg === "--field") {
      const f = value();
      const eq = f?.indexOf("=") ?? -1;
      if (f === undefined || eq <= 0) return undefined;
      const key = f.slice(0, eq);
      // gh builds nested objects and arrays from `a[b]` and `a[]` keys.
      if (key.includes("[")) return undefined;
      const raw = f.slice(eq + 1);
      if (arg === "-f" || arg === "--raw-field") fields.push([key, raw]);
      else {
        const typed = typedField(raw);
        if (typed === undefined) return undefined;
        fields.push([key, typed.value]);
      }
    } else if (arg === "--input") {
      const file = value();
      if (file === undefined || file === "-") return undefined;
      input = file;
    } else if (arg.startsWith("-") || path !== undefined) return undefined;
    else path = arg;
  }
  if (path === undefined || /[{}]/.test(path)) return undefined;
  const fallback = fields.length > 0 || input !== undefined || path === "graphql" ? "POST" : "GET";
  return { method: method ?? fallback, path, headers, fields, ...(input === undefined ? {} : { input }), include };
}

/** `-F`'s value: true, false, null and integers typed, else the string; undefined for gh's `@file` and placeholders. */
function typedField(raw: string): { value: string | number | boolean | null } | undefined {
  if (raw.startsWith("@") || /^\{(owner|repo|branch)\}$/.test(raw)) return undefined;
  if (raw === "true") return { value: true };
  if (raw === "false") return { value: false };
  if (raw === "null") return { value: null };
  // Go's strconv.Atoi: an optional sign, then digits, within 64 bits.
  if (/^[+-]?\d+$/.test(raw)) {
    const n = Number(raw);
    if (Number.isSafeInteger(n)) return { value: n };
    return undefined;
  }
  return { value: raw };
}

const API = "https://api.github.com/";
const TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 10;

/** The request gh would send for `call` as `token`: its URL, method, headers and body. */
export function requestOf(call: ApiCall, token: string, api = API): { url: string; init: RequestInit } {
  let path = call.path.startsWith("/") ? call.path.slice(1) : call.path;
  const params = Object.fromEntries(call.fields);
  let body: string | undefined;
  const isGraphql = path === "graphql";
  if (call.input !== undefined) {
    body = readFileSync(call.input, "utf8");
    path = withQuery(path, call.fields);
  } else if (call.method === "GET") {
    path = withQuery(path, call.fields);
  } else if (isGraphql) {
    const { query, operationName, ...variables } = params;
    const shaped: Record<string, unknown> = { query };
    if (operationName !== undefined) shaped.operationName = operationName;
    if (Object.keys(variables).length > 0) shaped.variables = variables;
    body = JSON.stringify(shaped);
  } else if (call.fields.length > 0) body = JSON.stringify(params);
  const headers = new Headers({
    Accept: "*/*",
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": "fleetd",
    "X-GitHub-Api-Version": "2022-11-28",
  });
  for (const [k, v] of call.headers) headers.set(k, v);
  headers.set("Authorization", `token ${token}`);
  const url = /^https?:\/\//.test(path) ? path : `${api}${path}`;
  return { url, init: { method: call.method, headers, ...(body === undefined ? {} : { body }) } };
}

/** gh's `addQuery`: the fields as a query string, sorted by key as Go's `url.Values` encodes them. */
function withQuery(path: string, fields: ApiCall["fields"]): string {
  if (fields.length === 0) return path;
  const q = new URLSearchParams();
  for (const [k, v] of [...fields].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) q.append(k, v === null ? "" : String(v));
  return `${path}${path.includes("?") ? "&" : "?"}${q.toString()}`;
}

/**
 * gh's server error for an answer (`parseErrorResponse`): `message (HTTP n)`, else the `errors`' messages, else
 * `HTTP n` for a non-2xx; empty for a good answer.
 */
export function serverError(status: number, body: string, graphql: boolean, json: boolean): string {
  let said = "";
  if (status > 299 || (graphql && json)) {
    try {
      const parsed = JSON.parse(body) as { message?: unknown; errors?: unknown };
      if (typeof parsed?.message === "string" && parsed.message !== "") said = `${parsed.message} (HTTP ${status})`;
      else if (Array.isArray(parsed?.errors)) {
        const messages = parsed.errors.flatMap((e: unknown) =>
          typeof e === "string" ? [e] : e && typeof e === "object" && typeof (e as { message?: unknown }).message === "string" ? [(e as { message: string }).message] : [],
        );
        said = messages.join("\n");
      }
    } catch {}
  }
  if (said === "" && status > 299) said = `HTTP ${status}`;
  return said;
}

/** gh's `-i` head: the status line, then each header (names as Go writes them, sorted), then a blank line. */
function head(res: Response): string {
  const names = [...res.headers.keys()].sort();
  const lines = names.map((n) => `${canonical(n)}: ${res.headers.get(n)}\r\n`);
  return `HTTP/2.0 ${res.status} ${res.statusText}\n${lines.join("")}\r\n`;
}

const canonical = (name: string) => name.replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => dash + c.toUpperCase());

/** Fetches `url`, following redirects as Go does: the token goes only to the host it was meant for. */
async function follow(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
  let at = url;
  let request = init;
  for (let hops = 0; ; hops++) {
    const res = await fetch(at, { ...request, redirect: "manual", signal });
    const location = res.headers.get("location");
    if (res.status < 300 || res.status > 399 || res.status === 304 || location === null || hops >= MAX_REDIRECTS) return res;
    await res.body?.cancel();
    const next = new URL(location, at);
    const headers = new Headers(request.headers);
    if (next.host !== new URL(at).host) headers.delete("Authorization");
    // 301, 302 and 303 turn a POST into a GET with no body, as Go's client does.
    const keep = res.status === 307 || res.status === 308;
    request = keep ? { ...request, headers } : { method: request.method === "HEAD" ? "HEAD" : "GET", headers };
    if (!keep) headers.delete("Content-Type");
    at = next.toString();
  }
}

/**
 * Runs `call` as `token` against `api` (GitHub's): what gh prints for it and its exit code (1 for a server error, as
 * gh). It throws a `TimeoutError` past `timeoutMs`, which a gh run that timed out is too.
 */
export async function runApi(call: ApiCall, token: string, api = API, timeoutMs = TIMEOUT_MS): Promise<GhOut> {
  const { url, init } = requestOf(call, token, api);
  const signal = AbortSignal.timeout(timeoutMs);
  let res: Response;
  let body: string;
  try {
    res = await follow(url, init, signal);
    // As gh prints it: a byte order mark at its start (job logs have one) stays.
    body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await res.arrayBuffer());
  } catch (error) {
    if ((error as Error)?.name === "TimeoutError") throw error;
    // gh's words when GitHub can't be reached.
    return { exitCode: 1, stdout: "", stderr: `error connecting to api.github.com: ${(error as Error)?.message ?? String(error)}\n` };
  }
  const json = /[/+]json(;|$)/i.test(res.headers.get("content-type") ?? "");
  const said = serverError(res.status, body, call.path.replace(/^\//, "") === "graphql", json);
  const stdout = (call.include ? head(res) : "") + body;
  return said === "" ? { exitCode: 0, stdout, stderr: "" } : { exitCode: 1, stdout, stderr: `gh: ${said}\n` };
}
