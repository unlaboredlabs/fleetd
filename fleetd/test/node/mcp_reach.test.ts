// An agent's MCP servers reached by address, looked at before its claude starts (src/node/mcp_reach.ts, W818): one that
// answers at all is kept, one that refuses or never answers is left out, all are looked at side by side, and the agent
// is told in a note that has it mention it once, inside its reply to the person. Servers here are this test's own.
import { afterAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:net";
import { addressed, backLine, reaches, skippedLine, skippedNote, startChange, unanswered, without } from "../../src/node/mcp_reach.ts";

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

test("a start's change from the one before: newly down, and back only when looked at again and answering", () => {
  const all = ["docs", "crm", "a", "b"];
  // Down, still down (nothing), back.
  expect(startChange([], ["docs"], all)).toEqual({ down: ["docs"], back: [] });
  expect(startChange(["docs"], ["docs"], all)).toEqual({ down: [], back: [] });
  expect(startChange(["docs"], [], all)).toEqual({ down: [], back: ["docs"] });
  // Only some back; one more down besides one still down.
  expect(startChange(["a", "b"], ["a"], all)).toEqual({ down: [], back: ["b"] });
  expect(startChange(["a"], ["a", "b"], all)).toEqual({ down: ["b"], back: [] });
  // The review of #2090: "docs" said down, then removed (never back), then re-added and still down (down again).
  expect(startChange(["docs"], [], ["crm"])).toEqual({ down: [], back: [] });
  expect(startChange([], ["docs"], ["crm", "docs"])).toEqual({ down: ["docs"], back: [] });
  expect(skippedLine(["docs"])).toBe("The MCP server “docs” didn't answer, so its tools are off until the next start.");
  expect(backLine(["a", "b"])).toBe("The MCP servers “a” and “b” answer again: their tools are back.");
});
