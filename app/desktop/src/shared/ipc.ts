// Runtime validation of every renderer → main request. The renderer is treated as untrusted: main parses each
// argument list here before any handler runs, and refuses anything else.
import { z } from "zod";
import { NotifyRequest } from "./app";
import { MenuState } from "./menu";
import { IPC, type InvokeChannel } from "./channels";

/** MCP tool names: lowercase words joined by underscores. */
const toolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);

export const CallRequest = z.strictObject({
  tool: toolName,
  input: z.json(),
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
  [IPC.copy]: z.tuple([z.string().max(1_000_000)]),
  [IPC.appReady]: none,
  [IPC.appNotify]: z.tuple([NotifyRequest]),
  [IPC.appMenuState]: z.tuple([MenuState]),
} as const satisfies Record<InvokeChannel, z.ZodType>;

export type RequestArgs<C extends InvokeChannel> = z.infer<(typeof REQUESTS)[C]>;

export type Parsed<C extends InvokeChannel> = { ok: true; args: RequestArgs<C> } | { ok: false; reason: string };

export const parseRequest = <C extends InvokeChannel>(channel: C, args: ReadonlyArray<unknown>): Parsed<C> => {
  const result = REQUESTS[channel].safeParse(args);
  return result.success
    ? { ok: true, args: result.data as RequestArgs<C> }
    : { ok: false, reason: z.prettifyError(result.error) };
};
