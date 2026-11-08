// `fleetd agent-mcp`: the Rust module's own tests (crates/fleetd/src/cli/agent_mcp.rs), ported, and tools.json held
// to the Rust source. agent_mcp_parity.test.ts runs both binaries side by side.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_MCP_TOOLS } from "../src/gen/wire.ts";
import { callOf, handle, readArtifactPath, type LeadDeps } from "../src/cli/agent_mcp/index.ts";
import { rustJson } from "../src/cli/agent_mcp/json.ts";
import { browserResult, toolResult } from "../src/cli/agent_mcp/results.ts";
import { callerCwd, sendToNode } from "../src/cli/agent_mcp/socket.ts";
import { ALIASES, SNAPSHOT, toolList } from "../src/cli/agent_mcp/tools.ts";
import { main } from "../src/cli/index.ts";
import { tempHome } from "./helpers.ts";

const RUST_SOURCE = readFileSync(join(import.meta.dir, "../../../crates/fleetd/src/cli/agent_mcp.rs"), "utf8");

let home: ReturnType<typeof tempHome>;
beforeAll(() => {
  home = tempHome();
});
afterAll(() => home.done());

const names = (role: "lead" | "worker") => toolList(role).tools.map((t) => t.name);
const said = (result: unknown) => browserResult({ id: "1", result }).content[0]!.text as string;
const refusal = (fn: () => unknown) => {
  try {
    fn();
  } catch (why) {
    return String(why);
  }
  throw new Error("expected a refusal");
};

/** The string literals in the Rust source, decoded: `\` and a line break skip the next line's indent. */
function rustStrings(source: string): Set<string> {
  const out = new Set<string>();
  for (const m of source.matchAll(/"((?:[^"\\]|\\[\s\S])*)"/g)) {
    out.add(m[1]!.replace(/\\\n\s*/g, "").replace(/\\(["\\n])/g, (_, c: string) => (c === "n" ? "\n" : c)));
  }
  return out;
}

describe("tools.json is the Rust source's", () => {
  test("every tool in TOOLS' order, each description written there", () => {
    expect(SNAPSHOT.tools.map((t) => [t.name, t.op])).toEqual(AGENT_MCP_TOOLS.map((t) => [t.name, t.op]));
    const strings = rustStrings(RUST_SOURCE);
    const stale = SNAPSHOT.tools.filter((t) => !strings.has(t.description)).map((t) => t.name);
    // A description changed in agent_mcp.rs: run `bun src/cli/agent_mcp/snapshot.ts <Rust fleetd>`.
    expect(stale).toEqual([]);
  });

  test("the aliases are agent_mcp.rs's ALIASES", () => {
    const block = /pub const ALIASES[^=]*= &\[([\s\S]*?)\];/.exec(RUST_SOURCE)![1]!;
    expect([...block.matchAll(/\("(\w+)", "(\w+)"\)/g)].map((m) => [m[1], m[2]])).toEqual(ALIASES);
  });
});

describe("agent-mcp", () => {
  test("the lead names agents and to-dos as plain outcomes", () => {
    const description = (name: string) => toolList("lead").tools.find((t) => t.name === name)!.description;
    expect(description("spawn_agent")).toContain("title is what the human sees: a short plain outcome");
    expect(description("spawn_agent")).toContain("never an id, status or PR number");
    expect(description("checklist")).toContain("text is a short plain outcome");
    expect(description("checklist")).toContain("never a status, id or PR number");
  });

  test("session_start offers every kind but ios, and still takes an older lead's ios", () => {
    const kind = JSON.stringify((toolList("lead").tools.find((t) => t.name === "session_start")!.inputSchema as any).properties.kind);
    for (const offered of ["browser", "android", "linux_desktop", "mac"]) expect(kind).toContain(`"${offered}"`);
    expect(kind).not.toContain('"ios"');
    expect(callOf("lead", "session_start", { purpose: "p", kind: "ios" }).op).toBe("session_start");
  });

  test("an iOS session tells the agent to drive it with agent-device", () => {
    const started = said({ op: "session_start", sessionId: "B1", udid: "8A1B2C3D-0000-4000-8000-000000000002", startMs: 40 });
    expect(started.startsWith("iOS session B1 is open (40 ms)")).toBe(true);
    expect(started).toContain("pass no --udid");
    const ended = said({
      op: "session_end", sessionId: "B1", kind: "ios",
      files: [{ file: "actions", bytes: 10 }, { file: "video_mp4", bytes: 900 }],
    });
    expect(ended).toBe(
      "iOS session B1 ended; the simulator and everything done in it are gone. Its recording (actions, video_mp4) goes to the hub.",
    );
  });

  test("a worker sees only report, ask_lead, its brief, CI, decisions, reviews, images, artifacts and browser", () => {
    expect(names("worker")).toEqual([
      "decisions_search", "report", "ask_lead", "brief_read", "wait_ci", "review_read", "chat_file", "publish_artifact",
      "artifact_read", "session_start", "desktop", "session_end", "request_takeover", "fill_credential",
    ]);
    const lead = names("lead");
    for (const tool of [
      "spawn_agent", "message_agent", "agents", "stop_agent", "request_secret", "decide", "brief", "close", "gated_run",
      "remember", "forget", "memory_read", "nudge", "checklist", "skill_install", "skill_save", "project_message",
      "factory_status", "chat_search", "chat_read", "confirm_step", "review_read", "chat_file", "publish_artifact",
      "artifact_read",
    ]) {
      expect(lead).toContain(tool);
    }
    // Gone from the list, still answered for an older lead or skill that names them.
    for (const [gone] of ALIASES) expect(lead).not.toContain(gone);
    expect(callOf("worker", "chat_image", { path: "shot.png" })).toEqual({ op: "chat_file", path: "shot.png" });
    expect(callOf("lead", "automation_pause", { automationId: "au_k3Jd8sQp2xYz", paused: true })).toEqual({
      op: "automation_update", automationId: "au_k3Jd8sQp2xYz", paused: true,
    });
    refusal(() => callOf("worker", "automation_pause", {}));
    expect(lead).not.toContain("report");
    expect(lead).not.toContain("ask_lead");
    // A worker calling a lead's tool by name gets nothing sent.
    expect(refusal(() => callOf("worker", "spawn_agent", {}))).toBe("No tool spawn_agent here.");
  });

  test("a publish with a path sends the file's text in its format", () => {
    mkdirSync(join(home.dir, "out"), { recursive: true });
    writeFileSync(join(home.dir, "out/sweep.html"), "<h1>Sweep</h1>");
    const call = callOf("worker", "publish_artifact", { name: "sweep-report", title: "Sweep", path: "out/sweep.html" });
    readArtifactPath(call, home.dir);
    expect(call.content).toBe("<h1>Sweep</h1>");
    expect(call.format).toBe("html");
    // A format the call names wins over the extension.
    const md: Record<string, unknown> = { op: "artifact_publish", name: "a", title: "A", format: "md", path: "out/sweep.html" };
    readArtifactPath(md, home.dir);
    expect(md.format).toBe("md");
    const missing = { op: "artifact_publish", name: "a", title: "A", path: "nope.md" };
    expect(refusal(() => readArtifactPath(missing, home.dir))).toBe("Can't read nope.md: No such file or directory (os error 2).");
    // Other calls pass through untouched.
    const other = { op: "chat_file", path: "nope.png" };
    readArtifactPath(other, home.dir);
    expect(other).toEqual({ op: "chat_file", path: "nope.png" });
  });

  test("every tool is one lead call with an object schema", () => {
    for (const role of ["lead", "worker"] as const) {
      for (const tool of toolList(role).tools) {
        expect(tool.inputSchema.type).toBe("object");
        expect(JSON.stringify(tool.inputSchema)).not.toContain("$ref");
      }
    }
    expect(callOf("lead", "spawn_agent", { workstreamId: "W1", title: "t", prompt: "p" }).op).toBe("task_spawn");
    expect(refusal(() => callOf("lead", "spawn_agent", { workstreamId: "W1" }))).toStartWith("Invalid arguments for spawn_agent");
    const brief = { goal: "g", why: "w", pointers: [], constraints: [], doneWhen: ["d"] };
    expect(refusal(() => callOf("lead", "brief", { brief }))).toContain("or text to open one");
    expect(callOf("worker", "ask_lead", { question: "Postgres?" })).toEqual({ op: "ask_lead", question: "Postgres?" });
    expect(callOf("worker", "brief_read", {})).toEqual({ op: "brief_read" });
    expect(callOf("worker", "review_read", { pr: "#7" })).toEqual({ op: "review_read", pr: "#7" });
    expect(callOf("worker", "decisions_search", { query: "D152" })).toEqual({ op: "decisions_search", query: "D152" });
  });

  test("arguments are refused in serde's words, field by field, then the struct's rule", () => {
    const why = (name: string, args: unknown, role: "lead" | "worker" = "lead") => refusal(() => callOf(role, name, args));
    expect(why("spawn_agent", {})).toBe("Invalid arguments for spawn_agent: missing field `workstreamId`.");
    expect(why("spawn_agent", { title: 5 })).toBe("Invalid arguments for spawn_agent: invalid type: integer `5`, expected a string.");
    expect(why("agents", { state: "zzz" })).toBe(
      "Invalid arguments for agents: unknown variant `zzz`, expected one of `queued`, `running`, `idle`, `done`, `failed`, `cancelled`.",
    );
    expect(why("agents", [1])).toBe("The arguments must be an object.");
    expect(why("spawn_agent", { workstreamId: "X1", title: "t", prompt: "p" })).toBe(
      'Invalid arguments for spawn_agent: expected a string matching ^W[1-9][0-9]*$, got "X1".',
    );
    expect(why("spawn_agent", { workstreamId: "W1", title: "a\nb", prompt: "p" })).toBe(
      "Invalid arguments for spawn_agent: expected a single line.",
    );
    expect(why("spawn_agent", { workstreamId: "W1", title: "t", prompt: "p", qa: true })).toBe(
      "Invalid arguments for spawn_agent: --qa applies only to --kind review.",
    );
    expect(why("remember", { scope: "user", text: "a", topic: "memory" })).toBe(
      'Invalid arguments for remember: expected a lowercase slug, [a-z0-9][a-z0-9-]{0,47}, other than memory, got "memory".',
    );
    expect(why("checklist", { items: [{}] })).toBe("Invalid arguments for checklist: a new item needs text.");
    expect(why("session_start", { purpose: "x", kind: "zzz" })).toBe(
      "Invalid arguments for session_start: unknown variant `zzz`, expected one of `browser`, `android`, `ios`, `linux_desktop`, `mac`.",
    );
    expect(why("desktop", { action: "wait", coordinate: [1, 2, 3] })).toBe(
      "Invalid arguments for desktop: invalid length 3, expected 2 elements in sequence.",
    );
    // An Option field takes null as absent; unknown fields are left for the hub.
    expect(callOf("lead", "agents", { taskId: null, extra: 1 })).toEqual({ op: "task_list", taskId: null, extra: 1 });
  });

  test("report is a verdict the hub completes", () => {
    expect(callOf("worker", "report", { blocking: 0, nonBlocking: 1, summary: "ok" })).toEqual({
      op: "review_verdict", blocking: 0, nonBlocking: 1, summary: "ok",
    });
    const schema = toolList("worker").tools.find((t) => t.name === "report")!.inputSchema as any;
    for (const field of ["taskId", "prHeadSha"]) expect(schema.properties[field]).toBeUndefined();
  });

  test("a result is compact and never echoes the prompt back", () => {
    const text = toolResult({
      t: "lead_result", id: "x",
      result: { op: "task_spawn", task: { taskId: "T3", prompt: "a long brief", state: "running" }, next: "T2 is writing too." },
    }).content[0]!.text as string;
    expect(text).not.toContain("\n");
    expect(text).not.toContain("prompt");
    expect(JSON.parse(text).task.taskId).toBe("T3");
    expect(JSON.parse(text).next).toBe("T2 is writing too.");
  });

  test("calls go through the node socket with the session named", async () => {
    const sent: Record<string, unknown>[] = [];
    const deps: LeadDeps = {
      pwd: undefined, sock: "/n.sock", thread: "s1", cwd: "/work/p",
      send: async (socket, frame) => {
        sent.push({ socket, ...frame });
        return {
          t: "lead_result", id: "x",
          error: { code: "forbidden", message: "T3 is a task, and a task's agent can't start agents.", fix: "Do this work yourself." },
        };
      },
    };
    const message = {
      jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "ask_lead", arguments: { question: "Which DB?" } },
    };
    const answer = (await handle("worker", message, deps)) as any;
    expect(sent).toEqual([{
      socket: "/n.sock", t: "lead_call", id: `cli-${process.pid}`, cwd: "/work/p", threadId: "s1",
      call: { op: "ask_lead", question: "Which DB?" },
    }]);
    expect(answer.id).toBe(7);
    expect(answer.result.isError).toBe(true);
    expect(answer.result.content[0].text).toBe(
      "Refused: T3 is a task, and a task's agent can't start agents.\nNext: Do this work yourself.",
    );
    expect(await handle("worker", { jsonrpc: "2.0", method: "notifications/initialized" }, deps)).toBeUndefined();
    // A browser tool goes as a browser call, which the node answers itself.
    await handle("worker", { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "session_end" } }, deps);
    expect(sent[1]!.t).toBe("browser_call");
  });

  test("talks to a node socket and says when none listens", async () => {
    const socket = join(home.dir, "node.sock");
    const down = await sendToNode(socket, {}, 5000).catch((why: string) => why);
    expect(down).toStartWith(`fleetd hub unreachable: no fleetd node is listening at ${socket}`);
    let got: unknown;
    const server = Bun.listen({
      unix: socket,
      socket: {
        data(conn, data) {
          const frame = JSON.parse(data.toString());
          got = frame;
          conn.write(`${JSON.stringify({ t: "lead_result", id: frame.id, result: { op: "decisions_search", decisions: [] } })}\n`);
        },
      },
    });
    try {
      const frame = { t: "lead_call", id: "cli-1", cwd: "/w", call: { op: "decisions_search", query: "health" } };
      const answer = await sendToNode(socket, frame, 5000);
      expect(got).toEqual(frame);
      expect((answer.result as any).op).toBe("decisions_search");
    } finally {
      server.stop(true);
    }
  });

  test("a node that never answers times out", async () => {
    const socket = join(home.dir, "slow.sock");
    const server = Bun.listen({ unix: socket, socket: { data() {} } });
    try {
      expect(await sendToNode(socket, {}, 50).catch((why: string) => why)).toBe(
        "the fleetd node did not answer within 0 s; the call may or may not have gone through — try again shortly",
      );
    } finally {
      server.stop(true);
    }
  });

  test("caller_cwd keeps the shell's logical path", () => {
    const real = join(home.dir, "real");
    const link = join(home.dir, "link");
    mkdirSync(join(real, "src"), { recursive: true });
    symlinkSync(real, link);
    const realSrc = realpathSync(join(real, "src"));
    const linkSrc = `${link}/src`;
    expect(callerCwd(linkSrc, realSrc)).toBe(linkSrc);
    expect(callerCwd(`${link}/./src/`, realSrc)).toBe(`${linkSrc}/`);
    expect(callerCwd(undefined, realSrc)).toBe(realSrc);
    expect(callerCwd("link", realSrc)).toBe(realSrc);
    expect(callerCwd(link, realSrc)).toBe(realSrc);
  });

  test("a desktop screenshot comes back as an image", () => {
    const shot = browserResult({
      result: { op: "desktop", message: "The screen, 1280x800.", jpegB64: "/9j/AA==", width: 1280, height: 800 },
    });
    expect(shot.isError).toBe(false);
    expect(shot.content[0]).toEqual({ type: "image", data: "/9j/AA==", mimeType: "image/jpeg" });
    expect(shot.content[1]!.text).toBe("The screen, 1280x800.");
    expect(browserResult({ result: { op: "desktop", message: "left_click at (1, 2)." } }).content).toHaveLength(1);
    const started = said({ op: "session_start", sessionId: "B0", desktop: "xvfb", startMs: 2 });
    expect(started).toStartWith("Desktop session B0 is open (2 ms)");
    expect(started).toContain("desktop tool");
    const contained = said({ op: "session_start", sessionId: "B1", desktop: "container", worktree: "/work/app", startMs: 900 });
    expect(contained).toContain("your worktree /work/app is in it read-only");
    expect(contained).toContain("write in /home/desktop or /tmp");
  });

  test("JSON comes out as serde_json writes a Value: keys sorted at every depth", () => {
    expect(rustJson({ b: 1, a: { "9": 0, "10": [null, { z: "é\u0001", y: 1.5 }] } })).toBe(
      '{"a":{"10":[null,{"y":1.5,"z":"é\\u0001"}],"9":0},"b":1}',
    );
  });

  test("a bad role prints the usage and exits 2", async () => {
    expect(await main(["agent-mcp", "--role", "admin"])).toBe(2);
  });
});
