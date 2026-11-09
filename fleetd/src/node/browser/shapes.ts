// agent-browser's own scripts, for a session that filled a login from 1Password (crates/fleetd/src/node/browser/
// shapes.rs): such a session runs a script only when its shape is one of the pinned agent-browser's
// (agent_browser_shapes.json) and it writes nowhere a value could leave by.
//
// A shape is the script with its values taken out: every string, number, boolean and template piece a placeholder,
// what stays its code. Rust hashes oxc's minified print of that; here both the pinned scripts (that print, re-read) and
// the incoming one are read with acorn and compared as their syntax trees with the same placeholders, which a print's
// parentheses, quotes and spacing don't change.
import { type Node as AstNode, parse } from "acorn";
import pinnedFile from "./agent_browser_shapes.json";
import { revealingSelector } from "./guard.ts";

export type Kind = "script" | "function";

/** The agent-browser version the shapes are pinned for. */
export const PINNED_VERSION = (pinnedFile as { agentBrowser: string }).agentBrowser;

const source = (script: string, kind: Kind) => (kind === "function" ? `(\n${script}\n)` : script);

function read(text: string): AstNode {
  if (text.includes("<!--") || text.includes("-->")) throw new Error("it holds an HTML comment marker");
  try {
    return parse(text, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    throw new Error("it is not a script fleetd can read");
  }
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
const SKIP = new Set(["start", "end", "loc", "range", "raw", "directive", "sourceType"]);

/** A node with its values as placeholders, its positions and raw text gone: what two prints of one shape share. */
function canonical(node: unknown, key = ""): Json {
  if (Array.isArray(node)) return node.map((n) => canonical(n));
  if (!node || typeof node !== "object") return (node ?? null) as Json;
  const n = node as Record<string, unknown> & { type?: string };
  switch (n.type) {
    case "Literal": {
      const v = n.value;
      if (n.bigint !== undefined) return { type: "Big" };
      if (n.regex) return { type: "Re", ...(n.regex as Record<string, string>) };
      if (typeof v === "string") return { type: "Str" };
      if (typeof v === "number") return { type: "Num" };
      if (typeof v === "boolean") return { type: "Bool" };
      return { type: "Null" };
    }
    case "UnaryExpression": {
      const arg = n.argument as { type?: string; value?: unknown; bigint?: unknown };
      if ((n.operator === "-" || n.operator === "+") && arg.type === "Literal" && (typeof arg.value === "number" || arg.bigint !== undefined)) {
        return { type: "Num" };
      }
      break;
    }
    case "TemplateLiteral": {
      // A placeholder string prints as an empty template: the two are one shape.
      if ((n.expressions as unknown[]).length === 0) return { type: "Str" };
      return { type: "Tpl", expressions: canonical(n.expressions) };
    }
    case "Property": {
      // A literal key is the code's, not a value: kept as it is.
      const k = n.key as { type?: string; value?: unknown; name?: string };
      const keyed = !n.computed && k.type === "Literal" ? { type: "Key", name: String(k.value) } : canonical(k);
      return { type: "Property", kind: n.kind as string, computed: !!n.computed, key: keyed, value: canonical(n.value) };
    }
    case "MemberExpression": {
      const p = n.property as { type?: string; value?: unknown };
      const property = n.computed && p.type === "Literal" && typeof p.value === "string" ? { type: "Key", name: p.value } : canonical(p);
      return { type: "MemberExpression", computed: !!n.computed, optional: !!n.optional, object: canonical(n.object), property };
    }
  }
  const out: Record<string, Json> = {};
  for (const k of Object.keys(n).sort()) if (!SKIP.has(k)) out[k] = canonical(n[k], k);
  void key;
  return out;
}

const hash = (tree: Json) => new Bun.CryptoHasher("sha256").update(JSON.stringify(tree)).digest("hex");

/** Each pinned script's shape. */
const PINNED: ReadonlySet<string> = new Set(
  (pinnedFile as { shapes: { script: string }[] }).shapes.flatMap((s) => {
    try {
      return [hash(canonical(read(s.script)))];
    } catch {
      return [];
    }
  }),
);

/** The script's shape; throws why it has none. */
export const shape = (script: string, kind: Kind) => hash(canonical(read(source(script, kind))));

export const pinned = (script: string, kind: Kind) => PINNED.has(shape(script, kind));

// ---- what a script may not write, even one of agent-browser's own shapes (its values are the caller's) ----

const SINK_PROPERTIES = new Set([
  "action", "formAction", "formMethod", "formTarget", "formEnctype", "method", "target", "enctype", "encoding", "src",
  "srcdoc", "href", "ping", "data", "innerHTML", "outerHTML", "type", "style", "cssText", "webkitTextSecurity",
  "location", "pattern", "minLength", "maxLength", "min", "max", "required", "step",
]);
const SINK_ATTRIBUTES = new Set([
  "action", "formaction", "form", "formmethod", "formtarget", "formenctype", "method", "target", "enctype", "src",
  "srcdoc", "href", "xlink:href", "ping", "data", "type", "style", "pattern", "minlength", "maxlength", "min", "max",
  "required", "step",
]);
const SINK_METHODS = new Set([
  "insertAdjacentHTML", "setHTMLUnsafe", "createContextualFragment", "write", "writeln", "execCommand", "sendBeacon",
  "postMessage", "defineProperty", "defineProperties", "setAttributeNode", "setAttributeNodeNS",
]);
const MOVES = new Set([
  "appendChild", "insertBefore", "replaceChild", "append", "prepend", "before", "after", "replaceWith",
  "replaceChildren", "insertAdjacentElement", "moveBefore", "adoptNode",
]);
const SINK_NAMES = new Set(["eval", "Function", "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "importScripts", "clipboard"]);

/** An event handler's name (`onclick`, `onsubmit`): code that runs on the page's own events. */
const handler = (name: string) => name.length > 2 && name.slice(0, 2).toLowerCase() === "on";
export const sinkAttribute = (name: string) => SINK_ATTRIBUTES.has(name.toLowerCase()) || handler(name);

type N = Record<string, unknown> & { type: string };

/** A member's static name: `a.b`'s `b`, `a["b"]`'s `b`; undefined when it is named at run time. */
function staticName(m: N): string | undefined {
  const p = m.property as N;
  if (!m.computed && p.type === "Identifier") return p.name as string;
  if (m.computed && p.type === "Literal" && typeof p.value === "string") return p.value;
  if (!m.computed && p.type === "PrivateIdentifier") return p.name as string;
  return undefined;
}

const stringArg = (args: N[], i: number) => (args[i]?.type === "Literal" && typeof args[i]!.value === "string" ? (args[i]!.value as string) : undefined);

/** Why the script writes where a value could leave by, if it does (shapes.rs `writes`). */
export function writes(script: string, kind: Kind): string | undefined {
  const program = read(source(script, kind)) as unknown as N;
  let found: string | undefined;
  const say = (why: string) => void (found ??= why);
  const own = new Set<string>();

  const target = (t: N) => {
    if (t.type !== "MemberExpression") return;
    const name = staticName(t);
    if (name !== undefined && (SINK_PROPERTIES.has(name) || handler(name))) say(`it sets ${name}`);
    else if (name === undefined && t.computed) {
      const obj = t.object as N;
      if (!(obj.type === "Identifier" && own.has(obj.name as string))) say("it sets a property it names at run time");
    }
  };

  const visit = (node: unknown, parent?: N, field?: string): void => {
    if (Array.isArray(node)) return node.forEach((n) => visit(n, parent, field));
    if (!node || typeof node !== "object" || typeof (node as N).type !== "string") return;
    const n = node as N;
    switch (n.type) {
      case "Literal":
        if (typeof n.value === "string") {
          const part = revealingSelector(n.value);
          if (part) say(`it queries a field's state (${part})`);
        }
        break;
      case "TemplateElement": {
        const value = n.value as { cooked: string | null; raw: string };
        if (value.cooked === null || value.cooked === undefined) say("it holds a template string fleetd can't read");
        else {
          const part = revealingSelector(value.cooked) ?? revealingSelector(value.raw);
          if (part) say(`it queries a field's state (${part})`);
        }
        break;
      }
      case "Identifier": {
        // A reference only: not a property's name, a key, or a name being declared.
        const name = n.name as string;
        const isProperty = parent?.type === "MemberExpression" && field === "property" && !parent.computed;
        const isKey = parent?.type === "Property" && field === "key" && !parent.computed;
        const declared =
          (parent?.type === "VariableDeclarator" && field === "id") ||
          ((parent?.type === "FunctionDeclaration" || parent?.type === "FunctionExpression" || parent?.type === "ArrowFunctionExpression") &&
            (field === "id" || field === "params")) ||
          (parent?.type === "LabeledStatement" && field === "label");
        if (!isProperty && !isKey && !declared && SINK_NAMES.has(name)) say(`it uses ${name}`);
        break;
      }
      case "MemberExpression": {
        const name = !n.computed ? staticName(n) : undefined;
        if (name !== undefined && SINK_NAMES.has(name)) say(`it uses ${name}`);
        break;
      }
      case "AssignmentExpression":
        target(n.left as N);
        break;
      case "UpdateExpression":
        target(n.argument as N);
        break;
      case "CallExpression": {
        const callee = n.callee as N;
        const method = callee.type === "MemberExpression" ? staticName(callee) : undefined;
        const fn = callee.type === "Identifier" ? (callee.name as string) : undefined;
        const args = n.arguments as N[];
        if (method !== undefined && SINK_METHODS.has(method)) say(`it calls ${method}`);
        else if (method !== undefined && MOVES.has(method)) say(`it moves elements in the page (${method})`);
        else if (method === "setAttribute" || method === "removeAttribute" || method === "toggleAttribute" || method === "setAttributeNS") {
          const name = stringArg(args, method === "setAttributeNS" ? 1 : 0);
          if (name === undefined) say(`it calls ${method} with a name it makes at run time`);
          else if (sinkAttribute(name)) say(`it changes the ${name} attribute`);
        } else if (method === "setProperty" || method === "removeProperty") {
          const name = stringArg(args, 0) ?? "";
          if (!name.startsWith("--") && (name === "" || name.includes("security") || name === "filter")) say(`it calls ${method} on how a field shows`);
        } else if ((method === "assign" || method === "set") && callee.type === "MemberExpression") {
          const obj = callee.object as N;
          if (obj.type === "Identifier" && (obj.name === "Object" || obj.name === "Reflect")) say("it sets properties it names at run time");
        }
        const timer = fn ?? method;
        if ((timer === "setTimeout" || timer === "setInterval") && !(args[0]?.type === "ArrowFunctionExpression" || args[0]?.type === "FunctionExpression")) {
          say("it runs a string as code");
        }
        break;
      }
      case "VariableDeclarator": {
        const id = n.id as N;
        const init = n.init as N | null;
        if (id.type === "Identifier" && (init?.type === "ObjectExpression" || init?.type === "ArrayExpression")) own.add(id.name as string);
        break;
      }
      case "ImportExpression":
        say("it imports a module");
        break;
    }
    for (const [k, v] of Object.entries(n)) if (k !== "type" && v && typeof v === "object") visit(v, n, k);
  };
  visit(program);
  return found;
}

/** Why a sealed session refuses the script, if it does (shapes.rs `refusal`). */
export function refusal(script: string, kind: Kind): string | undefined {
  try {
    if (!pinned(script, kind)) return `it is not one of agent-browser ${PINNED_VERSION}'s own scripts`;
    return writes(script, kind);
  } catch (e) {
    return (e as Error).message;
  }
}
