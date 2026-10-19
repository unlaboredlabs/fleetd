// Runtime validation of every renderer → main request. The renderer is treated as untrusted: main parses each
// argument list here before any handler runs, and refuses anything else.
import { z } from "zod";
import { IPC, type InvokeChannel } from "./channels";

/** A call's input as JSON, at most; the hub has no use for more, and main shouldn't buffer it. */
export const MAX_CALL_INPUT_BYTES = 1024 * 1024;
export const MAX_CALL_INPUT_DEPTH = 64;

/**
 * Plain JSON within the size and nesting caps. Walked without recursion, so a deeply nested input can't overflow the
 * stack before it's refused.
 */
export const isBoundedJson = (value: unknown): boolean => {
  const stack: Array<[unknown, number]> = [[value, 1]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [item, depth] = next;
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      continue;
    }
    if (typeof item !== "object" || depth > MAX_CALL_INPUT_DEPTH) return false;
    if (Array.isArray(item)) {
      for (const child of item) stack.push([child, depth + 1]);
      continue;
    }
    const proto: unknown = Object.getPrototypeOf(item);
    if (proto !== Object.prototype && proto !== null) return false;
    for (const child of Object.values(item)) stack.push([child, depth + 1]);
  }
  return new TextEncoder().encode(JSON.stringify(value)).length <= MAX_CALL_INPUT_BYTES;
};

/** MCP tool names: lowercase words joined by underscores. */
const toolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);

export const CallRequest = z.strictObject({
  tool: toolName,
  input: z.custom<z.core.util.JSONType>(isBoundedJson, {
    message: `Input must be plain JSON, at most ${MAX_CALL_INPUT_BYTES} bytes and ${MAX_CALL_INPUT_DEPTH} levels deep.`,
  }),
  /** Defaults to 30 s. Long-polls such as status_wait pass their own. */
  timeoutMs: z.int().min(100).max(300_000).optional(),
});
export type CallRequest = z.infer<typeof CallRequest>;

export const LiveScope = z.strictObject({
  board: z.boolean(),
  focus: z.string().min(1).max(64).optional(),
});
export type LiveScope = z.infer<typeof LiveScope>;

export const ConnectRequest = z.strictObject({
  url: z.string().trim().min(1).max(2048),
  key: z.string().trim().min(1).max(4096),
});
export type ConnectRequest = z.infer<typeof ConnectRequest>;

/** An absolute path the renderer got from a drop (webUtils.getPathForFile). */
export const DropPath = z.string().min(2).max(4096).refine((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(p), "an absolute path");

const none = z.tuple([]);

/** The argument list each invoke channel accepts. */
export const REQUESTS = {
  [IPC.hubState]: none,
  [IPC.hubSubscribe]: none,
  [IPC.hubUnsubscribe]: none,
  [IPC.hubCall]: z.tuple([CallRequest]),
  [IPC.hubLive]: z.tuple([LiveScope.nullable()]),
  [IPC.hubResync]: none,
  [IPC.hubConnect]: z.tuple([ConnectRequest]),
  [IPC.hubForget]: none,
  [IPC.systemHostName]: none,
  [IPC.projectsPickFolder]: none,
  [IPC.projectsReadDrop]: z.tuple([DropPath]),
  [IPC.copy]: z.tuple([z.string().max(1_000_000)]),
} as const satisfies Record<InvokeChannel, z.ZodType>;

export type RequestArgs<C extends InvokeChannel> = z.infer<(typeof REQUESTS)[C]>;

export type Parsed<C extends InvokeChannel> = { ok: true; args: RequestArgs<C> } | { ok: false; reason: string };

export const parseRequest = <C extends InvokeChannel>(channel: C, args: ReadonlyArray<unknown>): Parsed<C> => {
  const result = REQUESTS[channel].safeParse(args);
  return result.success
    ? { ok: true, args: result.data as RequestArgs<C> }
    : { ok: false, reason: z.prettifyError(result.error) };
};
