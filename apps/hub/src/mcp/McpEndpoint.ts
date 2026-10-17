import { McpTools, type AgentKeyInfo, type McpToolError, type McpToolName } from "@fleetd/contracts";
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

const DESCRIPTIONS: { readonly [N in McpToolName]: string } = {
  fleetd_status:
    "Every machine (online/offline), the 50 most recently active projects, the latest failed/waiting/usage-limited events, and the events cursor. Start here.",
  projects_list: "Projects across machines, optionally filtered by machineId or a title/path query.",
  project_get:
    "One project's outcome in one call: its summary and up to 20 threads (newest activity first) with status, headline and latest message. Marked stale when the machine is offline.",
  thread_tail:
    "A thread's newest messages and actions, newest first (n defaults to 10, max 50; kinds filters to message or action), plus its summary.",
  actions_list: "A thread's commands, file changes and tool calls, newest first (limit defaults to 50); failedOnly keeps failures.",
  events_wait:
    "Wait for hub events after cursor instead of polling. Returns at once if any exist, otherwise long-polls up to timeoutSec (default and max 50). No cursor means from now. Filter by types and machineId.",
  thread_launch:
    "Start a new thread in a project with an explicit model and effort. runtimeMode defaults to full-access. Refused with machine_offline when the machine is offline.",
  thread_send: "Send a message to a thread, waking it if idle. Refused with machine_offline when the machine is offline.",
  thread_interrupt: "Interrupt a thread's running turn. Refused with machine_offline when the machine is offline.",
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
  for (const name of Object.keys(McpTools) as Array<McpToolName>) {
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
