// What the agent's CDP proxy lets through (crates/fleetd/src/node/browser/proxy.rs `command_in`, credentials.rs
// `sealed_refusal`), as an allowlist: a command goes to the browser only when it is one agent-browser itself sends.
// The Rust proxy refuses named methods; three review rounds of #800 each found another method around such a list, so
// here everything not on agent-browser's own list is refused, and a session that filled a login keeps a narrower one.
//
// AGENT_BROWSER_METHODS is every CDP command agent-browser 0.39.4 (the pinned version, node/browser/agent_browser.rs)
// names: the protocol's command names (devtools-protocol's browser_protocol.json and js_protocol.json) found in its
// binary. Pinning a newer agent-browser means listing its commands again.

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

/** A CDP error answer for command `id`. */
export const refused = (id: unknown, message: string) => ({ id, error: { code: -32000, message } });

/** What the proxy knows of its session when it checks a command. */
export type GuardSession = {
  /** The broker's own sessions and targets on the browser, which the driver never sees. */
  isOwn(session: string): boolean;
  isOwnTarget(target: string): boolean;
  /** It filled a login from 1Password: the narrower list. */
  sealed(): boolean;
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
    // TODO(bun): agent-browser's pinned script shapes (shapes.rs, agent_browser_shapes.json: oxc's minified AST,
    // hashed), so a sealed session runs its own scripts. Until then a sealed session runs none: closed, not open.
    return `This script is refused: this browser session filled a login from 1Password, so it runs only agent-browser's own scripts, and the Bun node can't tell them apart yet. Use agent-browser's snapshot, click, fill and scroll; start a new session for anything else.`;
  }
  return undefined;
}
