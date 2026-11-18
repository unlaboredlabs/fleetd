// What the agent's CDP proxy lets through (credentials.rs
// `sealed_refusal`), as an allowlist: a command goes to the browser only when it is one agent-browser itself sends.
// The Rust proxy refuses named methods; three review rounds of #800 each found another method around such a list, so
// here everything not on agent-browser's own list is refused, and a session that filled a login keeps a narrower one.
//
// AGENT_BROWSER_METHODS is every CDP command agent-browser 0.39.4 (the pinned version, node/browser/agent_browser.rs)
// names: the protocol's command names (devtools-protocol's browser_protocol.json and js_protocol.json) found in its
// binary. Pinning a newer agent-browser means listing its commands again.

import { refusal as scriptRefusal } from "./shapes.ts";

/** The CDP commands agent-browser 0.39.4 sends. */
export const AGENT_BROWSER_METHODS: ReadonlySet<string> = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Browser.close",
  "Browser.getVersion",
  "Browser.getWindowForTarget",
  "Browser.grantPermissions",
  "Browser.setContentsSize",
  "Browser.setDownloadBehavior",
  "DOM.describeNode",
  "DOM.enable",
  "DOM.getBoxModel",
  "DOM.getDocument",
  "DOM.getFrameOwner",
  "DOM.querySelectorAll",
  "DOM.resolveNode",
  "DOM.scrollIntoViewIfNeeded",
  "DOM.setFileInputFiles",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setEmulatedMedia",
  "Emulation.setGeolocationOverride",
  "Emulation.setLocaleOverride",
  "Emulation.setTimezoneOverride",
  "Emulation.setUserAgentOverride",
  "Fetch.continueRequest",
  "Fetch.continueWithAuth",
  "Fetch.disable",
  "Fetch.enable",
  "Fetch.failRequest",
  "Fetch.fulfillRequest",
  "IO.close",
  "IO.read",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.dispatchTouchEvent",
  "Input.insertText",
  "Network.clearBrowserCookies",
  "Network.emulateNetworkConditions",
  "Network.enable",
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.getResponseBody",
  "Network.setCookies",
  "Network.setExtraHTTPHeaders",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.bringToFront",
  "Page.captureScreenshot",
  "Page.createIsolatedWorld",
  "Page.enable",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.handleJavaScriptDialog",
  "Page.navigate",
  "Page.printToPDF",
  "Page.reload",
  "Page.removeScriptToEvaluateOnNewDocument",
  "Page.screencastFrameAck",
  "Page.setDocumentContent",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Runtime.addBinding",
  "Runtime.callFunctionOn",
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.releaseObject",
  "Runtime.runIfWaitingForDebugger",
  "Security.setIgnoreCertificateErrors",
  "Target.activateTarget",
  "Target.attachToTarget",
  "Target.closeTarget",
  "Target.createBrowserContext",
  "Target.createTarget",
  "Target.detachFromTarget",
  "Target.getTargetInfo",
  "Target.getTargets",
  "Target.setAutoAttach",
  "Target.setDiscoverTargets",
  "Tracing.end",
  "Tracing.start",
]);

/**
 * Of those, what a session that filled a login from 1Password keeps: nothing that reads a page's contents back in
 * another form (a PDF, a response body, a trace), changes what a page runs or where it sends, rewrites traffic, or
 * grants a page more. Its scripts and selectors are checked too (`sealedRefusal`).
 */
export const SEALED_METHODS: ReadonlySet<string> = new Set(
  [...AGENT_BROWSER_METHODS].filter(
    (m) =>
      !m.startsWith("Fetch.") &&
      !m.startsWith("Tracing.") &&
      !m.startsWith("IO.") &&
      ![
        "Page.printToPDF",
        "Page.addScriptToEvaluateOnNewDocument",
        "Page.setDocumentContent",
        "Page.createIsolatedWorld",
        "Runtime.addBinding",
        "Network.getResponseBody",
        "Network.setExtraHTTPHeaders",
        "Browser.grantPermissions",
      ].includes(m),
  ),
);

/**
 * For a session whose agent runs in a box (a VM, a hosted sandbox), what each of agent-browser's commands may name, as
 * an allowlist of its own: a method is let through only once it is listed here, as taking no URL or path (`PLAIN`) or
 * with its check (`boxedRefusal`). The browser runs on this machine, outside the box: its network goes out through the
 * box (egress.ts), so a URL could only reach beyond the box through a local scheme (file:, chrome:, view-source: and
 * the like), and a path only by naming this machine's files the box doesn't show.
 */
export const BOXED_PLAIN: ReadonlySet<string> = new Set([
  "Accessibility.enable",
  "Accessibility.getFullAXTree",
  "Browser.close",
  "Browser.getVersion",
  "Browser.getWindowForTarget",
  "Browser.grantPermissions",
  "Browser.setContentsSize",
  "DOM.describeNode",
  "DOM.enable",
  "DOM.getBoxModel",
  "DOM.getDocument",
  "DOM.getFrameOwner",
  "DOM.querySelectorAll",
  "DOM.resolveNode",
  "DOM.scrollIntoViewIfNeeded",
  "Emulation.setDeviceMetricsOverride",
  "Emulation.setEmulatedMedia",
  "Emulation.setGeolocationOverride",
  "Emulation.setLocaleOverride",
  "Emulation.setTimezoneOverride",
  "Emulation.setUserAgentOverride",
  "Fetch.continueWithAuth",
  "Fetch.disable",
  "Fetch.enable",
  "Fetch.failRequest",
  "Fetch.fulfillRequest",
  "IO.close",
  "IO.read",
  "Input.dispatchKeyEvent",
  "Input.dispatchMouseEvent",
  "Input.dispatchTouchEvent",
  "Input.insertText",
  "Network.clearBrowserCookies",
  "Network.emulateNetworkConditions",
  "Network.enable",
  "Network.getAllCookies",
  "Network.getCookies",
  "Network.getResponseBody",
  "Network.setCookies",
  "Network.setExtraHTTPHeaders",
  "Page.addScriptToEvaluateOnNewDocument",
  "Page.bringToFront",
  "Page.captureScreenshot",
  "Page.createIsolatedWorld",
  "Page.enable",
  "Page.getFrameTree",
  "Page.getLayoutMetrics",
  "Page.handleJavaScriptDialog",
  "Page.printToPDF",
  "Page.reload",
  "Page.removeScriptToEvaluateOnNewDocument",
  "Page.screencastFrameAck",
  "Page.setDocumentContent",
  "Page.startScreencast",
  "Page.stopScreencast",
  "Runtime.addBinding",
  "Runtime.callFunctionOn",
  "Runtime.enable",
  "Runtime.evaluate",
  "Runtime.releaseObject",
  "Runtime.runIfWaitingForDebugger",
  "Security.setIgnoreCertificateErrors",
  "Target.activateTarget",
  "Target.attachToTarget",
  "Target.closeTarget",
  "Target.detachFromTarget",
  "Target.getTargetInfo",
  "Target.getTargets",
  "Target.setAutoAttach",
  "Target.setDiscoverTargets",
  "Tracing.end",
  "Tracing.start",
]);

/** The methods `boxedRefusal` checks a URL, path or proxy of. */
export const BOXED_CHECKED: ReadonlySet<string> = new Set([
  "Page.navigate",
  "Target.createTarget",
  "Fetch.continueRequest",
  "Browser.setDownloadBehavior",
  "DOM.setFileInputFiles",
  "Target.createBrowserContext",
]);

/** Where a boxed session's page may go: the web, through the box, and what a page makes of itself. */
const BOXED_SCHEMES = new Set(["http:", "https:", "data:", "blob:"]);

/** Why a boxed session's page may not go to `url`, if it may not: a scheme that reads this machine rather than the box's
 * network (file:, chrome:, view-source:, devtools:, filesystem:, an extension's). about:blank is the empty page. */
export function boxedUrlRefusal(url: string): string | undefined {
  const plain = url.trim();
  if (plain === "about:blank") return undefined;
  let scheme: string;
  try {
    scheme = new URL(plain).protocol;
  } catch {
    return `${JSON.stringify(url)} isn't a full URL: give it with http:// or https://.`;
  }
  if (BOXED_SCHEMES.has(scheme)) return undefined;
  return `${scheme} URLs are refused here: this agent runs in a sandbox, and its browser opens only http and https pages (as the sandbox's network reaches them), never this machine's ${scheme === "file:" ? "files" : "browser pages"}. Serve a file over http from inside the sandbox to open it.`;
}

/** Checks a path the session names against what its box shows: why not, if it may not use it. `write`: a download dir. */
export type BoxedPaths = (path: string, write: boolean) => string | undefined;

/** Why a boxed session refuses `method` with `params`, if it does: a method not yet listed for boxes, a local URL, a
 * path the box doesn't show, or a browser context with a proxy of its own (one that would skip the box's). */
export function boxedRefusal(method: string, params: Record<string, unknown>, paths: BoxedPaths): string | undefined {
  if (BOXED_PLAIN.has(method)) return undefined;
  if (!BOXED_CHECKED.has(method)) {
    return `${method} is refused here: this agent runs in a sandbox, and its browser session takes only the commands checked for one.`;
  }
  switch (method) {
    case "Page.navigate":
    case "Target.createTarget":
      return boxedUrlRefusal(typeof params.url === "string" ? params.url : "");
    case "Fetch.continueRequest": {
      if (params.url === undefined) return undefined;
      const url = typeof params.url === "string" ? params.url : "";
      const why = boxedUrlRefusal(url);
      return why ?? (/^https?:/iu.test(url.trim()) ? undefined : "Fetch.continueRequest may change a request's URL only to http or https here.");
    }
    case "Target.createBrowserContext":
      for (const key of ["proxyServer", "proxyBypassList", "originsWithUniversalNetworkAccess"]) {
        if (params[key] !== undefined) return `Target.createBrowserContext with ${key} is refused here: this agent runs in a sandbox, and every page of its browser goes out through the sandbox's network.`;
      }
      return undefined;
    case "Browser.setDownloadBehavior": {
      if (params.behavior === "deny") return undefined;
      if (typeof params.downloadPath !== "string" || !params.downloadPath) {
        return "Browser.setDownloadBehavior needs a downloadPath here: this agent runs in a sandbox, so its downloads go to a folder the sandbox shows (under its worktree), never this machine's default.";
      }
      return paths(params.downloadPath, true);
    }
    case "DOM.setFileInputFiles": {
      const files = Array.isArray(params.files) ? params.files : [];
      for (const f of files) {
        const why = typeof f === "string" ? paths(f, false) : "DOM.setFileInputFiles takes paths here.";
        if (why) return why;
      }
      return undefined;
    }
  }
  return undefined;
}

/** A CDP error answer for command `id`. */
export const refused = (id: unknown, message: string) => ({ id, error: { code: -32000, message } });

/** What the proxy knows of its session when it checks a command. */
export type GuardSession = {
  /** The broker's own sessions and targets on the browser, which the driver never sees. */
  isOwn(session: string): boolean;
  isOwnTarget(target: string): boolean;
  /** It filled a login from 1Password: the narrower list. */
  sealed(): boolean;
  /** Its agent runs in a box: how its paths are checked against what the box shows (`boxedRefusal`). */
  boxed?(): BoxedPaths | undefined;
};

type Command = { id?: unknown; method?: unknown; params?: Record<string, unknown>; sessionId?: unknown };

/** Why the proxy refuses `command` itself; undefined lets it through to the browser. */
export function refusal(session: GuardSession, command: Command): string | undefined {
  const method = typeof command.method === "string" ? command.method : "";
  const params = command.params ?? {};
  // The broker's sessions, whether the command goes to one or names one, are as if they didn't exist.
  for (const s of [command.sessionId, params.sessionId]) {
    if (typeof s === "string" && session.isOwn(s)) return "No session with given id";
  }
  // A command wrapped in another would pass every check here unread. agent-browser flattens.
  if (method === "Target.attachToTarget" && params.flatten !== true) {
    return `${method} is refused here: attach with flatten: true and send each command with its sessionId.`;
  }
  // By target, a detach could take the broker's session on it rather than the driver's.
  if (method === "Target.detachFromTarget" && typeof params.targetId === "string" && session.isOwnTarget(params.targetId)) {
    return "Target.detachFromTarget by targetId is refused here: detach your own session by its sessionId.";
  }
  if (!AGENT_BROWSER_METHODS.has(method)) {
    return `${method || "A command with no method"} is refused here: this browser session takes the commands agent-browser sends. Drive it with agent-browser.`;
  }
  const paths = session.boxed?.();
  const why = paths ? boxedRefusal(method, params, paths) : undefined;
  if (why) return why;
  return session.sealed() ? sealedRefusal(method, params) : undefined;
}

const REVEALING_SELECTORS = [
  ":invalid",
  ":valid",
  ":user-invalid",
  ":user-valid",
  ":placeholder-shown",
  ":autofill",
  ":-webkit-autofill",
  ":in-range",
  ":out-of-range",
  "[value",
  "|value",
];

/** A selector with comments, escapes and whitespace taken out, lower case (shapes.rs `css_plain`). */
export function cssPlain(selector: string): string {
  const chars = [...selector];
  let out = "";
  for (let i = 0; i < chars.length; ) {
    const c = chars[i]!;
    if (c === "/" && chars[i + 1] === "*") {
      const rest = chars.slice(i + 2).join("");
      const end = rest.indexOf("*/");
      if (end < 0) break;
      i += 2 + [...rest.slice(0, end)].length + 2;
    } else if (c === "\\") {
      let hex = "";
      while (hex.length < 6 && /[0-9a-fA-F]/.test(chars[i + 1 + hex.length] ?? "")) hex += chars[i + 1 + hex.length];
      if (hex === "") {
        out += chars[i + 1] ?? "";
        i += 2;
      } else {
        i += 1 + hex.length;
        if (/\s/.test(chars[i] ?? "")) i += 1;
        const code = Number.parseInt(hex, 16);
        out += code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : "�";
      }
    } else if (/\s/.test(c)) i += 1;
    else {
      out += c;
      i += 1;
    }
  }
  return out.toLowerCase();
}

/** The part of `selector` that could test a field's state, one guess at a time (shapes.rs `revealing_selector`). */
export const revealingSelector = (selector: string) => {
  const plain = cssPlain(selector);
  return REVEALING_SELECTORS.find((part) => plain.includes(part));
};

/** Why a session that filled a credential refuses `method` with `params`, if it does. */
export function sealedRefusal(method: string, params: Record<string, unknown>): string | undefined {
  const sealed = `${method} is off in this browser session: it filled a login from 1Password, and nothing may read that value back or send it elsewhere. Use snapshots, clicks and typing; start a new session for anything else.`;
  if (!SEALED_METHODS.has(method)) return sealed;
  // A reload may carry a script to run.
  if (method === "Page.reload" && params.scriptToEvaluateOnLoad !== undefined && params.scriptToEvaluateOnLoad !== null) {
    return sealed;
  }
  if (method === "DOM.querySelectorAll") {
    const part = revealingSelector(typeof params.selector === "string" ? params.selector : "");
    return part
      ? `${method} with ${part} is off in this browser session: it filled a login from 1Password, and a field's state (${part}) could tell that value one guess at a time. Select by id, name, role or text.`
      : undefined;
  }
  if (method === "Page.navigate" || method === "Target.createTarget") {
    const url = typeof params.url === "string" ? params.url : "";
    return url.trimStart().toLowerCase().startsWith("javascript:") ? sealed : undefined;
  }
  if (method === "Runtime.evaluate" || method === "Runtime.callFunctionOn") {
    const [script, kind] =
      method === "Runtime.evaluate" ? [params.expression, "script" as const] : [params.functionDeclaration, "function" as const];
    const why = scriptRefusal(typeof script === "string" ? script : "", kind);
    return why
      ? `This script is refused: this browser session filled a login from 1Password, so it runs only agent-browser's own scripts, and ${why}. Use agent-browser's snapshot, get, click, fill and scroll; start a new session for anything else.`
      : undefined;
  }
  return undefined;
}
