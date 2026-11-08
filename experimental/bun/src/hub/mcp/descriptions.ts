// Tool descriptions in tools/list, word for word as older hubs listed them: read from the Rust hub's own table
// (crates/fleetd/src/hub/mcp/descriptions.rs), embedded in the binary, so the two never drift.
import source from "../../../../../crates/fleetd/src/hub/mcp/descriptions.rs" with { type: "text" };

/** A Rust string literal's body: `\"`, `\\`, `\n` and a line continuation, the escapes the table can hold. */
function unescape(body: string): string {
  return body.replace(/\\(\n\s*|.)/g, (_, c: string) => {
    if (c.startsWith("\n")) return "";
    return c === "n" ? "\n" : c === "t" ? "\t" : c;
  });
}

/** `[name, description]`, in the table's order. */
export const DESCRIPTIONS: [name: string, description: string][] = [
  ...source.matchAll(/\(\s*"((?:[^"\\]|\\.)*)",\s*"((?:[^"\\]|\\[\s\S])*)",?\s*\)/g),
].map((m) => [unescape(m[1] ?? ""), unescape(m[2] ?? "")]);
