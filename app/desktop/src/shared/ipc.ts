// Runtime validation of every renderer → main request. The renderer is treated as untrusted: main parses each
// argument list here before any handler runs, and refuses anything else.
import { z } from "zod";
import { LinkHandlerClaim, NotifyRequest } from "./app";
import { HUB_CACHE_MAX_BYTES } from "./cache";
import { HUB_COLORS, HUB_ID, LABEL_MAX } from "./hubs";
import { ENV_VALUE_MAX_BYTES, SECRET_MAX_BYTES } from "./contracts";
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

export const HubId = z.string().regex(HUB_ID);
const HubColor = z.enum(HUB_COLORS);
const HubLabel = z.string().min(1).max(LABEL_MAX * 4);
/** Where a pairing goes (shared/hubs.ts PairTarget): a hub already listed, or a new one under a label. */
const PairTarget = z.union([z.strictObject({ hub: HubId }), z.strictObject({ label: HubLabel, color: HubColor.optional() })]);

export const ConnectRequest = z.strictObject({
  url: z.string().trim().min(1).max(2048),
  key: z.string().trim().min(1).max(4096),
  target: PairTarget.optional(),
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
        // Any number of lines. ENV_VALUE_MAX_BYTES UTF-8 bytes at most: this only bounds the string; the hub and the
        // node check the bytes, and the project's total.
        z.strictObject({ kind: z.literal("plain"), name: EnvName, value: z.string().max(ENV_VALUE_MAX_BYTES) }),
        z.strictObject({ kind: z.literal("secret"), name: EnvName, value: z.string().min(1).max(ENV_VALUE_MAX_BYTES) }),
      ]),
    )
    .max(100),
  remove: z.array(EnvName).max(100),
});
export type ProjectEnvRequest = z.infer<typeof ProjectEnvRequest>;

/** mcp_servers.rs McpValueName: an HTTP token (an env name is also checked as a shell name by the hub). */
const McpValueName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/u);
const McpValueRequest = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("plain"), name: McpValueName, value: z.string().max(ENV_VALUE_MAX_BYTES) }),
  z.strictObject({ kind: z.literal("secret"), name: McpValueName, value: z.string().min(1).max(ENV_VALUE_MAX_BYTES) }),
  /** The secret saved under this name, as it is. */
  z.strictObject({ kind: z.literal("keep"), name: McpValueName }),
]);
/**
 * An MCP server to save (Settings › Hub › Every project, a project's MCP section): main seals each secret value to every box
 * key in `boxes` (a project server's machine; for a global one, every machine) and calls mcp_server_set. The hub gets
 * the boxes, never a secret's value.
 */
export const McpServerRequest = z.strictObject({
  scope: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("global") }),
    z.strictObject({ kind: z.literal("project"), machineId: z.string().min(1).max(64), projectId: z.string().min(1).max(200) }),
  ]),
  name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/u),
  enabled: z.boolean(),
  roles: z.strictObject({ lead: z.boolean(), writers: z.boolean(), reviewers: z.boolean() }),
  transport: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("stdio"), command: z.string().min(1).max(4096), args: z.array(z.string().max(4096)).max(100) }),
    z.strictObject({ type: z.literal("http"), url: z.string().min(1).max(2048) }),
    z.strictObject({ type: z.literal("sse"), url: z.string().min(1).max(2048) }),
  ]),
  env: z.array(McpValueRequest).max(50),
  headers: z.array(McpValueRequest).max(50),
  boxes: z.array(z.strictObject({ machineId: z.string().min(1).max(64), boxPubKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/u) })).max(500),
  /** A Navi's integration: what the hub's tool policy reads its tools as. */
  integration: z
    .strictObject({
      kind: z.enum(["google", "notion", "custom"]),
      readTools: z
        .array(z.string().regex(/^[A-Za-z0-9_.:/-]{1,128}$/u))
        .max(200)
        .optional(),
    })
    .optional(),
});
export type McpServerRequest = z.infer<typeof McpServerRequest>;
/**
 * A link key pasted into a Navi's Linked hubs (Settings › Projects): main seals `key` to `boxPubKey`, the hub's own key
 * from hub_links_get, and calls hub_link_add. The hub gets the box, never the key, and nothing returns it.
 */
export const HubLinkRequest = z.strictObject({
  navi: z.strictObject({ machineId: z.string().min(1).max(64), projectId: z.string().min(1).max(200) }),
  label: z.string().trim().min(1).max(40),
  url: z.string().trim().min(1).max(2048),
  boxPubKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/u),
  key: z.string().trim().min(1).max(200),
});
export type HubLinkRequest = z.infer<typeof HubLinkRequest>;

/**
 * The hub's Google OAuth client (Settings › Hub accounts › Google): main seals `secret` to every box in `boxes` (each machine
 * that may run a Navi) and calls google_client_set. The hub gets the boxes and the id, never the secret.
 */
export const GoogleClientRequest = z.strictObject({
  /** google.rs GoogleClientId. */
  clientId: z.string().regex(/^[A-Za-z0-9._-]{1,200}\.apps\.googleusercontent\.com$/u),
  secret: z.string().min(1).max(SECRET_MAX_BYTES),
  boxes: z.array(z.strictObject({ machineId: z.string().min(1).max(64), boxPubKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/u) })).min(1).max(500),
});
export type GoogleClientRequest = z.infer<typeof GoogleClientRequest>;
/**
 * Real-time mail (Settings › Hub accounts › Google): main checks `key` is a service account's JSON key, seals it to
 * `boxPubKey`, the reading machine's key, and calls google_pubsub_set. The hub gets the box, never the key.
 */
export const GooglePubsubRequest = z.strictObject({
  /** google.rs PubsubTopic and PubsubSubscription. */
  topic: z.string().regex(/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/topics\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/u),
  subscription: z.string().regex(/^projects\/[a-z][a-z0-9-]{4,28}[a-z0-9]\/subscriptions\/[A-Za-z][A-Za-z0-9._~+%-]{2,254}$/u),
  machineId: z.string().min(1).max(64),
  boxPubKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/u),
  key: z.string().min(1).max(SECRET_MAX_BYTES),
});
export type GooglePubsubRequest = z.infer<typeof GooglePubsubRequest>;
/**
 * Connect a Navi to a Google account (its Integrations): main reads the hub's client from google_get, opens Google's
 * consent page with PKCE in the browser, catches the answer on a loopback port and calls google_connect itself, so the
 * code never reaches the page.
 */
export const GoogleConnectRequest = z.strictObject({
  project: z.strictObject({ machineId: z.string().min(1).max(64), projectId: z.string().min(1).max(200) }),
});
export type GoogleConnectRequest = z.infer<typeof GoogleConnectRequest>;
/**
 * Create the hub's own GitHub App (Settings › Hub accounts › GitHub): main asks the hub for its manifest, posts it to GitHub from
 * a loopback page, catches GitHub's code there and calls github_app_create itself; the App's keys go to the hub only.
 */
export const GithubAppRequest = z.strictObject({
  name: z.string().regex(/^[^\r\n]{1,34}$/u),
  organization: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/u)
    .optional(),
});
export type GithubAppRequest = z.infer<typeof GithubAppRequest>;

const Boxes = z.array(z.strictObject({ machineId: z.string().min(1).max(64), boxPubKey: z.string().regex(/^[A-Za-z0-9+/]{43}=$/u) })).max(500);
/**
 * A Claude account's secret (Settings › Your accounts › Claude, Settings › Hub accounts › Claude): main seals it to every machine in `boxes`
 * and calls claude_hub_api_set (the hub's key, with its endpoint; no key keeps the saved one) or
 * claude_subscription_set (the person's own `claude setup-token` token). The hub gets the boxes, never the value.
 */
export const ClaudeAccountRequest = z.discriminatedUnion("account", [
  z.strictObject({
    account: z.literal("hub_api"),
    key: z.string().min(1).max(SECRET_MAX_BYTES).optional(),
    endpoint: z.string().trim().min(1).max(500).optional(),
    boxes: Boxes,
  }),
  z.strictObject({ account: z.literal("mine"), token: z.string().min(1).max(SECRET_MAX_BYTES), boxes: Boxes }),
]);
export type ClaudeAccountRequest = z.infer<typeof ClaudeAccountRequest>;

/**
 * A person's 1Password service account token (Settings › Your accounts › 1Password): main seals it to every machine in
 * `boxes` and calls onepassword_set. The hub gets the boxes, never the value.
 */
export const OnePasswordRequest = z.strictObject({ token: z.string().min(1).max(SECRET_MAX_BYTES), boxes: Boxes });
export type OnePasswordRequest = z.infer<typeof OnePasswordRequest>;

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
  target: PairTarget.optional(),
});
/** A hub's new label and colour (null: none). Main trims the label and checks its length. */
const HubChange = z.strictObject({ label: HubLabel, color: HubColor.nullable() });
const ProbeRequest = z.string().trim().min(1).max(2048);
/** The enabled commands; any menu command left out is disabled. */
const MenuState = z.array(z.enum(MENU_COMMANDS)).max(MENU_COMMANDS.length);

/** A browser session's id, as the node mints it. */
export const BrowserSessionId = z.string().regex(/^B[0-9a-f]{32}$/u);

const coord = z.number().min(-100_000).max(100_000);
const modifiers = z.int().min(0).max(15);
/** A person's input to a page they took over (contracts BrowserInput), in the last frame's pixels. */
export const BrowserInput = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("mouse"),
    action: z.enum(["pressed", "released", "moved", "wheel"]),
    x: coord,
    y: coord,
    button: z.enum(["none", "left", "middle", "right"]).optional(),
    clickCount: z.int().min(0).max(3).optional(),
    deltaX: coord.optional(),
    deltaY: coord.optional(),
    modifiers: modifiers.optional(),
  }),
  z.strictObject({
    kind: z.literal("key"),
    action: z.enum(["down", "up"]),
    key: z.string().min(1).max(32),
    code: z.string().max(32).optional(),
    text: z.string().max(8).optional(),
    modifiers: modifiers.optional(),
  }),
  z.strictObject({ kind: z.literal("text"), text: z.string().min(1).max(10_000) }),
]);

/** A session to open in a window of its own; main builds the route from these, never from a URL the page sends. */
const Segment = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/u);
/** `hub`: the session's hub, when it isn't the app's first (the route's `?hub=`). */
export const SessionWindowRequest = z.strictObject({ machineId: Segment, projectId: Segment, session: Segment, hub: z.string().regex(HUB_ID).optional() });
export type SessionWindowRequest = z.infer<typeof SessionWindowRequest>;

const none = z.tuple([]);

/** The argument list each invoke channel accepts. */
export const REQUESTS = {
  [IPC.hubsList]: none,
  [IPC.hubsUpdate]: z.tuple([HubId, HubChange]),
  [IPC.hubSubscribe]: z.tuple([HubId]),
  [IPC.hubUnsubscribe]: z.tuple([HubId]),
  [IPC.hubCall]: z.tuple([HubId, CallRequest]),
  [IPC.hubChat]: z.tuple([HubId, ChatScope.nullable()]),
  [IPC.hubFocus]: z.tuple([HubId, OrderFocus.nullable()]),
  [IPC.hubWatch]: z.tuple([HubId, BrowserSessionId.nullable()]),
  [IPC.hubInput]: z.tuple([HubId, BrowserSessionId, BrowserInput]),
  [IPC.hubResync]: z.tuple([HubId]),
  [IPC.hubRetryNow]: z.tuple([HubId]),
  [IPC.hubCacheRead]: z.tuple([HubId]),
  // A string's UTF-16 length never exceeds its UTF-8 size, so this is a loose bound; main checks the bytes and the
  // envelope (main/hub/cache.ts).
  [IPC.hubCacheWrite]: z.tuple([HubId, z.string().max(HUB_CACHE_MAX_BYTES)]),
  [IPC.hubConnect]: z.tuple([ConnectRequest]),
  [IPC.hubForget]: z.tuple([HubId]),
  [IPC.pairStart]: none,
  [IPC.pairProbe]: z.tuple([ProbeRequest]),
  [IPC.pairRedeem]: z.tuple([PairRequest]),
  [IPC.pairAuto]: none,
  [IPC.pairStore]: none,
  [IPC.pairSetup]: none,
  [IPC.secretSubmit]: z.tuple([HubId, SecretRequest]),
  [IPC.projectEnvSubmit]: z.tuple([HubId, ProjectEnvRequest]),
  [IPC.mcpServerSubmit]: z.tuple([HubId, McpServerRequest]),
  [IPC.hubLinkSubmit]: z.tuple([HubId, HubLinkRequest]),
  [IPC.googleClientSubmit]: z.tuple([HubId, GoogleClientRequest]),
  [IPC.googlePubsubSubmit]: z.tuple([HubId, GooglePubsubRequest]),
  [IPC.googleConnect]: z.tuple([HubId, GoogleConnectRequest]),
  [IPC.googleCancel]: none,
  [IPC.githubAppCreate]: z.tuple([HubId, GithubAppRequest]),
  [IPC.githubAppCancel]: none,
  [IPC.githubConnect]: z.tuple([HubId]),
  [IPC.claudeAccountSubmit]: z.tuple([HubId, ClaudeAccountRequest]),
  [IPC.onePasswordSubmit]: z.tuple([HubId, OnePasswordRequest]),
  [IPC.systemHostName]: none,
  [IPC.machinesJoinHere]: z.tuple([HubId, z.string().regex(/^[a-z0-9-]{1,32}$/u)]),
  [IPC.machinesJoinHereState]: z.tuple([HubId]),
  [IPC.machinesThisComputer]: none,
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
  [IPC.appSessionWindow]: z.tuple([SessionWindowRequest]),
  [IPC.updatesState]: none,
  [IPC.updatesCheck]: none,
  [IPC.updatesInstall]: none,
  [IPC.updatesKeep]: none,
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
