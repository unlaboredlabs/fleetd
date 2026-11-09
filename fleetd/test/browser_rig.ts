// A node with a real headless Chrome for the browser's fill tests (crates/fleetd/src/node/browser/tests.rs `Rig`): the
// node's broker on Playwright's headless shell from ~/.cache/ms-playwright (none: the tests skip), a fake 1Password
// in place of the SDK helper, and a CDP driver that reaches the browser only through the node's proxy, as an agent's
// agent-browser does. Never a real vault or a real card.
import { homedir } from "node:os";
import { join } from "node:path";
import { findChrome, launch } from "../src/node/browser/chrome.ts";
import { Broker, start } from "../src/node/browser/index.ts";
import type { Vault, VaultFor } from "../src/node/browser/onepassword.ts";
import { TOKEN_ENV } from "../src/node/browser/onepassword.ts";
import { Masker } from "../src/node/mask.ts";
import { tempHome } from "./helpers.ts";
import { testNode } from "./node_helpers.ts";

export const chrome = findChrome(join(homedir(), ".cache", "ms-playwright"));
export const THREAD = "t-fill";
export const TOKEN = "ops_fake-service-account-token-0123456789";

export type Rig = Awaited<ReturnType<typeof rig>>;

/** The node and its broker on a real Chrome, the session's secrets `secrets` (its 1Password token by default). */
export async function rig(secrets: [string, string][] = [[TOKEN_ENV, TOKEN]], config: Record<string, unknown> = {}) {
  const home = tempHome();
  const t = testNode("devbox", config);
  t.node.area("sessions", () => ({
    maskFor: () => new Masker(),
    sessionCwd: () => "/",
    secretsFor: () => secrets,
    hasProject: () => true,
  }));
  // The hub's answers to a recording's pieces: what it holds after each.
  const answers = new Map<string, (args: Record<string, unknown>) => Record<string, unknown> | Promise<Record<string, unknown>>>();
  t.link.answer = async (op, args) => {
    if (op === "browser_recording_part") return { bytes: Number(args.offset) + Buffer.from(String(args.dataB64), "base64").length };
    const answer = answers.get(op);
    return answer ? answer(args) : {};
  };
  const broker = start(t.node, new Broker(t.node, (kept) => launch(chrome!, join(home.dir, "profiles"), true, kept)));
  const done = async () => {
    await broker.shutdown();
    t.done();
    home.done();
  };
  /** One browser call of the agent's, as agent-mcp sends it: its result, or its error. */
  const call = async (op: string, args: Record<string, unknown> = {}, thread = THREAD): Promise<{ result?: Record<string, unknown>; error?: { code: string; message: string; fix?: string } }> => {
    try {
      return { result: await broker.call(thread, { id: op, cwd: "/", call: { op, ...args } as never }) };
    } catch (e) {
      const err = e as { toJSON?: () => { code: string; message: string; fix?: string }; message: string };
      return { error: err.toJSON ? err.toJSON() : { code: "failed", message: err.message } };
    }
  };
  return { node: t.node, link: t.link, broker, call, answers, done, home: t.node.home };
}

/** A fake 1Password: each reference's value and its item's websites, for the session's token only. */
export function fakeVault(items: Record<string, string>, urls: string[], extra: Partial<Vault> = {}): { vault: Vault; asked: string[]; vaultFor: VaultFor } {
  const asked: string[] = [];
  const vault: Vault = {
    async resolve(reference) {
      asked.push(reference);
      const value = items[reference];
      if (value === undefined) throw new Error(`no item for ${reference}`);
      return { value, urls };
    },
    ...extra,
  };
  return {
    vault,
    asked,
    vaultFor: (token) => {
      if (token !== TOKEN) throw new Error(`not the session's token: ${token}`);
      return vault;
    },
  };
}

/** A CDP client on the node's proxy, as the agent's agent-browser connects. */
export async function driver(url: string) {
  const ws = new WebSocket(url);
  const got: Record<string, unknown>[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = j;
  });
  let ids = 1000;
  const send = async (method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, any>> => {
    const id = ids++;
    ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    for (const end = Date.now() + 15_000; Date.now() < end; ) {
      const answer = got.find((m) => m.id === id);
      if (answer) return answer as Record<string, any>;
      await Bun.sleep(5);
    }
    throw new Error(`no answer to ${method}`);
  };
  const ok = async (method: string, params: Record<string, unknown> = {}, sessionId?: string) => {
    const answer = await send(method, params, sessionId);
    if (answer.error) throw new Error(`${method}: ${JSON.stringify(answer.error)}`);
    return answer.result as Record<string, any>;
  };
  /** The page's target, attached flattened: its session for the driver's commands. */
  const page = async () => {
    const { targetInfos } = await ok("Target.getTargets");
    const target = (targetInfos as { targetId: string; type: string }[]).find((t) => t.type === "page")!;
    return (await ok("Target.attachToTarget", { targetId: target.targetId, flatten: true })).sessionId as string;
  };
  /** agent-browser's own read of an expression's value (`get title`, `document.title`). */
  const evaluate = async (session: string, expression: string) => (await ok("Runtime.evaluate", { expression, returnByValue: true }, session)).result?.value;
  /** Waits until `expression` (one of agent-browser's own reads) is `want`, as the page loads. */
  const until = async (session: string, expression: string, want: unknown) => {
    let seen: unknown;
    for (const end = Date.now() + 15_000; Date.now() < end; await Bun.sleep(50)) {
      try {
        seen = await evaluate(session, expression);
      } catch {
        // A read while Chrome swaps documents: try again.
      }
      if (seen === want) return;
    }
    throw new Error(`${expression} stayed ${JSON.stringify(seen)}, not ${JSON.stringify(want)}`);
  };
  return { ws, got, send, ok, page, evaluate, until, close: () => ws.close() };
}

/** Reads a POST body's form field. */
export function formValue(body: string, key: string): string | undefined {
  const raw = body.split("&").find((kv) => kv.startsWith(`${key}=`));
  return raw === undefined ? undefined : decodeURIComponent(raw.slice(key.length + 1).replace(/\+/g, " "));
}

/** Every form a value could leak in: as typed, encoded, escaped, or reversed by a read that reshapes it. */
export function forms(value: string): string[] {
  const percent = [...Buffer.from(value)]
    .map((b) => (/[A-Za-z0-9\-_.~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : b === 32 ? "+" : `%${b.toString(16).toUpperCase().padStart(2, "0")}`))
    .join("");
  return [
    value,
    Buffer.from(value).toString("base64"),
    Buffer.from(value).toString("base64url"),
    percent,
    JSON.stringify(value).slice(1, -1),
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;"),
    [...value].reverse().join(""),
  ];
}

/** The recording's action log, as the hub got it in pieces. */
export function uploaded(link: { calls: { op: string; args: Record<string, unknown> }[] }, sessionId: string, file = "actions"): string {
  return link.calls
    .filter((c) => c.op === "browser_recording_part" && c.args.sessionId === sessionId && c.args.file === file)
    .map((c) => Buffer.from(String(c.args.dataB64), "base64").toString())
    .join("");
}

/** Waits for `fn` to hold. */
export async function eventually(fn: () => boolean, ms = 10_000): Promise<void> {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) if (fn()) return;
  throw new Error("it never happened");
}
