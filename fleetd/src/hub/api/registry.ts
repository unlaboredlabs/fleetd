// MCP tool name → handler, built once; /mcp and /app's `call` both call through it.
// Every tool in the contracts' table starts as a stub that throws
// NotImplemented naming its module; that module's `register` (src/hub/serve/areas.ts lists them) replaces it. A tool
// only fleetd's cloud serves (tool_roles.ts CLOUD) gets none: here it is no tool.
import type { AgentKeyInfo, ToolMap } from "../../shared/contracts.ts";
import { internalError, NotImplemented, ToolError } from "../../shared/errors.ts";
import { CLOUD, TOOLS, type ToolName } from "./tool_roles.ts";
import { DecodeError, decodeInput } from "./decode.ts";
import { isHuman, requireRole } from "./grants.ts";
import type { Hub } from "./hub.ts";
import type { CallError } from "../mcp/rpc.ts";

/** The verified key behind a request, checked again on every MCP request and app `call`. */
export type Caller = AgentKeyInfo;

export type Handler<N extends ToolName> = (
  hub: Hub,
  caller: Caller,
  input: ToolMap[N]["input"],
) => Promise<ToolMap[N]["output"]> | ToolMap[N]["output"];

/** Why a call produced no output. The transports word `unknown` and `invalid` themselves (MCP and /app differ). */
export type { CallError };

/**
 * Sees each call before its handler runs (after its input decoded), and may return what to do once it has ended: its
 * output, or the ToolError it was refused with. The audit log's (hub/audit/record.ts). A throw is logged, never the call's.
 */
export type CallObserver = (
  hub: Hub,
  caller: Caller,
  tool: ToolName,
  input: unknown,
) => ((ended: { output: unknown } | { error: ToolError }) => void) | undefined;

/** Tools a release took out, by name prefix, with what an older app that still calls one is told. */
const REMOVED: [prefix: string, gone: string][] = [
  ["telegram_", "Telegram was removed from fleetd."],
  ["revyl_", "Revyl was removed from fleetd."],
];

export class Registry {
  private readonly tools = new Map<string, Handler<ToolName>>();
  /** Tools whose handler takes the input as sent and decodes it itself (`addRaw`). */
  private readonly raw = new Set<string>();
  private readonly observers: CallObserver[] = [];

  constructor() {
    for (const [name, tool] of Object.entries(TOOLS)) {
      // A tool only fleetd's cloud serves isn't this hub's at all: a call of it is one of no such tool.
      if (CLOUD.has(name as ToolName)) continue;
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

  /** Adds an observer of every call (CallObserver). */
  observe(observer: CallObserver): void {
    this.observers.push(observer);
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
    const ends = this.observers.map((observe) => {
      try {
        return observe(hub, caller, tool as ToolName, decoded);
      } catch (error) {
        console.warn(`call observer failed: ${tool}:`, error);
        return undefined;
      }
    });
    const ended = (end: { output: unknown } | { error: ToolError }) => {
      for (const fn of ends) {
        try {
          fn?.(end);
        } catch (error) {
          console.warn(`call observer failed: ${tool}:`, error);
        }
      }
    };
    try {
      requireRole(caller, scope);
      const output = await handler(hub, caller, decoded as never);
      ended({ output });
      return { output };
    } catch (error) {
      if (error instanceof ToolError) {
        ended({ error });
        return { error: { kind: "tool", error: isHuman(caller) ? error.forPerson() : error } };
      }
      if (error instanceof NotImplemented) {
        return { error: { kind: "tool", error: new ToolError("failed", error.message, "Use the Rust workspace for this tool for now.") } };
      }
      console.error(`tool call failed: ${tool}:`, error);
      return { error: { kind: "tool", error: internalError() } };
    }
  }
}
