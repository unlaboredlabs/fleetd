// Runtime validation of every renderer → main request. The renderer is treated as untrusted: main parses each
// argument list here before any handler runs, and refuses anything else.
import { z } from "zod";
import { LinkHandlerClaim, NotifyRequest } from "./app";
import { HUB_CACHE_MAX_BYTES } from "./cache";
import { SECRET_MAX_BYTES } from "./contracts";
import { MENU_COMMANDS } from "./menu";
import { IPC, type InvokeChannel } from "./channels";

/** A call's input as JSON, at most; the hub has no use for more, and main shouldn't buffer it. */
export const MAX_CALL_INPUT_BYTES = 1024 * 1024;
export const MAX_CALL_INPUT_DEPTH = 64;
export const MAX_CALL_INPUT_NODES = 10_000;

const encoder = new TextEncoder();
/** Bytes of `text` as a JSON string literal (quotes and escapes included). */
const jsonStringBytes = (text: string): number => encoder.encode(JSON.stringify(text)).length;

/**
 * Plain JSON within the size, nesting and node caps, checked in one bounded pass: at most MAX_CALL_INPUT_NODES values
 * are visited and the encoded size is summed as they are, so nothing is serialized before it's known to be small.
 * Iterative, so deep nesting can't overflow the stack. IPC keeps shared references, which JSON can't express and
 * which make a naive walk exponential (`x = [x, x]` sixty times over is a few hundred bytes), so an object or array
 * met twice (shared or cyclic) is refused.
 */
export const isBoundedJson = (value: unknown): boolean => {
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;
  const stack: Array<[unknown, number]> = [[value, 1]];
  for (let next = stack.pop(); next !== undefined; next = stack.pop()) {
    const [item, depth] = next;
    if (++nodes > MAX_CALL_INPUT_NODES) return false;
    if (item === null) bytes += 4;
    else if (typeof item === "boolean") bytes += item ? 4 : 5;
    else if (typeof item === "number") {
      if (!Number.isFinite(item)) return false;
      bytes += String(item).length;
    } else if (typeof item === "string") bytes += jsonStringBytes(item);
    else if (typeof item !== "object" || depth > MAX_CALL_INPUT_DEPTH || seen.has(item)) return false;
    else {
      seen.add(item);
      if (Array.isArray(item)) {
        // Brackets and the commas between items.
        bytes += 2 + Math.max(item.length - 1, 0);
        // Checked before pushing, so one huge array can't flood the stack.
        if (nodes + item.length > MAX_CALL_INPUT_NODES) return false;
        for (const child of item) stack.push([child, depth + 1]);
      } else {
        const proto: unknown = Object.getPrototypeOf(item);
        if (proto !== Object.prototype && proto !== null) return false;
        const entries = Object.entries(item);
        if (nodes + entries.length > MAX_CALL_INPUT_NODES) return false;
        // Braces, commas, and a colon per key.
        bytes += 2 + Math.max(entries.length - 1, 0);
        for (const [key, child] of entries) {
          bytes += jsonStringBytes(key) + 1;
          stack.push([child, depth + 1]);
        }
      }
    }
    if (bytes > MAX_CALL_INPUT_BYTES) return false;
  }
  return true;
};

/** MCP tool names: lowercase words joined by underscores. */
const toolName = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/u);

export const CallRequest = z.strictObject({
  tool: toolName,
  input: z.custom<z.core.util.JSONType>(isBoundedJson, {
    message: `Input must be plain JSON, at most ${MAX_CALL_INPUT_BYTES} bytes and ${MAX_CALL_INPUT_DEPTH} levels deep.`,
  }),
  /** Defaults to 30 s. Long-polls such as events_wait pass their own. */
  timeoutMs: z.int().min(100).max(300_000).optional(),
});
export type CallRequest = z.infer<typeof CallRequest>;

/** The chat on screen, for its streamed text. */
export const ChatScope = z.strictObject({
  machineId: z.string().min(1).max(200),
  projectId: z.string().min(1).max(200),
});
export type ChatScope = z.infer<typeof ChatScope>;

/** The order whose lanes stream their text (a WorkstreamId). */
export const OrderFocus = z.string().min(1).max(64);
export type OrderFocus = z.infer<typeof OrderFocus>;

export const ConnectRequest = z.strictObject({
  url: z.string().trim().min(1).max(2048),
  key: z.string().trim().min(1).max(4096),
});
export type ConnectRequest = z.infer<typeof ConnectRequest>;

/** A secret ask's value and the box key of the machine it goes to; main seals it (main/secret.ts). */
export const SecretRequest = z.strictObject({
  /** The secret request item's requestId (ChatRequestId), "Q<n>". */
  requestId: z.string().regex(/^Q[1-9][0-9]*$/u),
  boxPubKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/u),
  // SECRET_MAX_BYTES UTF-8 bytes at most; main checks the byte length, this only bounds the string (a UTF-16 unit is
  // at least one byte, so no value that fits is cut here).
  value: z.string().min(1).max(SECRET_MAX_BYTES),
});
export type SecretRequest = z.infer<typeof SecretRequest>;

/** project_settings.rs EnvVarName. */
const EnvName = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u);
/**
 * A project's environment changes (Settings › Projects): plain values as typed, secret values for main to seal to
 * `boxPubKey`, the project machine's key (main/secret.ts). The hub gets the boxes, never a secret's value.
 */
export const ProjectEnvRequest = z.strictObject({
  machineId: z.string().min(1).max(64),
  projectId: z.string().min(1).max(200),
  /** Required when `set` holds a secret. */
  boxPubKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/u).optional(),
  set: z
    .array(
      z.discriminatedUnion("kind", [
        z.strictObject({ kind: z.literal("plain"), name: EnvName, value: z.string().max(8192) }),
        // One line; main checks the byte length.
        z.strictObject({ kind: z.literal("secret"), name: EnvName, value: z.string().min(1).max(8192) }),
      ]),
    )
    .max(100),
  remove: z.array(EnvName).max(100),
});
export type ProjectEnvRequest = z.infer<typeof ProjectEnvRequest>;
/** An error the page caught, for the app log: what failed, the error's own text and the route. Main scrubs it. */
export const ErrorReport = z.strictObject({
  /** The part whose card is up ("the conversation"), or "uncaught error" / "unhandled rejection". */
  what: z.string().min(1).max(200),
  name: z.string().max(200).optional(),
  message: z.string().max(4000),
  stack: z.string().max(20_000).optional(),
  route: z.string().max(4096),
});
export type ErrorReport = z.infer<typeof ErrorReport>;

/** An absolute path the renderer got from a drop (webUtils.getPathForFile). */
export const DropPath = z.string().min(2).max(4096).refine((p) => p.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(p), "an absolute path");

// Defined here rather than beside their types (shared/pairing.ts, shared/menu.ts), which the renderer imports: zod
// stays in main's bundle and out of the renderer's startup.
const PairRequest = z.strictObject({
  hub: z.string().trim().min(1).max(2048),
  code: z.string().trim().min(1).max(64),
});
const ProbeRequest = z.string().trim().min(1).max(2048);
/** The enabled commands; any menu command left out is disabled. */
const MenuState = z.array(z.enum(MENU_COMMANDS)).max(MENU_COMMANDS.length);

const none = z.tuple([]);

/** The argument list each invoke channel accepts. */
export const REQUESTS = {
  [IPC.hubSubscribe]: none,
  [IPC.hubUnsubscribe]: none,
  [IPC.hubCall]: z.tuple([CallRequest]),
  [IPC.hubChat]: z.tuple([ChatScope.nullable()]),
  [IPC.hubFocus]: z.tuple([OrderFocus.nullable()]),
  [IPC.hubResync]: none,
  [IPC.hubRetryNow]: none,
  [IPC.hubCacheRead]: none,
  // A string's UTF-16 length never exceeds its UTF-8 size, so this is a loose bound; main checks the bytes and the
  // envelope (main/hub/cache.ts).
  [IPC.hubCacheWrite]: z.tuple([z.string().max(HUB_CACHE_MAX_BYTES)]),
  [IPC.hubConnect]: z.tuple([ConnectRequest]),
  [IPC.hubForget]: none,
  [IPC.pairStart]: none,
  [IPC.pairProbe]: z.tuple([ProbeRequest]),
  [IPC.pairRedeem]: z.tuple([PairRequest]),
  [IPC.pairAuto]: none,
  [IPC.pairStore]: none,
  [IPC.pairSetup]: none,
  [IPC.secretSubmit]: z.tuple([SecretRequest]),
  [IPC.projectEnvSubmit]: z.tuple([ProjectEnvRequest]),
  [IPC.systemHostName]: none,
  [IPC.projectsPickFolder]: none,
  [IPC.projectsReadDrop]: z.tuple([DropPath]),
  [IPC.copy]: z.tuple([z.string().max(1_000_000)]),
  [IPC.appReady]: none,
  [IPC.appNotify]: z.tuple([NotifyRequest]),
  [IPC.appBadge]: z.tuple([z.number().int().min(0).max(9999)]),
  [IPC.appTheme]: z.tuple([z.enum(["system", "light", "dark"])]),
  [IPC.appMenuState]: z.tuple([MenuState]),
  [IPC.appLinkHandler]: z.tuple([LinkHandlerClaim.nullable()]),
  [IPC.appPresence]: z.tuple([z.boolean().nullable()]),
  [IPC.appLog]: z.tuple([ErrorReport]),
  [IPC.updatesState]: none,
  [IPC.updatesCheck]: none,
  [IPC.updatesInstall]: none,
  [IPC.updatesKeep]: none,
  [IPC.updatesHubTerminal]: none,
  // The URL rules live in main (main/external.ts), which answers with the reason; this only bounds the size.
  [IPC.openExternal]: z.tuple([z.string().max(8192)]),
} as const satisfies Record<InvokeChannel, z.ZodType>;

export type RequestArgs<C extends InvokeChannel> = z.infer<(typeof REQUESTS)[C]>;

export type Parsed<C extends InvokeChannel> = { ok: true; args: RequestArgs<C> } | { ok: false; reason: string };

export const parseRequest = <C extends InvokeChannel>(channel: C, args: ReadonlyArray<unknown>): Parsed<C> => {
  const result = REQUESTS[channel].safeParse(args);
  return result.success
    ? { ok: true, args: result.data as RequestArgs<C> }
    : { ok: false, reason: z.prettifyError(result.error) };
};
