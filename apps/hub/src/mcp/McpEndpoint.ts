import { McpTools, type AgentKeyInfo, type McpToolError } from "@fleetd/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import pkg from "../../package.json" with { type: "json" };
import * as FleetApi from "../api/FleetApi.ts";
import * as Auth from "../auth/Auth.ts";

/** The verified agent key behind the current MCP request. */
export class Caller extends Context.Service<Caller, AgentKeyInfo>()("fleetd/hub/mcp/Caller") {}

const DESCRIPTIONS: { readonly [N in FleetApi.ImplementedTool]: string } = {
  fleetd_status:
    "Every machine (online/offline), the 50 most recently active projects, the latest failed/waiting/usage-limited events, the slot board (cap, used, queued, per-project shares) and the events cursor. Start here.",
  projects_list: "Projects across machines, optionally filtered by machineId or a title/path query.",
  project_get:
    "One project's outcome in one call: its summary, up to 20 threads (newest activity first) with status, headline and latest message, its lead and open workstreams, and task counts with the 20 newest tasks (task threads are not in the thread list). Marked stale when the machine is offline.",
  thread_tail:
    "A thread's newest messages and actions, newest first (n defaults to 10, max 50; kinds filters to message or action), plus its summary.",
  actions_list: "A thread's commands, file changes and tool calls, newest first (limit defaults to 50); failedOnly keeps failures.",
  events_wait:
    "Wait for hub events after cursor instead of polling. Returns at once if any exist, otherwise long-polls up to timeoutSec (default and max 50). No cursor means from now. Filter by types and machineId.",
  thread_launch:
    "Start a new thread in a project with an explicit model and effort. runtimeMode defaults to full-access. Refused with machine_offline when the machine is offline.",
  thread_send:
    "Send a message to a thread, waking it if idle. When the machine is offline the hub queues it (queued: true, queuedUntil; default 24 h) and delivers it in order when the machine is back: watch for write.delivered or write.expired.",
  thread_interrupt: "Interrupt a thread's running turn. Refused with machine_offline when the machine is offline.",
  subscription_set:
    "Push hub events to an http(s) URL as signed Standard Webhooks POSTs (body: the HubEvent JSON), in seq order, retried until a 2xx. Filter by types and machines (default all). Returns the signing secret once.",
  subscription_list: "This key's webhook subscriptions (all of them for an admin key) with their delivery cursor and failing state. Secrets are never returned.",
  subscription_delete: "Delete a webhook subscription; delivery stops at once.",
  wake_set:
    "Have the hub send a message to a thread later: at an ISO time (no offset means wall-clock time in tz), every N seconds (>= 60), or on a 5-field cron in an IANA tz. once defaults to true. A run missed while the hub was down fires once, marked late, unless catchUp is skip. Offline machines get it queued. Emits wake.fired.",
  wake_list: "Wakes, oldest first, optionally filtered by machineId, threadId and state (active, done, cancelled).",
  wake_cancel: "Cancel a wake so it never fires again. Cancelling a finished wake is a no-op.",
  lead_start:
    "Start the project's lead: one T3 thread that turns intents into briefs, asks only product/money/credential/irreversible questions, and never writes code. Returns the existing lead if there is one. model and effort, when given, are saved for the project (default claude-opus-5-5, high).",
  lead_restart:
    "Start a fresh lead thread for the project from the current digest (sessionGeneration goes up); use it when a lead is stuck or its context is full. The old thread stays in T3. Takes model and effort like lead_start.",
  intake_submit:
    "Give a project one intent in plain words (e.g. \"add a /health endpoint\"). Creates a draft workstream and wakes the lead, which registers a brief and moves it to running. Idempotent per clientRequestId.",
  workstream_list: "Workstreams newest first, filtered by machineId, projectId and state (limit defaults to 50).",
  workstream_get:
    "One workstream with its frozen brief and headline (the lead's own words), its open asks, the decisions scoped to it, its ETA (raw estimate × the tier's measured ratio) and its last 20 claims with each check's result. Only a claim whose checks all passed makes it done.",
  asks_list:
    "The questions waiting for the human, grouped in numbered batches (state defaults to open; batchId picks one batch). Item numbers are fixed per batch: answer them with inbox_reply.",
  inbox_reply:
    "Answer a batch tersely: \"1 go 2 nvm 3 b\", \"1-3 go\", \"recs fine\" (accept every recommendation), \"2: free text\", \"4 later\", \"pref: <standing preference>\", \"forget D12\". Binds to the latest open batch unless it starts with \"#B<n>\". Each answer becomes a Decision and wakes its lead. Unparseable text changes nothing and returns a hint.",
  decisions_search: "Full-text search over active decisions (key, value, why), best match first; scope narrows to global, a project or a workstream.",
  decisions_record:
    "Record a decision (key = lowercase dotted slug) at global, project or workstream scope; it supersedes the active one with the same key and scope, so leads never ask it again. A project's lead is woken with it. Global decisions need an operate grant on all machines.",
  digest_get:
    "The human digest now, as plain text: what needs you (numbered asks), what is running and done, and what leads decided without you. The same text goes out as digest.ready at 09:00 and 18:00 in policy.tz.",
  tasks_list:
    "Tasks (the subagent runs leads spawn with fleetd task spawn), newest first, optionally for one projectRef and state (queued, running, idle, done, failed, cancelled). Queued tasks say why; ended ones carry their result.",
  task_get: "One task: its model and effort, areas, branch, thread, queued reason or result (status, last 2000 characters of its final message, branch, PR).",
  cap_set:
    "Admin: set the global cap on running turns (1-1000) and/or one project's share of it (0-1000). Applies at once; queued tasks start as soon as they fit. Returns the slot board.",
  claims_list:
    "Claims (a lead's `fleetd claim done`), newest first: each done-when check fleetd ran itself, with pass/fail/error, evidence and exit codes. Filter by workstreamId, projectRef or outcome.",
  incidents_list:
    "Incidents the hub detected (false_claim, estimate_miss, polish_loop, out_of_area, …), newest first, with evidence lines. Filter by projectRef, workstreamId or class.",
};

/** MCP requires an object root, so the empty input becomes an empty object schema and refs go to $defs. */
export const inputJsonSchema = (schema: Schema.Top) => {
  const document = Schema.toJsonSchemaDocument(schema);
  const root = document.schema.type === "object" ? document.schema : { type: "object", properties: {} };
  return Object.keys(document.definitions).length === 0 ? root : { ...root, $defs: document.definitions };
};

const result = (value: object, isError: boolean) =>
  new McpSchema.CallToolResult({
    isError,
    // Some clients show only the text and others only structuredContent, so both carry it.
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value as Schema.Json,
  });

const errorResult = (error: McpToolError) =>
  result({ code: error.code, message: error.message, ...(error.fix === undefined ? {} : { fix: error.fix }) }, true);

const unauthorized = (error: McpToolError) =>
  HttpServerResponse.jsonUnsafe(
    { code: error.code, message: error.message, ...(error.fix === undefined ? {} : { fix: error.fix }) },
    { status: 401, headers: { "cache-control": "no-store", "www-authenticate": 'Bearer error="invalid_token"' } },
  );

const missingBearer: McpToolError = {
  code: "forbidden",
  message: "The MCP endpoint needs an agent key.",
  fix: "Send Authorization: Bearer fld_… (create one with fleetd hub key create).",
};

/** Every request carries its own bearer, so a revoked key stops working on its next call. */
const layerAuth = HttpRouter.middleware<{ provides: Caller }>()(
  Effect.gen(function* () {
    const auth = yield* Auth.Auth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const header = request.headers.authorization ?? "";
        const bearer = header.startsWith("Bearer ") ? header.slice("Bearer ".length).trim() : "";
        if (bearer.length === 0) return unauthorized(missingBearer);
        const verified = yield* Effect.result(auth.verify(bearer));
        if (verified._tag === "Failure") return unauthorized(verified.failure);
        return yield* Effect.provideService(httpEffect, Caller, verified.success);
      });
  }),
).layer;

const registerTools = Effect.gen(function* () {
  const server = yield* McpServer.McpServer;
  const api = yield* FleetApi.FleetApi;
  for (const name of FleetApi.IMPLEMENTED_TOOLS) {
    const tool = McpTools[name];
    const decode = Schema.decodeUnknownEffect(tool.input as Schema.Codec<FleetApi.ToolInput<typeof name>, unknown>);
    yield* server.addTool({
      tool: new McpSchema.Tool({
        name,
        description: DESCRIPTIONS[name],
        inputSchema: inputJsonSchema(tool.input) as McpSchema.Tool["inputSchema"],
        annotations: { readOnlyHint: tool.scope === "read", openWorldHint: false },
      }),
      annotations: Context.empty(),
      handle: (payload) =>
        Effect.gen(function* () {
          const caller = Context.getOption((yield* Effect.context<never>()), Caller);
          if (caller._tag === "None") return errorResult(missingBearer);
          const input = yield* Effect.result(decode(payload ?? {}));
          if (input._tag === "Failure") {
            return errorResult({
              code: "invalid",
              message: `Invalid ${name} input: ${input.failure.message}`.slice(0, 1000),
              fix: "Check the arguments against the tool's input schema.",
            });
          }
          return yield* api.call(caller.value, name, input.success).pipe(
            Effect.map((output) => result(output, false)),
            Effect.catchTags({ ToolError: (error) => Effect.succeed(errorResult(error)) }),
          );
        }),
    });
  }
});

export const layer = Layer.effectDiscard(registerTools).pipe(
  Layer.provideMerge(
    McpServer.layerHttp({
      name: "fleetd",
      version: pkg.version,
      path: "/mcp",
      protocols: [McpProtocol.v2025_11_25, McpProtocol.v2025_06_18, McpProtocol.v2025_03_26],
    }).pipe(Layer.provide(layerAuth)),
  ),
);
