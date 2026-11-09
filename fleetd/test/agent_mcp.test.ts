// `fleetd agent-mcp`: the tools each role lists, the calls each makes, and how it answers.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_MCP_TOOLS } from "../src/shared/wire_tags.ts";
import { callOf, handle, readArtifactPath, type LeadDeps } from "../src/cli/agent_mcp/index.ts";
import { rustJson } from "../src/cli/agent_mcp/json.ts";
import { browserResult, toolResult } from "../src/cli/agent_mcp/results.ts";
import { callerCwd, sendToNode } from "../src/cli/agent_mcp/socket.ts";
import { ALIASES, SNAPSHOT, toolList } from "../src/cli/agent_mcp/tools.ts";
import { main } from "../src/cli/index.ts";
import { HUB_UNREACHABLE } from "../src/node/lead/index.ts";
import { tempHome } from "./helpers.ts";

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

test("tools.json lists every tool in AGENT_MCP_TOOLS' order, each with a description", () => {
  expect(SNAPSHOT.tools.map((t) => [t.name, t.op])).toEqual(AGENT_MCP_TOOLS.map((t) => [t.name, t.op]));
  expect(SNAPSHOT.tools.filter((t) => t.description.trim() === "").map((t) => t.name)).toEqual([]);
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

  test("a worker sees only report, ask_lead, its brief, agents, CI, decisions, reviews, images, artifacts and browser", () => {
    expect(names("worker")).toEqual([
      "agents", "decisions_search", "report", "ask_lead", "brief_read", "agent_message", "wait_ci", "review_read", "chat_file", "publish_artifact",
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

  /** A node answering one `decisions_search` frame at `socket`, once it binds `afterMs` from now. */
  function nodeAnswering(socket: string, afterMs: number) {
    let server: ReturnType<typeof Bun.listen> | undefined;
    const got = new Promise<unknown>((resolve) =>
      setTimeout(() => {
        server = Bun.listen({
          unix: socket,
          socket: {
            data(conn, data) {
              const frame = JSON.parse(data.toString());
              resolve(frame);
              conn.write(`${JSON.stringify({ t: "lead_result", id: frame.id, result: { op: "decisions_search", decisions: [] } })}\n`);
            },
          },
        });
      }, afterMs),
    );
    return { got, stop: () => server?.stop(true) };
  }

  const frame = { t: "lead_call", id: "cli-1", cwd: "/w", call: { op: "decisions_search", query: "health" } };

  test("talks to a node socket", async () => {
    const socket = join(home.dir, "up.sock");
    const node = nodeAnswering(socket, 0);
    try {
      const answer = await sendToNode(socket, frame, 5000);
      expect(await node.got).toEqual(frame);
      expect((answer.result as any).op).toBe("decisions_search");
    } finally {
      node.stop();
    }
  });

  // A node restarting for an update has no socket for a moment: the call waits for it and is answered.
  test("a call waits for a restarting node", async () => {
    const socket = join(home.dir, "restart.sock");
    const node = nodeAnswering(socket, 1000);
    try {
      const answer = await sendToNode(socket, frame, 5000);
      expect(await node.got).toEqual(frame);
      expect((answer.result as any).op).toBe("decisions_search");
    } finally {
      node.stop();
    }
  });

  // A node that doesn't come back within the wait (here a short one, 20 s for real): the call says fleetd is
  // restarting, without the "carry on" a call that may have run gets.
  test("a node that stays down is reported restarting", async () => {
    const socket = join(home.dir, "down.sock");
    const started = Date.now();
    const down = await sendToNode(socket, {}, 5000, 1000).catch((why: string) => why);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
    expect(down).toBe(
      `fleetd is restarting; try again (no fleetd node is listening at ${socket}; set FLEETD_NODE_SOCK if it is elsewhere)`,
    );
    const deps: LeadDeps = { pwd: undefined, sock: undefined, thread: undefined, cwd: home.dir, send: async () => { throw down; } };
    const call = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "decisions_search", arguments: { query: "x" } } };
    const answer: any = await handle("lead", call, deps);
    expect(answer.result.content[0].text).toBe(down);
  });

  // The node relaying a call while the hub restarts says so, not that the call was refused.
  test("a restarting hub is no refusal", () => {
    const answer = toolResult({ t: "lead_result", id: "cli-1", error: { code: "machine_offline", message: HUB_UNREACHABLE } });
    expect(answer.content[0]!.text).toBe("fleetd hub is restarting; try again shortly");
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
