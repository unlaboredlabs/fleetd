// agent-browser's own script shapes: its commands, run on a real Chrome through a relay in front of the session's proxy
// that keeps every script it evaluates. With FLEETD_WRITE_SHAPES set, `scripts/agent-browser-shapes.sh` writes them to
// src/node/browser/agent_browser_shapes.json; without, every one must already be pinned there. It runs when
// FLEETD_TEST_AGENT_BROWSER names agent-browser's binary and this machine has a Chrome (browser_rig.ts); CI's bun job
// runs it on the pinned version.
import { expect, setDefaultTimeout, test } from "bun:test";
import { type Node as AstNode, parse, tokenizer } from "acorn";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { VERSION } from "../src/node/browser/agent_browser.ts";
import { type Kind, pinned, refusal, shape, writes } from "../src/node/browser/shapes.ts";
import { chrome, rig } from "./browser_rig.ts";

setDefaultTimeout(300_000);

const BINARY = process.env.FLEETD_TEST_AGENT_BROWSER;
const FILE = join(import.meta.dir, "../src/node/browser/agent_browser_shapes.json");

/** A page with one of each thing agent-browser's commands act on, and a second to go back and forth to. */
function playground() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: (req) =>
      new Response(
        new URL(req.url).pathname === "/next"
          ? "<html><head><title>Next</title></head><body><p id=n>Next page</p></body></html>"
          : "<html><head><title>Playground</title></head><body style='height:3000px'>" +
              "<h1 id=h>Playground</h1><a id=link href=/next>Next</a>" +
              "<label for=name>Name</label><input id=name placeholder=Name data-testid=name>" +
              "<input id=agree type=checkbox><label><input id=news type=checkbox>News</label>" +
              "<select id=pick><option value=a>Apple</option><option value=b>Banana</option></select>" +
              "<button id=b title=Go aria-label=Go>Go</button><img alt=Logo src=data:,>" +
              "<textarea id=t></textarea><p id=far style='margin-top:2000px'>Far</p></body></html>",
        { headers: { "content-type": "text/html" } },
      ),
  });
}

/** A CDP relay to `upstream` that keeps every script its client sends. */
function relay(upstream: string) {
  const seen: [Kind, string][] = [];
  const server = Bun.serve<{ browser: WebSocket; queued: string[] }>({
    hostname: "127.0.0.1",
    port: 0,
    fetch(req, server) {
      const browser = new WebSocket(upstream);
      const data = { browser, queued: [] as string[] };
      return server.upgrade(req, { data }) ? undefined : new Response("not a websocket", { status: 400 });
    },
    websocket: {
      open(client) {
        const { browser } = client.data;
        browser.onmessage = (e) => client.send(String(e.data));
        browser.onclose = () => client.close();
        browser.onopen = () => {
          for (const m of client.data.queued.splice(0)) browser.send(m);
        };
      },
      message(client, message) {
        const text = String(message);
        try {
          const { method, params } = JSON.parse(text);
          if (method === "Runtime.evaluate" || method === "Runtime.compileScript") {
            if (typeof params?.expression === "string") seen.push(["script", params.expression]);
          } else if (method === "Runtime.callFunctionOn" && typeof params?.functionDeclaration === "string") {
            seen.push(["function", params.functionDeclaration]);
          }
        } catch {}
        const { browser } = client.data;
        if (browser.readyState === WebSocket.OPEN) browser.send(text);
        else client.data.queued.push(text);
      },
      close(client) {
        client.data.browser.close();
      },
    },
  });
  return { url: `ws://127.0.0.1:${server.port}/devtools/browser/relay`, seen, stop: () => server.stop(true) };
}

/** agent-browser's commands, each the way an agent runs it, but `eval`, `get value` and `wait --fn`: their scripts are
 * the agent's own, and a sealed session's policy denies the first two anyway. */
const commands = (site: string): string[][] => [
  ["open", site],
  ["snapshot"],
  ["snapshot", "-i"],
  ["snapshot", "-i", "-c"],
  ["click", "#b"],
  ["click", "@e1"],
  ["dblclick", "#h"],
  ["hover", "#b"],
  ["focus", "#name"],
  ["fill", "#name", "Ada"],
  ["type", "#t", "hello"],
  ["press", "Tab"],
  ["press", "Control+a"],
  ["keyboard", "type", "x"],
  ["keyboard", "inserttext", "y"],
  ["check", "#agree"],
  ["uncheck", "#agree"],
  ["check", "#news"],
  ["select", "#pick", "b"],
  ["select", "#pick", "Apple"],
  ["scroll", "down", "300"],
  ["scroll", "up"],
  ["scroll", "right", "10"],
  ["scrollintoview", "#far"],
  ["wait", "#h"],
  ["wait", "50"],
  ["wait", "--text", "Playground"],
  ["wait", "--load", "load"],
  ["get", "text", "#h"],
  ["get", "text", "body"],
  ["get", "html", "#h"],
  ["get", "attr", "#link", "href"],
  ["get", "title"],
  ["get", "url"],
  ["get", "count", "input"],
  ["get", "box", "#b"],
  ["get", "styles", "#b"],
  ["is", "visible", "#b"],
  ["is", "enabled", "#b"],
  ["is", "checked", "#agree"],
  ["find", "role", "button", "click", "--name", "Go"],
  ["find", "text", "Playground", "hover"],
  ["find", "label", "Name", "fill", "Grace"],
  ["find", "placeholder", "Name", "fill", "Ada"],
  ["find", "alt", "Logo", "hover"],
  ["find", "title", "Go", "hover"],
  ["find", "testid", "name", "fill", "Lin"],
  ["find", "first", "input", "check"],
  ["find", "nth", "1", "input", "hover"],
  ["find", "role", "heading", "text"],
  ["mouse", "move", "10", "10"],
  ["mouse", "wheel", "100"],
  ["highlight", "#h"],
  ["screenshot"],
  ["set", "viewport", "1024", "768"],
  ["scrollintoview", "#link"],
  ["click", "#link"],
  ["wait", "--url", "**/next"],
  ["back"],
  ["forward"],
  ["reload"],
  ["open", `${site}/next`],
  ["tab", "list"],
  ["console"],
  ["errors"],
  ["diff", "snapshot"],
];

/**
 * The script as the file keeps it: as read (a function wrapped as shapes.ts reads one), with each value a placeholder
 * of its kind, so its shape is the script's. Property keys and a computed member's string name what the script
 * touches, and stay.
 */
export function placeheld(script: string, kind: Kind): string {
  const text = kind === "function" ? `(\n${script}\n)` : script;
  const spans: [number, number, string][] = [];
  const visit = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n));
    if (!node || typeof node !== "object") return;
    const n = node as AstNode & Record<string, any>;
    if (typeof n.type !== "string") return;
    switch (n.type) {
      case "Literal":
        if (typeof n.value === "string") spans.push([n.start, n.end, '""']);
        else if (n.bigint !== undefined) spans.push([n.start, n.end, " 0n "]);
        else if (typeof n.value === "number") spans.push([n.start, n.end, " 0 "]);
        else if (typeof n.value === "boolean") spans.push([n.start, n.end, " false "]);
        return;
      case "UnaryExpression":
        if ((n.operator === "-" || n.operator === "+") && n.argument.type === "Literal" && (typeof n.argument.value === "number" || n.argument.bigint !== undefined)) {
          spans.push([n.start, n.end, " 0 "]);
          return;
        }
        break;
      case "TemplateElement":
        spans.push([n.start, n.end, ""]);
        return;
      case "Property":
      case "MethodDefinition":
      case "PropertyDefinition":
        if (n.key?.type === "Literal" && (typeof n.key.value === "string" || typeof n.key.value === "number")) {
          for (const [k, v] of Object.entries(n)) if (k !== "key") visit(v);
          return;
        }
        break;
      case "MemberExpression":
        if (n.computed && n.property.type === "Literal" && typeof n.property.value === "string") {
          visit(n.object);
          return;
        }
        break;
    }
    for (const [k, v] of Object.entries(n)) if (k !== "type" && k !== "start" && k !== "end") visit(v);
  };
  visit(parse(text, { ecmaVersion: "latest", sourceType: "script" }));
  spans.sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [start, end, placeholder] of spans) {
    if (start < at) continue;
    out += text.slice(at, start) + placeholder;
    at = end;
  }
  return compact(out + text.slice(at));
}

/** `text` without its comments and spacing, token by token: a line break stays where dropping it could change what
 * the script means (a semicolon it stands for), and a space where the two tokens would run together. */
function compact(text: string): string {
  let out = "";
  let end = 0;
  for (const token of tokenizer(text, { ecmaVersion: "latest" })) {
    const piece = text.slice(token.start, token.end);
    const gap = text.slice(end, token.start);
    const [before, after] = [out.at(-1) ?? "", piece[0] ?? ""];
    if (out && /[\n\r\u2028\u2029]/.test(gap) && !";{([,".includes(before) && !";)],}".includes(after)) out += "\n";
    else if (out && gap && !"{}()[];,:".includes(before) && !"{}()[];,:".includes(after)) out += " ";
    out += piece;
    end = token.end;
  }
  return out;
}

test("CI has what the shapes test needs", () => {
  // CI sets FLEETD_REQUIRE_AGENT_BROWSER, so that the test below fails there, not skips, without either.
  if (!process.env.FLEETD_REQUIRE_AGENT_BROWSER) return;
  expect(BINARY, "FLEETD_TEST_AGENT_BROWSER").toBeTruthy();
  expect(chrome, "a Chrome (FLEETD_TEST_CHROME)").toBeTruthy();
});

test.skipIf(!BINARY || !chrome)("agent-browser's scripts are all pinned shapes", async () => {
  const site = playground();
  const r = await rig();
  const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-shapes-"));
  let relayed: ReturnType<typeof relay> | undefined;
  try {
    const started = await r.call("session_start", { purpose: "agent-browser's scripts" });
    relayed = relay(String(started.result!.cdp));
    const env = {
      PATH: "/usr/bin:/bin",
      HOME: dir,
      AGENT_BROWSER_CDP: relayed.url,
      AGENT_BROWSER_SOCKET_DIR: join(dir, "sockets"),
      AGENT_BROWSER_SESSION: "fleetd-shapes",
    };
    for (const args of [...commands(`http://127.0.0.1:${site.port}`), ["close"]]) {
      // Not spawnSync: the relay runs in this process, and answers only while it waits.
      const child = Bun.spawn([BINARY!, ...args], { env, cwd: dir, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000 });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      if (code !== 0 && args[0] !== "close") console.error(`${args.join(" ")}: ${stdout}${stderr}`);
    }
    await r.call("session_end");

    // By shape: each once, in a stable order. One that writes where a sealed session never lets a script write is left
    // out, as a sealed session would refuse it anyway.
    const found = new Map<string, string>();
    for (const [kind, script] of relayed.seen) {
      const why = writes(script, kind);
      if (why) {
        console.error(`left out, ${why}: ${script}`);
        continue;
      }
      const kept = placeheld(script, kind);
      const hash = shape(script, kind);
      expect(shape(kept, "script"), kept).toBe(hash);
      if (!found.has(hash)) found.set(hash, kept);
    }
    expect(found.size).toBeGreaterThan(10);
    if (process.env.FLEETD_WRITE_SHAPES) {
      const shapes = [...found].sort(([a], [b]) => (a < b ? -1 : 1)).map(([hash, script]) => ({ hash, script }));
      writeFileSync(FILE, `${JSON.stringify({ agentBrowser: VERSION, shapes }, null, 2)}\n`);
      return;
    }
    for (const [kind, script] of relayed.seen) {
      if (writes(script, kind)) continue;
      expect(pinned(script, kind), `not pinned (run scripts/agent-browser-shapes.sh): ${script}`).toBe(true);
      // And a sealed session runs each as agent-browser sent it, its values included.
      expect(refusal(script, kind), script).toBeUndefined();
    }
  } finally {
    relayed?.stop();
    await r.done();
    site.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
