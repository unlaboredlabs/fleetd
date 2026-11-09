// MCP tool name → handler, built once; /mcp and /app's `call` both call through it.
// Every tool in the contracts' table starts as a stub that throws
// NotImplemented naming its module; that module's `register` (src/hub/serve/areas.ts lists them) replaces it.
import type { AgentKeyInfo, ToolMap } from "../../shared/contracts.ts";
import { internalError, NotImplemented, ToolError } from "../../shared/errors.ts";
import { TOOLS, type ToolName } from "./tool_roles.ts";
import { guard } from "../navi/owner.ts";
import { DecodeError, decodeInput } from "./decode.ts";
import { isHuman, requireRole } from "./grants.ts";
import type { Hub } from "./hub.ts";

/** The verified key behind a request, checked again on every MCP request and app `call`. */
export type Caller = AgentKeyInfo;

export type Handler<N extends ToolName> = (
  hub: Hub,
  caller: Caller,
  input: ToolMap[N]["input"],
) => Promise<ToolMap[N]["output"]> | ToolMap[N]["output"];

/** Why a call produced no output. The transports word `unknown` and `invalid` themselves (MCP and /app differ). */
export type CallError = { kind: "unknown" } | { kind: "invalid"; message: string } | { kind: "tool"; error: ToolError };

/** Tools a release took out, by name prefix, with what an older app that still calls one is told. */
const REMOVED: [prefix: string, gone: string][] = [["telegram_", "Telegram was removed from fleetd."]];

export class Registry {
  private readonly tools = new Map<string, Handler<ToolName>>();
  /** Tools whose handler takes the input as sent and decodes it itself (`addRaw`). */
  private readonly raw = new Set<string>();

  constructor() {
    for (const [name, tool] of Object.entries(TOOLS)) {
      this.tools.set(name, () => {
        throw new NotImplemented(`${tool.module} (tool ${name})`);
      });
    }
  }

  /**
   * Registers `name`'s handler, replacing the stub. Its input arrives decoded against the tool's contract
   * (src/hub/api/decode.ts): types, bounds and patterns checked, defaults filled, unnamed fields dropped. A brand's
   * own check beyond its pattern and a struct's `checked!` rules aren't in the schema: the handler checks those.
   */
  add<N extends ToolName>(name: N, handler: Handler<N>): void {
    this.tools.set(name, handler as unknown as Handler<ToolName>);
    this.raw.delete(name);
  }

  /** As `add`, for a handler that takes the input as sent (`{}` when absent) and decodes it itself. */
  addRaw<N extends ToolName>(name: N, handler: (hub: Hub, caller: Caller, input: unknown) => ReturnType<Handler<N>>): void {
    this.tools.set(name, handler as unknown as Handler<ToolName>);
    this.raw.add(name);
  }

  has(name: string): name is ToolName {
    return this.tools.has(name);
  }

  names(): ToolName[] {
    return [...this.tools.keys()] as ToolName[];
  }

  /**
   * Runs one call for an already verified caller: the input must decode against the tool's contract (else `invalid`
   * with serde's detail), the key must hold the tool's role from the contracts table, then the handler runs. A thrown ToolError is the call's error (a person's device gets its person-facing fix); any
   * other throw is logged and answered with the generic `failed`.
   */
  async call(hub: Hub, caller: Caller, tool: string, input: unknown): Promise<{ output: unknown } | { error: CallError }> {
    const handler = this.tools.get(tool);
    if (!handler || !(tool in TOOLS)) {
      const removed = REMOVED.find(([prefix]) => tool.startsWith(prefix));
      if (!removed) return { error: { kind: "unknown" } };
      return { error: { kind: "tool", error: new ToolError("not_found", removed[1], "Update the fleetd app: newer ones no longer offer it.") } };
    }
    const scope = TOOLS[tool as ToolName].scope;
    let decoded: unknown = input ?? {};
    if (!this.raw.has(tool)) {
      try {
        decoded = decodeInput(tool, decoded);
      } catch (error) {
        if (error instanceof DecodeError) return { error: { kind: "invalid", message: error.message } };
        throw error;
      }
    }
    try {
      requireRole(caller, scope);
      // The Navi owner's gate, after the role, on the call as sent: a call naming another person's Only me project is refused.
      guard(hub.db, caller, tool, input ?? {});
      return { output: await handler(hub, caller, decoded as never) };
    } catch (error) {
      if (error instanceof ToolError) return { error: { kind: "tool", error: isHuman(caller) ? error.forPerson() : error } };
      if (error instanceof NotImplemented) {
        return { error: { kind: "tool", error: new ToolError("failed", error.message, "Use the Rust hub for this tool for now.") } };
      }
      console.error(`tool call failed: ${tool}:`, error);
      return { error: { kind: "tool", error: internalError() } };
    }
  }
}
