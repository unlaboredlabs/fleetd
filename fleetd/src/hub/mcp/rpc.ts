// /mcp's JSON-RPC as the wire has it, with no registry or hub behind it (endpoint.ts answers the requests): the
// protocols and headers, `initialize`'s instructions, sorted JSON, a tool's input schema, the error and result
// shapes.
import { ToolError } from "../../shared/errors.ts";

/** Why a call didn't run its tool: no such tool, input that didn't decode, or the tool's own refusal. */
export type CallError = { kind: "unknown" } | { kind: "invalid"; message: string } | { kind: "tool"; error: ToolError };

/** Newest first; the first is answered to a client asking for one the hub doesn't speak. */
export const PROTOCOLS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;
export const SESSION_HEADER = "mcp-session-id";
export const PROTOCOL_HEADER = "mcp-protocol-version";

/**
 * `initialize`'s `instructions`: Claude Code puts them in the session's system prompt, so a person's own sessions
 * check the work ledger before they build something an agent or another session already is.
 */
export const INSTRUCTIONS =
  "fleetd runs agents on this person's repositories and keeps a ledger of the work in flight on each one. Before you " +
  "start a code change in a git repository, call work_claim with a one-line title of the change, the repo's origin " +
  "remote (`git remote get-url origin`), its branch, and the paths and issue keys you know. If the answer is taken or " +
  "possible_duplicate, tell the user what holds it before going on. If it is yours, you are fleetd's own agent on its " +
  "task's branch: the task already holds the work, so go on. Call work_done when the change lands or you drop it. " +
  "work_list shows what is in flight on a repo.";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

/** JSON with every object's keys sorted, as serde_json (no preserve_order) writes a Value. */
export function sortedJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return v;
    const sorted: Record<string, unknown> = {};
    for (const k of Object.keys(v).sort()) sorted[k] = (v as Record<string, unknown>)[k];
    return sorted;
  });
}

/**
 * A tool's input schema for tools/list. MCP requires an object root, so a non-object input becomes the empty object
 * schema, and the definitions it references (transitively) go to `$defs`.
 */
export function inputSchema(doc: JsonObject, name: string): JsonObject {
  const defs = (doc.$defs ?? {}) as JsonObject;
  const tools = (defs.McpTools as JsonObject | undefined)?.properties as JsonObject | undefined;
  let input = (tools?.[`${name}.input`] ?? null) as Json;
  // schemars names input structs where Effect inlines them: look through a bare root `$ref`.
  for (;;) {
    const ref = isObject(input) && typeof input.$ref === "string" ? input.$ref : undefined;
    if (!ref?.startsWith("#/$defs/")) break;
    input = (defs[ref.slice("#/$defs/".length)] ?? null) as Json;
  }
  const root: JsonObject =
    isObject(input) && input.type === "object" ? structuredClone(input) : { type: "object", properties: {} };
  const used = new Map<string, Json>();
  const pending: string[] = [];
  collectRefs(root, pending);
  for (let def = pending.pop(); def !== undefined; def = pending.pop()) {
    if (used.has(def)) continue;
    const schema = structuredClone(defs[def] ?? null);
    collectRefs(schema, pending);
    used.set(def, schema);
  }
  if (used.size > 0) root.$defs = Object.fromEntries([...used].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  return root;
}

export const isObject = (v: Json | undefined): v is JsonObject => v !== null && typeof v === "object" && !Array.isArray(v);

function collectRefs(schema: Json, out: string[]): void {
  if (Array.isArray(schema)) {
    for (const item of schema) collectRefs(item, out);
  } else if (isObject(schema)) {
    for (const [key, value] of Object.entries(schema)) {
      if (key === "$ref" && typeof value === "string") {
        if (value.startsWith("#/$defs/")) out.push(value.slice("#/$defs/".length));
      } else {
        collectRefs(value, out);
      }
    }
  }
}

/** UTF-16 units, as the Rust hub's `clip` counts them, never splitting a surrogate pair. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const code = text.charCodeAt(max - 1);
  return text.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

/** The `invalid` result for input that failed to decode; `fix` differs between /mcp and /app. */
export const invalidInput = (tool: string, detail: string, fix: string) =>
  new ToolError("invalid", clip(`Invalid ${tool} input: ${detail}`, 1000), fix);

export const rpcError = (id: Json, code: number, message: string, tag?: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(tag === undefined ? {} : { _tag: tag }) },
});

export const jsonResponse = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(sortedJson(body), { status, headers: { "content-type": "application/json", ...headers } });

export const empty = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

/** Some clients show only the text and others only structuredContent, so both carry the result (or the error). */
export function callResult(name: string, outcome: { output: unknown } | { error: CallError }): JsonObject {
  let value: unknown;
  let isError = false;
  if ("output" in outcome) {
    value = outcome.output ?? null;
  } else {
    isError = true;
    const error = outcome.error;
    value =
      error.kind === "tool"
        ? error.error.toJSON()
        : invalidInput(name, error.kind === "invalid" ? error.message : "", "Check the arguments against the tool's input schema.").toJSON();
  }
  return {
    content: [{ type: "text", text: sortedJson(value) }],
    structuredContent: value as Json,
    isError,
  };
}

