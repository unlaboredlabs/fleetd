// An agent's MCP servers reached by address, looked at before its claude starts (src/node/mcp_reach.ts, W818): one that
// answers at all is kept, one that refuses or never answers is left out, all are looked at side by side, and the agent
// is told in a note that has it mention it once, inside its reply to the person. Servers here are this test's own.
import { afterAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { addressed, changeLine, reaches, saidSet, skippedNote, skipSource, unanswered, without } from "../../src/node/mcp_reach.ts";

const servers: { stop(): void }[] = [];
afterAll(() => {
  for (const s of servers) s.stop();
});

/** An address that answers HTTP (a 404 here: any answer counts). */
function answering(): string {
  const s = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("no such thing", { status: 404 }) });
  servers.push({ stop: () => s.stop(true) });
  return `http://127.0.0.1:${s.port}/mcp`;
}

/** An address that takes the connection and never says anything: what a server behind a dead route looks like. */
async function silent(): Promise<string> {
  const held: import("node:net").Socket[] = [];
  const s: Server = createServer((c) => void held.push(c));
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  servers.push({ stop: () => (held.forEach((c) => c.destroy()), s.close()) });
  return `http://127.0.0.1:${(s.address() as { port: number }).port}/mcp`;
}

/** An address nothing listens on. */
async function refused(): Promise<string> {
  const s = createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as { port: number }).port;
  await new Promise<void>((r) => s.close(() => r()));
  return `http://127.0.0.1:${port}/mcp`;
}

test("only servers reached by address are looked at: http and sse, never a stdio one (fleetd's own, a relay)", () => {
  const servers = {
    docs: { type: "http", url: "https://docs.example/mcp" },
    old: { type: "sse", url: "https://old.example/sse" },
    relay: { type: "stdio", command: "fleetd", args: ["mcp-relay", "--server", "x"] },
    fleetd: { type: "stdio", command: "fleetd", args: ["agent-mcp"] },
    blank: { type: "http", url: "" },
  };
  expect(addressed(servers)).toEqual([
    { name: "docs", url: "https://docs.example/mcp" },
    { name: "old", url: "https://old.example/sse" },
  ]);
  expect(Object.keys(without(servers, ["docs", "old"]))).toEqual(["relay", "fleetd", "blank"]);
});

test("a server that answers, whatever its status, is reached; one that refuses or never answers isn't", async () => {
  expect(await reaches(answering(), 2_000)).toBe(true);
  expect(await reaches(await refused(), 2_000)).toBe(false);
  expect(await reaches(await silent(), 300)).toBe(false);
});

test("the servers are looked at side by side: several silent ones cost about one's wait, not their sum", async () => {
  const one = { a: { type: "http", url: await silent() } };
  const three = { a: { type: "http", url: await silent() }, b: { type: "http", url: await silent() }, c: { type: "http", url: await silent() }, ok: { type: "http", url: answering() } };
  const look = (u: string) => reaches(u, 400);
  let began = performance.now();
  expect(await unanswered(one, look)).toEqual(["a"]);
  const single = performance.now() - began;
  began = performance.now();
  expect((await unanswered(three, look)).sort()).toEqual(["a", "b", "c"]);
  const all = performance.now() - began;
  expect(all / single).toBeLessThan(2);
});

test("the note names each server left out, and has the agent tell the person once, inside its reply", () => {
  const note = skippedNote(["devbox-tailnet"]);
  expect(note).toContain("“devbox-tailnet”");
  expect(note).toContain("didn't answer within 3 s");
  expect(note).toContain("Mention this once, in one plain line, inside your reply the next time the person writes");
  expect(note).toContain("Never send it as a message of its own");
  expect(skippedNote(["a", "b"])).toContain("the MCP servers “a” and “b”: they didn't answer");
});

test("a bot's chat says only a change of its left-out servers, and the line's source keeps the set it said", () => {
  // Said once while down, once when back, once more for another set; the same set, in any order, says nothing.
  expect(changeLine(undefined, [])).toBeUndefined();
  expect(changeLine(undefined, ["x"])).toBe("The MCP server “x” didn't answer, so its tools are off until the next start.");
  expect(changeLine(["x"], ["x"])).toBeUndefined();
  expect(changeLine(["x"], [])).toBe("The MCP server “x” answers again: its tools are back.");
  expect(changeLine([], [])).toBeUndefined();
  expect(changeLine(["b", "a"], ["a", "b"])).toBeUndefined();
  expect(changeLine(["x"], ["y"])).toBe("The MCP server “y” didn't answer, so its tools are off until the next start.");
  expect(changeLine(["a", "b"], [])).toBe("The MCP servers “a” and “b” answer again: their tools are back.");
  // Only some back: those, and the ones still down aren't said again.
  expect(changeLine(["a", "b"], ["a"])).toBe("The MCP server “b” answers again: its tools are back.");
  // One more down besides one still down: the whole set, once.
  expect(changeLine(["a"], ["a", "b"])).toBe("The MCP servers “a” and “b” didn't answer, so their tools are off until the next start.");
  // A server said down that the start no longer looked at (removed, renamed, now stdio) is never said to answer again.
  expect(changeLine(["docs"], [], [])).toBeUndefined();
  expect(changeLine(["docs", "crm"], [], ["crm"])).toBe("The MCP server “crm” answers again: its tools are back.");
  expect(changeLine(["docs"], [], ["docs"])).toBe("The MCP server “docs” answers again: its tools are back.");
  // The set round-trips through a source, odd names included; another source says no set.
  expect(saidSet(skipSource(["b", "a:1", "c,d"], "t1:2026"))).toEqual(["a:1", "b", "c,d"]);
  expect(saidSet(skipSource([], "t1:2026"))).toEqual([]);
  expect(saidSet("unanswered:m1")).toBeUndefined();
  expect(saidSet(undefined)).toBeUndefined();
});
