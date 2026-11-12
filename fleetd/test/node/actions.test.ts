// The node's calls outside sessions, and what a session's start takes from them, over the session service and the
// fake session host: MCP servers' secrets, their Test over stdio, HTTP and SSE, and their place in a session's
// `--mcp-config`; skills listed and given as a plugin; a session on a Claude account; the landed log; a clone with its
// progress; `gh repo list` through a stand-in gh; an agent's image; a project's sign-ins forgotten.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseProgress } from "../../src/node/actions/clone.ts";
import { frontmatter } from "../../src/node/actions/skills.ts";
import { loadOrCreateBoxKey } from "../../src/node/identity.ts";
import { oldProfilesDir } from "../../src/node/own_homes.ts";
import { SessionService } from "../../src/node/sessions/index.ts";
import type { NodeFrame } from "../../src/node/wire.ts";
import { tempHome } from "../helpers.ts";

const home = tempHome();
const nodeHome = join(home.dir, "node");
const repo = join(home.dir, "repo");
const boxKey = loadOrCreateBoxKey(nodeHome);
const sealed = (value: string) => Buffer.from(boxKey.seal(Buffer.from(value))).toString("base64");
const frames: NodeFrame[] = [];
let service: SessionService;
let calls = 0;
const call = (op: string, args: Record<string, unknown> = {}) => service.handle({ id: `c${++calls}`, call: { op, ...args } as never });
const ok = async (op: string, args: Record<string, unknown> = {}) => {
  const reply = await call(op, args);
  if (!("ok" in reply.result)) throw new Error(`${op}: ${JSON.stringify(reply.result)}`);
  return reply.result.ok as Record<string, any>;
};
const gitIn = (dir: string, ...args: string[]) => {
  const out = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...args], { encoding: "utf8" });
  if (out.status !== 0) throw new Error(out.stderr);
  return out.stdout.trim();
};
const put = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};
const until = async <T>(what: string, fn: () => T | undefined, ms = 5000): Promise<T> => {
  const end = Date.now() + ms;
  for (;;) {
    const got = fn();
    if (got !== undefined && got !== false) return got;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(20);
  }
};
const TOKEN = "s3cret-token-value";

beforeAll(async () => {
  mkdirSync(repo, { recursive: true });
  gitIn(repo, "init", "-q", "-b", "main");
  gitIn(repo, "commit", "-q", "--allow-empty", "-m", "init");
  // The node's host: records each start's argv and environment, then plays the fake session host.
  const host = join(home.dir, "host.sh");
  writeFileSync(host, `#!/bin/sh\nprintf '%s\\n' "$@" > "$2.argv"\nenv > "$2.env"\nexec "${join(import.meta.dir, "fake-host.sh")}" "$@"\n`);
  chmodSync(host, 0o755);
  service = await SessionService.start({
    home: nodeHome,
    claudeEnv: join(home.dir, "claude.env"),
    baseEnv: { HOME: home.dir, PATH: process.env.PATH ?? "/usr/bin:/bin", BUN_BIN: process.execPath, ANTHROPIC_API_KEY: "machine-key" },
    claudeBin: "/bin/true",
    fleetd: [host],
    boxKey,
  });
  service.attach((f) => frames.push(f));
  await ok("project_upsert", { projectId: "p1", title: "demo", workspaceRoot: repo });
});

afterAll(async () => {
  await service.stopAll();
  home.done();
});

/** A stdio MCP server as a shell script: answers initialize and tools/list once its TOKEN is right, else says why on
 * stderr, printing the token, and exits (the Rust probe's test server). */
function script(): { type: "stdio"; command: string; args: string[] } {
  const init = JSON.stringify({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake-mcp", version: "1.2.0" } } });
  const list = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    result: { tools: [{ name: "search", description: "Searches the docs.\nMore lines.", inputSchema: {}, annotations: { readOnlyHint: true } }, { name: "fetch", inputSchema: {} }] },
  });
  const path = join(home.dir, "fake-mcp");
  writeFileSync(
    path,
    `#!/bin/sh\nif [ "$TOKEN" != "${TOKEN}" ]; then echo "bad token: $TOKEN, want ${TOKEN}" >&2; exit 2; fi\n` +
      `echo 'starting' >&2\nread l\necho 'not json'\nprintf '%s\\n' '${init}'\nread l\nread l\nprintf '%s\\n' '${list}'\nread l\n`,
  );
  return { type: "stdio", command: "sh", args: [path] };
}
const TOOLS = [
  { name: "search", description: "Searches the docs.", readOnly: true },
  { name: "fetch" },
];
const server = (transport: Record<string, unknown>, values: Record<string, unknown>[] = [{ kind: "secret", name: "TOKEN" }]) => ({
  name: "fake",
  secrets: { kind: "global" },
  roles: { lead: true, writers: false, reviewers: false },
  transport,
  ...(transport.type === "stdio" ? { env: values } : { headers: values }),
});

test("an MCP server's secrets are kept sealed in the Rust node's file, kept or replaced all at once", async () => {
  const missing = await ok("mcp_test", { server: server(script()) });
  expect(missing).toEqual({ kind: "mcp_tested", tools: [], error: "this machine doesn't hold its TOKEN: save the server again" });
  const saved = await ok("mcp_secrets", { scope: { kind: "global" }, server: "fake", set: [{ field: "env", name: "TOKEN", sealed: sealed(TOKEN) }] });
  expect(saved.secrets).toEqual([{ field: "env", name: "TOKEN", fingerprint: expect.stringMatching(/^[0-9a-f]{8}$/) }]);
  const file = join(nodeHome, "mcp-secrets", "global.json");
  expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ servers: { fake: { "env/TOKEN": { value: TOKEN } } } });
  expect(statSync(file).mode & 0o777).toBe(0o600);
  // A header with a line break is refused, and nothing changes.
  const broken = await call("mcp_secrets", { scope: { kind: "global" }, server: "fake", set: [{ field: "header", name: "X", sealed: sealed("a\nb") }], keep: [] });
  expect(broken.result).toMatchObject({ err: { code: "invalid", message: "fake's header X holds a line break" } });
  expect(JSON.parse(readFileSync(file, "utf8")).servers.fake["env/TOKEN"].value).toBe(TOKEN);
  const keptOnly = await ok("mcp_secrets", { scope: { kind: "global" }, server: "fake", keep: [{ field: "env", name: "TOKEN" }] });
  expect(keptOnly.secrets).toEqual(saved.secrets);
  expect((await call("mcp_secrets", { scope: { kind: "project", projectId: "nope" }, server: "x" })).result).toMatchObject({ err: { code: "not_found" } });
});

test("an MCP server's Test lists its tools over stdio, and masks the token a failing one prints", async () => {
  expect(await ok("mcp_test", { projectId: "p1", server: server(script()) })).toEqual({ kind: "mcp_tested", server: "fake-mcp 1.2.0", tools: TOOLS });
  await ok("mcp_secrets", { scope: { kind: "project", projectId: "p1" }, server: "fake", set: [{ field: "env", name: "TOKEN", sealed: sealed("wrong-token-value") }] });
  const wrong = await ok("mcp_test", { server: { ...server(script()), secrets: { kind: "project", projectId: "p1" } } });
  expect(wrong.error).toBe("the server exited before it answered (exit 2): bad token: ***fake.TOKEN***, want s3cret-token-value");
  const nowhere = await ok("mcp_test", { server: server({ type: "stdio", command: "fleetd-no-such-server" }, []) });
  expect(nowhere.error).toContain("fleetd-no-such-server was not found");
});

test("an MCP server's Test speaks streamable HTTP and SSE with its headers, and says what a 401 wants", async () => {
  const answer = (body: Record<string, any>) =>
    body.method === "initialize"
      ? { jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "fake-mcp", version: "1.2.0" } } }
      : { jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "search", description: "Searches the docs.", annotations: { readOnlyHint: true } }, { name: "fetch" }] } };
  const streams: ReadableStreamDefaultController<string>[] = [];
  const http = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) return new Response("no", { status: 401 });
      if (url.pathname === "/mcp") {
        const body = (await req.json()) as Record<string, any>;
        if (body.id === undefined) return new Response(null, { status: 202 });
        // The second answer as an event stream, as streamable HTTP allows.
        if (body.method === "tools/list") return new Response(`event: message\ndata: ${JSON.stringify(answer(body))}\n\n`, { headers: { "content-type": "text/event-stream" } });
        return Response.json(answer(body), { headers: { "mcp-session-id": "sess-1" } });
      }
      if (url.pathname === "/sse")
        return new Response(
          new ReadableStream<string>({
            start(c) {
              streams.push(c);
              c.enqueue("event: endpoint\ndata: /messages?s=1\n\n");
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      const body = (await req.json()) as Record<string, any>;
      if (body.id !== undefined) streams.at(-1)!.enqueue(`event: message\ndata: ${JSON.stringify(answer(body))}\n\n`);
      return new Response("Accepted", { status: 202 });
    },
  });
  try {
    await ok("mcp_secrets", { scope: { kind: "global" }, server: "fake", set: [{ field: "header", name: "Authorization", sealed: sealed(`Bearer ${TOKEN}`) }] });
    const headers = [{ kind: "secret", name: "Authorization" }];
    expect(await ok("mcp_test", { server: server({ type: "http", url: `http://127.0.0.1:${http.port}/mcp` }, headers) })).toEqual({ kind: "mcp_tested", server: "fake-mcp 1.2.0", tools: TOOLS });
    expect(await ok("mcp_test", { server: server({ type: "sse", url: `http://127.0.0.1:${http.port}/sse` }, headers) })).toEqual({ kind: "mcp_tested", server: "fake-mcp 1.2.0", tools: TOOLS });
    const bare = await ok("mcp_test", { server: server({ type: "http", url: `http://127.0.0.1:${http.port}/mcp` }, []) });
    expect(bare.error).toBe("the server wants credentials (HTTP 401): a key, or signing in");
  } finally {
    http.stop(true);
  }
});

test("a session gets its role's MCP servers, its skills as a plugin and its Claude account, all masked", async () => {
  put(join(repo, ".agents/skills/release/SKILL.md"), "---\nname: release\ndescription: agents copy\n---\n");
  put(join(repo, ".agents/skills/release/.cache/x"), "left out");
  put(join(repo, ".claude/skills/triage/SKILL.md"), "---\nname: triage\ndescription: >\n  Claude\n  copy.\n---\n");
  put(join(repo, ".claude/skills/Not_A_Name/SKILL.md"), "---\ndescription: skipped\n---\n");
  expect(await ok("skills_list", { projectId: "p1" })).toEqual({
    kind: "skills",
    skills: [
      { name: "release", origin: "repo_agents", description: "agents copy", path: ".agents/skills/release/SKILL.md" },
      { name: "triage", origin: "repo_claude", description: "Claude copy.", path: ".claude/skills/triage/SKILL.md" },
    ],
  });
  await ok("claude_account_secret", { account: { kind: "person", personId: "p_aaaaaaaa" }, set: { sealed: sealed("tok-alice-0123") } });
  await ok("mcp_secrets", { scope: { kind: "global" }, server: "fake", set: [{ field: "env", name: "TOKEN", sealed: sealed(TOKEN) }] });
  const fake = server(script());
  const writersOnly = { ...server(script()), name: "writers-only", roles: { lead: false, writers: true, reviewers: false } };
  const ownName = { ...server(script()), name: "fleetd" };
  await ok("launch", {
    sessionId: "s1",
    projectId: "p1",
    runtimeMode: "full-access",
    workspace: { type: "root" },
    prompt: `hello ${TOKEN} and tok-alice-0123`,
    runId: "r1",
    role: "lead",
    mcpRole: "lead",
    mcp: { userServers: false, servers: [fake, writersOnly, ownName] },
    skills: [
      { name: "triage", origin: "project", files: [{ path: "SKILL.md", text: "---\nname: triage\ndescription: project copy\n---\n" }] },
      { name: "standup", origin: "global", files: [{ path: "SKILL.md", text: "---\nname: standup\ndescription: d\n---\n" }, { path: "../escape", text: "x" }] },
    ],
    claudeAccount: { kind: "person", personId: "p_aaaaaaaa" },
  });
  await until("the first run", () => service.store.session("s1")?.summary.latestRun?.status === "completed");
  const dir = join(nodeHome, "sessions", "s1");
  const config = JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"));
  expect(Object.keys(config.mcpServers)).toEqual(["fake", "fleetd"]);
  expect(config.mcpServers.fake).toEqual({ type: "stdio", command: "sh", args: fake.transport.args, env: { TOKEN } });
  expect(config.mcpServers.fleetd.args).toEqual(["agent-mcp", "--role", "lead"]);
  expect(statSync(join(dir, "mcp.json")).mode & 0o777).toBe(0o600);
  const argv = readFileSync(join(nodeHome, "hosts", "s1.argv"), "utf8").split("\n");
  expect(argv).toContain("--strict-mcp-config");
  expect(argv[argv.indexOf("--plugin-dir") + 1]).toBe(join(dir, "plugin"));
  const env = readFileSync(join(nodeHome, "hosts", "s1.env"), "utf8").split("\n");
  expect(env).toContain("CLAUDE_CODE_OAUTH_TOKEN=tok-alice-0123");
  expect(env.some((l) => l.startsWith("ANTHROPIC_API_KEY="))).toBe(false);
  expect(env).toContain(`FLEETD_SKILLS_DIR=${join(dir, "plugin", "skills")}`);
  // The repo's .agents copy wins over the rest; standup's bundle left its folder, so it is left out.
  expect(readFileSync(join(dir, "plugin/skills/release/SKILL.md"), "utf8")).toContain("agents copy");
  expect(existsSync(join(dir, "plugin/skills/release/.cache"))).toBe(false);
  expect(readFileSync(join(dir, "plugin/skills/triage/SKILL.md"), "utf8")).toContain("Claude");
  expect(existsSync(join(dir, "plugin/skills/standup"))).toBe(false);
  const settings = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  expect(settings.skillOverrides).toEqual({ release: "off", triage: "off" });
  // The fake host echoes the prompt: both secrets come back masked.
  expect(service.store.session("s1")?.summary.latestAssistantTail).toBe("ok: hello ***fake.TOKEN*** and ***CLAUDE_CODE_OAUTH_TOKEN***");
  // A send's servers and skills are kept for the next start.
  await ok("send", { sessionId: "s1", runId: "r2", text: "again", mcp: { userServers: true, servers: [] }, skills: [] });
  expect(JSON.parse(readFileSync(join(dir, "mcp-servers.json"), "utf8"))).toEqual({ role: "lead", config: { userServers: true, servers: [] } });
  expect(existsSync(join(dir, "hub-skills.json"))).toBe(false);
  await until("the second run", () => service.store.session("s1")?.summary.latestRun?.id === "r2" && service.store.session("s1")?.summary.latestRun?.status === "completed");
  await ok("stop", { sessionId: "s1" });
});

test("a session whose Claude account is gone fails to start rather than run on the machine's login", async () => {
  await ok("claude_account_secret", { account: { kind: "person", personId: "p_gone0000" }, set: { sealed: sealed("tok-gone") } });
  await ok("claude_account_secret", { account: { kind: "person", personId: "p_gone0000" } });
  const launched = await call("launch", {
    sessionId: "s2",
    projectId: "p1",
    runtimeMode: "full-access",
    workspace: { type: "root" },
    prompt: "hi",
    runId: "r1",
    claudeAccount: { kind: "person", personId: "p_gone0000" },
  });
  expect(launched.result).toMatchObject({ err: { code: "runner_unavailable", message: expect.stringContaining("p_gone0000's subscription") } });
  expect(service.store.session("s2")?.summary.latestRun?.status).toBe("failed");
});

test("frontmatter reads plain, quoted and block scalars", () => {
  expect(frontmatter('---\nname: pdf\ndescription: "Fill PDF forms: any."\nlicense: MIT\n---\n# Body\n')).toEqual({ name: "pdf", description: "Fill PDF forms: any." });
  expect(frontmatter("---\nname: x\ndescription: >\n  Two lines\n  folded.\nmetadata:\n  a: b\n---\n").description).toBe("Two lines folded.");
  expect(frontmatter("# no frontmatter\n")).toEqual({});
  expect(frontmatter("---\ndescription: it's # a note\n---").description).toBe("it's");
});

test("the landed log reads the remote's line with its trailers and what each merge brought in", async () => {
  const origin = join(home.dir, "origin.git");
  const work = join(home.dir, "work");
  spawnSync("git", ["init", "-q", "--bare", "-b", "main", origin]);
  spawnSync("git", ["clone", "-q", origin, work]);
  gitIn(work, "commit", "-q", "--allow-empty", "-m", "first");
  const first = gitIn(work, "rev-parse", "HEAD");
  gitIn(work, "checkout", "-q", "-b", "fleetd/T7-x");
  gitIn(work, "commit", "-q", "--allow-empty", "-m", "work\n\nFleetd-Task: T7");
  gitIn(work, "checkout", "-q", "main");
  gitIn(work, "merge", "-q", "--no-ff", "fleetd/T7-x", "-m", "merge T7\n\nFleetd-Change: C1");
  gitIn(work, "push", "-q", "origin", "main");
  const project = join(home.dir, "landed");
  spawnSync("git", ["clone", "-q", origin, project]);
  await ok("project_upsert", { projectId: "p2", title: "landed", workspaceRoot: project });
  gitIn(work, "commit", "-q", "--allow-empty", "-m", "direct push");
  gitIn(work, "push", "-q", "origin", "main");
  const log = await ok("landed_log", { projectId: "p2", branch: "main", sinceMs: 0, stopAt: first });
  expect(log.read).toBe("origin/main");
  expect(log.fetchFailed).toBeUndefined();
  expect(log.commits.map((c: { subject: string }) => c.subject)).toEqual(["direct push", "merge T7"]);
  expect(log.commits[1]).toMatchObject({ changes: ["C1"], tasks: [], mergedTasks: ["T7"] });
  expect(log.commits[1].parents).toHaveLength(2);
  expect(log.commits[0].atMs % 1000).toBe(0);
  expect((await call("landed_log", { projectId: "p2", branch: "nope", sinceMs: 0 })).result).toMatchObject({ err: { code: "git" } });
});

test("a clone lands whole, sends its progress, and refuses a taken or relative destination", async () => {
  expect(parseProgress("Receiving objects:  45% (450/1000), 1.20 MiB | 2.00 MiB/s")).toEqual({ phase: "receiving", percent: 45, detail: "1.20 MiB | 2.00 MiB/s" });
  expect(parseProgress("remote: Counting objects: 100% (3/3), done.")).toEqual({ phase: "starting", percent: 100 });
  expect(parseProgress("Cloning into 'x'...")).toBeUndefined();
  frames.length = 0;
  const dest = join(home.dir, "src", "clone");
  const facts = await ok("repo_clone", { addId: "add-1", url: `file://${join(home.dir, "origin.git")}`, dest });
  expect(facts).toMatchObject({ kind: "repo_facts", exists: true, isGit: true, defaultBranch: "main" });
  expect(frames.some((f) => f.t === "clone_progress" && f.addId === "add-1")).toBe(true);
  const again = await call("repo_clone", { addId: "add-2", url: `file://${join(home.dir, "origin.git")}`, dest });
  expect(again.result).toMatchObject({ err: { code: "git", message: `${dest} already exists` } });
  expect((await call("repo_clone", { addId: "a", url: "x", dest: "rel/path" })).result).toMatchObject({ err: { code: "invalid" } });
  const missing = await call("repo_clone", { addId: "add-3", url: `file://${join(home.dir, "no-such.git")}`, dest: join(home.dir, "src", "gone") });
  expect(missing.result).toMatchObject({ err: { code: "git" } });
  expect(existsSync(join(home.dir, "src", "gone.fleetd-partial-add3"))).toBe(false);
});

test("gh repo list runs the machine's gh for the user and their orgs, and says when gh isn't logged in", async () => {
  const bin = join(home.dir, "bin");
  mkdirSync(bin, { recursive: true });
  const gh = join(bin, "gh");
  writeFileSync(
    gh,
    `#!/bin/sh
[ -n "$GH_STANDIN_LOGGED_OUT" ] && { echo "To get started with GitHub CLI, please run:  gh auth login" >&2; exit 4; }
case "$1 $2" in
  "api user") echo devbox-dev ;;
  "api user/orgs") echo acme ;;
  "repo list") echo "[{\\"nameWithOwner\\":\\"$3/shop\\",\\"url\\":\\"https://github.com/$3/shop\\",\\"isPrivate\\":true,\\"description\\":null,\\"pushedAt\\":\\"2026-11-01T00:00:00Z\\"}]" ;;
esac
`,
  );
  chmodSync(gh, 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    expect(await ok("gh_repo_list")).toEqual({
      kind: "gh_repos",
      owners: ["devbox-dev", "acme"],
      repos: [
        { nameWithOwner: "devbox-dev/shop", url: "https://github.com/devbox-dev/shop", isPrivate: true, pushedAt: "2026-11-01T00:00:00Z" },
        { nameWithOwner: "acme/shop", url: "https://github.com/acme/shop", isPrivate: true, pushedAt: "2026-11-01T00:00:00Z" },
      ],
    });
    process.env.GH_STANDIN_LOGGED_OUT = "1";
    expect(await ok("gh_repo_list")).toEqual({ kind: "gh_repos", owners: [], repos: [], problem: "gh is not logged in" });
  } finally {
    process.env.PATH = path;
    delete process.env.GH_STANDIN_LOGGED_OUT;
  }
});

test("read_image reads an image from the session's own folder only, and checks its bytes", async () => {
  await ok("launch", { sessionId: "s3", projectId: "p1", runtimeMode: "full-access", workspace: { type: "root" }, prompt: "hi", runId: "r1" });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 1)]);
  writeFileSync(join(repo, "shot.png"), png);
  writeFileSync(join(repo, "fake.png"), "not a png");
  writeFileSync(join(home.dir, "outside.png"), png);
  symlinkSync(join(home.dir, "outside.png"), join(repo, "link.png"));
  writeFileSync(join(repo, "notes.md"), "# hi\n");
  const image = await ok("read_image", { sessionId: "s3", path: "shot.png" });
  expect(image).toEqual({ kind: "image", name: "shot.png", mime: "image/png", bytes: 108, dataB64: png.toString("base64") });
  expect((await ok("read_image", { sessionId: "s3", path: "shot.png", offset: 100 })).dataB64).toBe(png.subarray(100).toString("base64"));
  expect((await ok("read_image", { sessionId: "s3", path: "notes.md", file: true })).mime).toBe("text/plain");
  const refused = async (path: string, file = false) => ((await call("read_image", { sessionId: "s3", path, file })).result as { err: { message: string } }).err.message;
  expect(await refused("fake.png")).toContain("does not hold the image its name says");
  expect(await refused("link.png")).toContain("is outside your working directory");
  expect(await refused("../outside.png")).toContain("is outside your working directory");
  expect(await refused("notes.md")).toContain("is not a .png, .jpg, .webp or .gif image");
  expect((await call("read_image", { sessionId: "nope", path: "shot.png" })).result).toMatchObject({ err: { code: "not_found" } });
  await ok("stop", { sessionId: "s3" });
});

test("a project's kept sign-ins are forgotten, and go with its project", async () => {
  const inbox = join(home.dir, "inbox");
  mkdirSync(inbox);
  await ok("project_upsert", { projectId: "n1", title: "inbox", workspaceRoot: inbox });
  const kept = join(oldProfilesDir(nodeHome), "n1", "Default");
  mkdirSync(kept, { recursive: true });
  expect((await ok("project_worktrees", { projectId: "n1" })).signinsKept).toBe(true);
  expect(await ok("signins_forget", { projectId: "n1" })).toEqual({ kind: "done" });
  expect(existsSync(join(oldProfilesDir(nodeHome), "n1"))).toBe(false);
  expect((await ok("project_worktrees", { projectId: "n1" })).signinsKept).toBe(false);
  mkdirSync(join(nodeHome, "browser", "kept", "n1"), { recursive: true });
  await ok("mcp_secrets", { scope: { kind: "project", projectId: "n1" }, server: "s", set: [{ field: "env", name: "K", sealed: sealed("value-1") }] });
  await ok("project_remove", { projectId: "n1" });
  expect(existsSync(join(nodeHome, "browser", "kept", "n1"))).toBe(false);
  expect(existsSync(join(nodeHome, "mcp-secrets", "projects", "n1.json"))).toBe(false);
  expect((await call("signins_forget", { projectId: "n1" })).result).toMatchObject({ err: { code: "not_found" } });
});
