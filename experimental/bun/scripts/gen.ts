// Generates, from the Rust tree (never by hand):
//   src/gen/tools.ts       every MCP tool in crates/fleetd-contracts' `tools!` table: its role and owning module
//   src/gen/migrations.ts  every hub migration in crates/fleetd/src/hub/store/migrations, in order, as text imports
//   src/gen/wire.ts        the node link's message tags, session call ops, lead call ops and agent-mcp's tools
//   PORT_MAP.md            the port checklist, by area, ticked from each module's src/<module>/PORTED
//   src/**/PORTED          kept sorted; a hand tick left in PORT_MAP.md moves into its module's (not with --check
//                          or --leave-hand-ticks, which keep it in PORT_MAP.md)
//
//   bun scripts/gen.ts           writes them
//   bun scripts/gen.ts --check   writes nothing, fails when one is out of date (CI)
//   bun scripts/gen.ts --status  writes nothing, prints how many items each area has done (bun run progress)
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const BUN = join(import.meta.dir, "..");
const ROOT = join(BUN, "../..");
const CRATE = join(ROOT, "crates/fleetd/src");
const CONTRACTS = join(ROOT, "crates/fleetd-contracts/src");
const MIGRATIONS = join(CRATE, "hub/store/migrations");
const TS_CONTRACTS = join(ROOT, "app/desktop/src/shared/contracts/generated/contracts.ts");
const CLI_DOC = join(ROOT, "docs/site/src/content/docs/reference/cli.md");

const read = (path: string) => readFileSync(path, "utf8");

// --- Areas -----------------------------------------------------------------------------------------------------

const AREAS = {
  "hub-core": "server, auth, keys, people, devices, links, settings, store",
  "hub-work": "projects, orders, tasks, chat, leads, decisions, checklist, memory, automations",
  "hub-train+github": "merge train, reviews, PRs, checks, GitHub App",
  "hub-approvals+secrets+updates+cloud": "approvals, secrets, integrations, updates, cloud machines",
  "node-core": "link, sessions, runner, worktrees, PTY through the Rust session-host",
  "node-browser+screens": "CDP proxy, screens, devices, the agents' Mac, session relays",
  cli: "every `fleetd` command",
  mcp: "/mcp, agent-mcp and the lead calls it makes",
} as const;
type Area = keyof typeof AREAS;

// Each Rust module (a directory or file under hub/, node/, cli/) and the area that ports it. The Bun module has the
// same path under src/ (`hub/train` is src/hub/train/). A Rust module missing here fails the generator, so a new one
// gets an owner.
const HUB_AREAS: Record<string, Area> = {
  api: "hub-core", app_ws: "hub-core", auth: "hub-core", http: "hub-core", serve: "hub-core", store: "hub-core",
  people: "hub-core", pair: "hub-core", push: "hub-core", hub_links: "hub-core", link: "hub-core",
  info: "hub-core", setup: "hub-core", doctor: "hub-core", sidebar_order: "hub-core", chat_pins: "hub-core",
  status: "hub-core", metrics: "hub-core", watchdog: "hub-core", sweep: "hub-core", outage: "hub-core", queue: "hub-core",
  redact: "hub-core", policy: "hub-core",
  agents: "hub-work", artifacts: "hub-work", attention: "hub-work", automations: "hub-work", chat: "hub-work",
  checklist: "hub-work", executor: "hub-work", intake: "hub-work", leads: "hub-work", ledger: "hub-work",
  memory: "hub-work", navi: "hub-work", orders: "hub-work", projects: "hub-work", prompts: "hub-work",
  repos: "hub-work", skills: "hub-work", slots: "hub-work", steer: "hub-work", tasks: "hub-work",
  time: "hub-work", usage: "hub-work", wakes: "hub-work", work: "hub-work",
  train: "hub-train+github", reviews: "hub-train+github", prs: "hub-train+github", checks: "hub-train+github",
  github_app: "hub-train+github",
  approvals: "hub-approvals+secrets+updates+cloud", onepassword: "hub-approvals+secrets+updates+cloud",
  vault: "hub-approvals+secrets+updates+cloud",
  mcp_oauth: "hub-approvals+secrets+updates+cloud", mcp_servers: "hub-approvals+secrets+updates+cloud",
  claude_accounts: "hub-approvals+secrets+updates+cloud", integrations: "hub-approvals+secrets+updates+cloud",
  update: "hub-approvals+secrets+updates+cloud", cloud: "hub-approvals+secrets+updates+cloud",
  pool: "hub-approvals+secrets+updates+cloud", machine_setup: "hub-approvals+secrets+updates+cloud",
  browser: "node-browser+screens", machine_roles: "node-browser+screens", mac_tool: "node-browser+screens",
  mcp: "mcp", lead_calls: "mcp",
};
const NODE_SCREENS = new Set(["agents_mac", "browser", "desktop", "device", "hosts", "screens", "mac_tool", "relay", "session_route"]);
const CLI_AREAS: Record<string, Area> = { agent_mcp: "mcp", mcp_client: "mcp", mac_tool: "node-browser+screens", agent_device: "node-browser+screens" };

function areaOf(module: string): Area {
  const [side, name = ""] = module.split("/");
  if (side === "hub") {
    const area = HUB_AREAS[name];
    if (!area) throw new Error(`gen: crates/fleetd/src/${module} has no area: add it to HUB_AREAS in scripts/gen.ts`);
    return area;
  }
  if (side === "node") return NODE_SCREENS.has(name) ? "node-browser+screens" : "node-core";
  if (side === "cli") return CLI_AREAS[name] ?? "cli";
  if (side === "update") return "hub-approvals+secrets+updates+cloud";
  return "hub-core";
}

// Every Rust module has an owner, checked here rather than when a tool happens to name it.
for (const entry of readdirSync(join(CRATE, "hub"))) {
  const name = entry.replace(/\.rs$/, "");
  if (name !== "mod" && !name.endsWith("_tests")) areaOf(`hub/${name}`);
}

// --- Rust sources ----------------------------------------------------------------------------------------------

function rustFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "tests" || entry === "testdata" ? [] : rustFiles(path);
    return entry.endsWith(".rs") && !/(^|_)tests?\.rs$/.test(entry) ? [path] : [];
  });
}

/** A file's code before its `#[cfg(test)] mod tests { … }`. */
function code(path: string): string {
  const text = read(path);
  const tests = text.search(/#\[cfg\(test\)\]\s*mod \w+\s*\{/);
  return tests < 0 ? text : text.slice(0, tests);
}

/** `hub/train` for crates/fleetd/src/hub/train/tools.rs, `hub/info` for hub/info.rs. */
function moduleOf(path: string): string {
  const parts = relative(CRATE, path).replace(/\.rs$/, "").split("/");
  return parts.length === 1 ? (parts[0] ?? "") : `${parts[0]}/${parts[1]}`;
}

/** The body of `enum Name { … }` (or a macro block `name! { … }`), braces balanced. */
function block(text: string, opener: RegExp): string {
  const at = text.search(opener);
  if (at < 0) throw new Error(`gen: no ${opener} in the Rust source`);
  const start = text.indexOf("{", at);
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}" && --depth === 0) return text.slice(start + 1, i);
  }
  throw new Error(`gen: unbalanced ${opener}`);
}

/** A serde enum's variants as they read on the wire: snake_case, or their `#[serde(rename = "…")]`. */
function variants(body: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let rename: string | undefined;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (depth === 0) {
      const renamed = trimmed.match(/^#\[serde\(rename = "([^"]+)"\)\]/);
      if (renamed) rename = renamed[1];
      const variant = trimmed.match(/^([A-Z][A-Za-z0-9]*)\s*(\(|\{|,|$)/);
      if (variant?.[1]) {
        out.push(rename ?? snake(variant[1]));
        rename = undefined;
      }
    }
    depth += (line.match(/[{(]/g) ?? []).length - (line.match(/[})]/g) ?? []).length;
  }
  return out;
}

const snake = (name: string) => name.replace(/(?<!^)([A-Z])/g, "_$1").toLowerCase();

// --- What there is to port -------------------------------------------------------------------------------------

type Item = { key: string; text: string; area: Area; module: string };
const items: Item[] = [];
const add = (section: string, label: string, module: string, note = "", area = areaOf(module)) =>
  items.push({ key: `${section}:${label}`, area, module, text: `${label} → \`src/${module}\`${note ? ` (${note})` : ""}` });

// HTTP routes and the websockets they upgrade to: crates/fleetd/src/hub/http/mod.rs's router.
const ROUTE_MODULES: Record<string, string> = {
  healthz: "hub/http", mcp_route: "hub/mcp", app_route: "hub/app_ws", pair_route: "hub/pair",
  mac_pair_route: "hub/pair", node_link_route: "hub/link", relay_route: "hub/machine_roles",
  hook_route: "hub/automations", hub_link_route: "hub/hub_links", oauth_callback_route: "hub/mcp_oauth",
};
const routes: { path: string; method: string; handler: string; module: string }[] = [];
for (const m of read(join(CRATE, "hub/http/mod.rs")).matchAll(/\.route\("([^"]+)",\s*(\w+)\((\w+)\)\)/g)) {
  const [, path = "", method = "", handler = ""] = m;
  const module = ROUTE_MODULES[handler];
  if (!module) throw new Error(`gen: route ${path} (${handler}) has no module: add it to ROUTE_MODULES`);
  routes.push({ path, method: method.toUpperCase(), handler, module });
  add("http", `${method.toUpperCase()} \`${path}\``, module, handler.replace(/_route$/, ""));
}

// The /app websocket's messages: the contracts' AppClientMessage and AppServerMessage.
const tsContracts = read(TS_CONTRACTS);
function tsTags(type: string): string[] {
  const at = tsContracts.indexOf(`export type ${type} =`);
  const body = tsContracts.slice(at, tsContracts.indexOf("\n};", at));
  return [...body.matchAll(/^\s+t: "(\w+)";/gm)].map((m) => m[1] ?? "");
}
const APP_MODULES: Record<string, string> = {
  live: "hub/app_ws", chat: "hub/chat", chat_delta: "hub/chat", browser_watch: "hub/browser",
  browser_frame_ack: "hub/browser", browser_input: "hub/browser", browser_frame: "hub/browser",
  screen_thumbs: "hub/machine_roles", screen_thumb: "hub/machine_roles",
};
for (const t of tsTags("AppClientMessage")) add("app", `/app client \`${t}\``, APP_MODULES[t] ?? "hub/app_ws");
for (const t of tsTags("AppServerMessage")) add("app", `/app server \`${t}\``, APP_MODULES[t] ?? "hub/app_ws");

// MCP tools: the contracts' `tools!` table, each owned by the Rust module that registers it (`Registry::add`).
const mcpRs = read(join(CONTRACTS, "mcp.rs"));
const toolTable = [...block(mcpRs, /^tools! \{/m).matchAll(/^\s*(\w+) => \w+, (\w+),/gm)].map((m) => ({
  name: m[1] ?? "",
  scope: (m[2] ?? "").toLowerCase(),
}));
const registeredBy = new Map<string, string>();
for (const file of rustFiles(join(CRATE, "hub"))) {
  const stub = file.endsWith("api/m1.rs");
  const text = code(file);
  const names = [...text.matchAll(/\.add(?:_raw)?(?:::<[^>]*>)?\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1] ?? "");
  // `for name in ["project_archive", "navi_archive"] { tools.add(name, …) }`
  for (const m of text.matchAll(/for \w+ in \[([^\]]+)\]\s*\{[^}]*?\.add(?:_raw)?(?:::<[^>]*>)?\(\s*\w+\s*,/g)) {
    names.push(...[...(m[1] ?? "").matchAll(/"([a-z0-9_]+)"/g)].map((n) => n[1] ?? ""));
  }
  for (const name of names) {
    if (!stub || !registeredBy.has(name)) registeredBy.set(name, moduleOf(file));
  }
}
const tools = toolTable.map(({ name, scope }) => ({ name, scope, module: registeredBy.get(name) ?? "hub/api" }));
for (const t of tools) add("tool", `\`${t.name}\``, t.module, registeredBy.has(t.name) ? t.scope : `${t.scope}, not wired in Rust`);

// The node link: NodeToHub and HubToNode in crates/fleetd-contracts/src/node_link.rs. Each message is two items, its
// sender's and its receiver's.
const nodeLinkRs = read(join(CONTRACTS, "node_link.rs"));
const nodeToHub = variants(block(nodeLinkRs, /pub enum NodeToHub\b/));
const hubToNode = variants(block(nodeLinkRs, /pub enum HubToNode\b/));
const LINK_SIDES: Record<string, [hub: string, node: string]> = {
  lead_call: ["hub/lead_calls", "node/lead"], lead_result: ["hub/lead_calls", "node/lead"],
  cmd_check: ["hub/link", "node/cmd"], cmd_result: ["hub/link", "node/cmd"],
  secret_deliver: ["hub/link", "node/secrets"], secret_result: ["hub/link", "node/secrets"],
  gated_run: ["hub/link", "node/gated"], gated_resume: ["hub/link", "node/gated"], gated_result: ["hub/link", "node/gated"],
  node_action: ["hub/link", "node/actions"], node_action_result: ["hub/link", "node/actions"],
  session_call: ["hub/link", "node/sessions"], session_reply: ["hub/link", "node/sessions"],
  machine_event: ["hub/link", "node/sessions"], thread_event: ["hub/link", "node/sessions"],
  clone_progress: ["hub/link", "node/sessions"], spans: ["hub/link", "node/sessions"], spans_ack: ["hub/link", "node/sessions"],
  slept: ["hub/link", "node/power"],
  browser_frame: ["hub/browser", "node/browser"], browser_watch: ["hub/browser", "node/browser"],
  browser_input: ["hub/browser", "node/browser"], browser_control: ["hub/browser", "node/browser"],
  session_host: ["hub/machine_roles", "node/session_route"], session_host_result: ["hub/machine_roles", "node/session_route"],
  relay_dial: ["hub/machine_roles", "node/session_route"], session_step: ["hub/machine_roles", "node/session_route"],
  session_end: ["hub/machine_roles", "node/screens"],
  mac_call: ["hub/mac_tool", "node/mac_tool"], mac_result: ["hub/mac_tool", "node/mac_tool"],
};
const sides = (t: string) => LINK_SIDES[t] ?? ["hub/link", "node/link"];
for (const t of nodeToHub) {
  const [hub, node] = sides(t);
  add("link", `node→hub \`${t}\` send`, node);
  add("link", `node→hub \`${t}\` handle`, hub);
}
for (const t of hubToNode) {
  const [hub, node] = sides(t);
  add("link", `hub→node \`${t}\` send`, hub);
  add("link", `hub→node \`${t}\` handle`, node);
}
const sessionCalls = variants(block(read(join(CONTRACTS, "sessions.rs")), /pub enum SessionCall\b/));
for (const op of sessionCalls) add("session", `session call \`${op}\``, "node/sessions");

// The screen calls agent-mcp sends to its node (`browser_call`): BrowserCall in crates/fleetd-contracts/src/browser.rs,
// each answered by the kind of screen it drives.
const browserCalls = variants(block(read(join(CONTRACTS, "browser.rs")), /pub enum BrowserCall\b/));
const BROWSER_CALL_MODULES: Record<string, string> = { desktop: "node/desktop", device: "node/device" };
for (const op of browserCalls) add("browser", `browser call \`${op}\``, BROWSER_CALL_MODULES[op] ?? "node/browser");

// The lead calls agent-mcp sends through the node: LeadCall in crates/fleetd-contracts/src/lead_calls.rs.
const leadCalls = variants(block(read(join(CONTRACTS, "lead_calls.rs")), /pub enum LeadCall\b/));
for (const op of leadCalls) add("lead", `lead call \`${op}\``, "hub/lead_calls");

// agent-mcp's tools (crates/fleetd/src/cli/agent_mcp.rs's TOOLS): what a lead's or task's claude sees.
const agentMcpRs = read(join(CRATE, "cli/agent_mcp.rs"));
const toolsBlock = agentMcpRs.slice(agentMcpRs.indexOf("static TOOLS: &[Tool] = &["));
const toolsEnd = toolsBlock.indexOf("\n];");
const agentTools = [
  ...toolsBlock.slice(0, toolsEnd).matchAll(/(?:\b(lead|browser)\(\s*"([a-z_]+)"(?:,\s*"([a-z_]+)")?|Tool \{\s*name: "([a-z_]+)",\s*op: "([a-z_]+)")/g),
].map((m) => (m[4] ? { name: m[4], op: m[5] ?? "" } : { name: m[2] ?? "", op: m[1] === "browser" ? (m[2] ?? "") : (m[3] ?? "") }));
for (const t of agentTools) add("agent-mcp", `agent-mcp tool \`${t.name}\``, "cli/agent_mcp", t.op === t.name ? "" : `op ${t.op}`);

// CLI commands: the CLI reference docsgen generates from the Rust binary's help, plus the commands help leaves out.
const commands = new Set<string>();
for (const m of read(CLI_DOC).matchAll(/^### fleetd ([^{]+?) \{#/gm)) commands.add((m[1] ?? "").trim());
for (const hidden of ["agent-mcp", "mac", "agent-device", "build-slot", "session-host", "update-finish", "update-hold", "update-claude"]) {
  commands.add(hidden);
}
const CLI_MODULES: Record<string, string> = {
  version: "cli", help: "cli", update: "cli/update", init: "cli/setup", doctor: "cli/setup", uninstall: "cli/setup",
  machine: "cli/setup", invite: "cli/people", "hub start": "hub/serve", "hub key": "cli/hub_key",
  steers: "cli/steer", instructions: "cli/prompts", "agent-mcp": "cli/agent_mcp", mac: "cli/mac_tool",
  "agent-device": "cli/agent_device", "build-slot": "node/build_slots", "session-host": "node/runner",
  "update-finish": "update", "update-hold": "node/hold", "update-claude": "cli/update", "push-relay": "push_relay",
};
for (const command of [...commands].sort()) {
  const [first = "", second = ""] = command.split(" ");
  const module = CLI_MODULES[`${first} ${second}`] ?? CLI_MODULES[first] ?? `cli/${first.replace(/-/g, "_")}`;
  const note = command === "session-host" ? "reuse the Rust binary's: PTY holder" : "";
  add("cli", `\`fleetd ${command}\``, module, note, command === "session-host" ? "node-core" : "cli");
}

// Background loops: the hub's start_loops and the node's run.
const serveRs = read(join(CRATE, "hub/serve/mod.rs"));
const startLoops = block(serveRs, /pub fn start_loops\(/);
const hubLoops = new Set<string>();
for (const m of startLoops.matchAll(/crate::hub::([a-z_]+(?:::[a-z_]+)*)\(/g)) hubLoops.add(m[1] ?? "");
for (const m of startLoops.matchAll(/\bhub\.([a-z_]+)(?:\s*\.clone\(\))?\s*\.(start|run|resume|prefetch_loop)\(/g)) {
  hubLoops.add(`${m[1]}.${m[2]}`);
}
for (const loop of [...hubLoops].sort()) {
  // \`hub.updates\` is the Hub's field for the \`update\` module; the others share their module's name.
  const name = loop.split(/::|\./)[0] ?? "";
  add("loop", `hub loop \`${loop}\``, `hub/${name === "updates" ? "update" : name}`);
}
const nodeRun = read(join(CRATE, "node/mod.rs"));
const nodeLoops = new Set<string>();
for (const m of nodeRun.matchAll(/\b([a-z_]+(?:::[a-z_]+)*(?:::[A-Z][A-Za-z]+)?)::(start|run|run_node)\(/g)) {
  if (!(m[1] ?? "").startsWith("tokio")) nodeLoops.add(`${m[1]}::${m[2]}`);
}
for (const loop of [...nodeLoops].sort()) add("loop", `node loop \`${loop}\``, `node/${loop.split("::")[0]}`);

// The heartbeat's fields (Heartbeat and NodeLoad in node_link.rs): what Settings › Hub › Machines and the hub's
// placement read, each filled by the area that knows it. A field the Bun node leaves out reads as "Not known yet".
const fields = (struct: string) =>
  [...block(nodeLinkRs, new RegExp(`pub struct ${struct}\\b`)).matchAll(/^\s*pub (\w+):/gm)].map((m) =>
    (m[1] ?? "").replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()),
  );
const HB_MODULES: Record<string, string> = {
  steps: "node/browser", "load.hosts": "node/hosts", "load.android": "node/device", "load.ios": "node/device",
  "load.desktop": "node/desktop", "load.mac": "node/agents_mac",
};
const hbFields = [
  ...fields("Heartbeat").filter((f) => f !== "load"),
  ...fields("NodeLoad").map((f) => `load.${f}`),
];
for (const f of hbFields) add("hb", `heartbeat \`${f}\``, HB_MODULES[f] ?? "node/load");

// Rust modules whose behaviour no message, tool or loop above names, so nothing else here would list them: a gap the
// interface lists can't see. Each file must exist in the Rust tree.
const MODULES_WITHOUT_A_WIRE: [rust: string, module: string, what: string][] = [
  ["node/runner/scope.rs", "node/runner", "each session host in a systemd scope of its own, so agents outlive the node's restart"],
  ["node/mac_tool/client.rs", "node/mac_tool", "`mac` and, while the session holds a simulator, the forwarding agent-device first on every agent's PATH"],
  ["node/mac_tool/activity.rs", "node/mac_tool", "what agents do on the agents' Mac, written for its menu bar"],
  ["node/power/inhibit.rs", "node/power", "the sleep inhibitor while agents run: logind's on Linux, an IOPMAssertion on macOS"],
  ["node/power/clock.rs", "node/power", "time asleep, so the node notices a wake: CLOCK_BOOTTIME on Linux, mach clocks on macOS"],
  ["node/self_exe.rs", "node/self_exe", "the session host pinned where an update can't replace it, for the sessions' fleetd tools"],
  ["node/build_slots.rs", "node/build_slots", "the cargo wrapper first on every agent's PATH, so its builds take the machine's build slots"],
  ["node/sessions/share.rs", "node/sessions", "each agent's share of the CPUs for builds and test runners, and its brief's \"## This machine\" note"],
  ["node/sessions/proc.rs", "node/sessions", "what a dead node's sessions left running, stopped at start, sparing re-adopted trees"],
  ["node/sessions/health.rs", "node/sessions", "runner health corrected by real runs, re-probed every 15 s while unusable"],
  ["node/store.rs", "node/sessions", "steps older than 30 days pruned; the span outbox bounded with a gap span"],
  ["node/worktree.rs", "node/worktree", "token-marked checkouts fetch with their order's GITHUB_TOKEN; a review at its PR's head"],
  ["node/runner/process.rs", "node/runner", "processes a task left running (the host's `.left` record) ended with the task"],
  ["node/session_route.rs", "node/session_route", "every kind of screen placed elsewhere: the session's secrets sealed to the runner, none to the agents' Mac, each step masked"],
  ["node/device/remote.rs", "node/device", "a screen hosted for another machine runs sealed agent-device steps in its own folder; the agent's forwarder is node/mac_tool's"],
  ["node/desktop/session.rs", "node/desktop", "desktop and Mac screen recordings: video, action log, scrubbed, uploaded"],
  ["node/browser/upload.rs", "node/browser", "recordings a stopped node left, every kind's and a Rust node's iOS ones, ended and uploaded"],
  ["node/mask.rs", "node/browser", "the thorough masker and Scrub every screen's recording and DOM trace go through"],
  ["node/browser/chrome.rs", "node/browser", "projects' kept profiles, the warm pool, installing Playwright's Chrome where it is missing"],
  ["node/browser/credentials.rs", "node/browser", "a session sealed from its first fill: answers scrubbed, snapshots redacted, no write to a filled field, filled values masked in the agent's reports"],
  ["node/browser/session.rs", "node/browser", "the DOM trace after each of the agent's commands and each fill, scrubbed of every value the session knows"],
];
for (const [rust, module, what] of MODULES_WITHOUT_A_WIRE) {
  if (!existsSync(join(CRATE, rust))) throw new Error(`gen: crates/fleetd/src/${rust} is gone: update MODULES_WITHOUT_A_WIRE`);
  add("mod", `\`${rust}\``, module, what);
}

// What each service does for itself and the layers the hub's HTTP answers pass through: the OOM score each lowers
// (`oom::protect`), and each module of hub/http besides its router (counted.rs, gzip.rs).
const protects = new Set<string>();
for (const file of rustFiles(CRATE)) {
  for (const m of code(file).matchAll(/\boom::protect\("(\w+)"\)/g)) protects.add(`${m[1]} ${moduleOf(file).replace(/\/mod$/, "")}`);
}
for (const p of [...protects].sort()) {
  const [what = "", module = ""] = p.split(" ");
  add("service", `the ${what} lowers its own OOM score at start`, module);
}
for (const entry of readdirSync(join(CRATE, "hub/http")).sort()) {
  if (entry.endsWith(".rs") && entry !== "mod.rs") add("service", `hub HTTP layer \`${entry.replace(/\.rs$/, "")}\``, "hub/http");
}

// --- Outputs ---------------------------------------------------------------------------------------------------

const header = "// Generated by experimental/bun/scripts/gen.ts from the Rust tree. Don't edit: run `bun run gen`.\n";

const toolsTs = `${header}import type { Role, ToolMap } from "../shared/contracts.ts";

/** Each MCP tool: the least role it needs (the contracts' tools! table) and the Bun module that serves it. */
export const TOOLS = {
${tools.map((t) => `  ${t.name}: { scope: "${t.scope}", module: "src/${t.module}" },`).join("\n")}
} as const satisfies { [K in keyof ToolMap]: { scope: Role; module: string } };

export type ToolName = keyof typeof TOOLS;
`;

const migrationFiles = readdirSync(MIGRATIONS)
  .filter((f) => f.endsWith(".sql"))
  .sort((a, b) => Number(a.split("_")[0]) - Number(b.split("_")[0]));
const migrationsTs = `${header}// The hub's migrations, read from the Rust tree (bun build --compile embeds them), in the order of their prefixes.
${migrationFiles.map((f, i) => `import m${i} from "../../../../crates/fleetd/src/hub/store/migrations/${f}" with { type: "text" };`).join("\n")}

export const MIGRATIONS: readonly { name: string; sql: string }[] = [
${migrationFiles.map((f, i) => `  { name: "${f.replace(/\.sql$/, "")}", sql: m${i} },`).join("\n")}
];
`;

const list = (values: string[]) => values.map((v) => `  "${v}",`).join("\n");
const wireTs = `${header}// The node link's types live only in Rust (crates/fleetd-contracts/src/node_link.rs): these are its tags, for the
// link's modules to type their frames against.

/** NodeToHub's \`t\`. */
export const NODE_TO_HUB = [
${list(nodeToHub)}
] as const;
export type NodeToHubTag = (typeof NODE_TO_HUB)[number];

/** HubToNode's \`t\`. */
export const HUB_TO_NODE = [
${list(hubToNode)}
] as const;
export type HubToNodeTag = (typeof HUB_TO_NODE)[number];

/** SessionCall's \`op\` (crates/fleetd-contracts/src/sessions.rs). */
export const SESSION_CALLS = [
${list(sessionCalls)}
] as const;
export type SessionCallOp = (typeof SESSION_CALLS)[number];

/** LeadCall's \`op\` (crates/fleetd-contracts/src/lead_calls.rs). */
export const LEAD_CALLS = [
${list(leadCalls)}
] as const;
export type LeadCallOp = (typeof LEAD_CALLS)[number];

/** agent-mcp's tools and the lead call each makes (crates/fleetd/src/cli/agent_mcp.rs). */
export const AGENT_MCP_TOOLS = [
${agentTools.map((t) => `  { name: "${t.name}", op: "${t.op}" },`).join("\n")}
] as const;
`;

// The ticks: each module's src/<module>/PORTED lists the keys of its items that it does, one per line, sorted, so
// parallel PRs tick in their own files and PORT_MAP.md is all generated (the train regenerates it on a conflict).
// A `- [x]` line in PORT_MAP.md that no PORTED file has (a tick from before PORTED, or a branch still ticking by hand)
// is a tick too, and `bun run gen` moves it into its module's PORTED; --check and --leave-hand-ticks (the train's
// regeneration, which may only write generated files) leave it in PORT_MAP.md. gen keeps each PORTED sorted, unrepeated.
const SRC = join(BUN, "src");
const PORT_MAP = join(BUN, "PORT_MAP.md");
const itemModule = new Map(items.map((i) => [i.key, i.module]));
const ported = new Map<string, Set<string>>();
const portedFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    return statSync(path).isDirectory() ? portedFiles(path) : entry === "PORTED" ? [path] : [];
  });
const wrong: string[] = [];
for (const path of portedFiles(SRC)) {
  const module = relative(SRC, dirname(path));
  const keys = new Set<string>();
  ported.set(module, keys);
  for (const key of read(path).split("\n").filter((line) => line.trim() !== "")) {
    const owner = itemModule.get(key);
    if (owner === module) keys.add(key);
    else wrong.push(`${relative(BUN, path)}: ${key} is ${owner ? `src/${owner}'s item, not this module's` : "no item of PORT_MAP.md"}`);
  }
}
if (wrong.length > 0) {
  for (const line of wrong) console.error(line);
  console.error("fix: each line of a module's PORTED is the <!-- key --> of one of its PORT_MAP.md items");
  process.exit(1);
}
const ticked = new Set([...ported.values()].flatMap((keys) => [...keys]));
const moveHandTicks = !process.argv.includes("--check") && !process.argv.includes("--leave-hand-ticks");
if (existsSync(PORT_MAP)) {
  for (const m of read(PORT_MAP).matchAll(/^- \[x\] .*<!-- (.+?) -->$/gm)) {
    const key = m[1] ?? "";
    const module = itemModule.get(key);
    if (!module) continue;
    ticked.add(key);
    if (moveHandTicks) ported.set(module, (ported.get(module) ?? new Set()).add(key));
  }
}
const portedOutputs: [string, string][] = [...ported]
  .filter(([, keys]) => keys.size > 0)
  .map(([module, keys]) => [join(SRC, module, "PORTED"), `${[...keys].sort().join("\n")}\n`]);
const SECTIONS: Record<string, string> = {
  http: "HTTP routes",
  app: "/app websocket messages",
  tool: "MCP tools (/mcp and /app `call`)",
  link: "Node link messages",
  session: "Session calls (hub → node `session_call`)",
  lead: "Lead calls (agent-mcp → node → hub)",
  browser: "Browser calls (agent-mcp → node `browser_call`)",
  "agent-mcp": "agent-mcp tools",
  cli: "CLI commands",
  loop: "Background loops",
  hb: "Heartbeat fields (node → hub `hb`)",
  mod: "Modules without a wire surface",
  service: "Service start and HTTP layers",
};
let portMap = `<!-- Generated by experimental/bun/scripts/gen.ts from the Rust tree and src/**/PORTED. Don't edit: run \`bun run gen\`. -->
# Bun port map

Every HTTP route, /app message, MCP tool, node link message, session, lead and browser call, agent-mcp tool, CLI
command, background loop, heartbeat field, module without a wire surface, service start step and hub HTTP layer in
the Rust tree, with the Bun module that ports it (the Rust module's path under \`src/\`). To tick an item when its
module does it and a test covers it, add its \`<!-- key -->\` as a line of \`src/<module>/PORTED\` (sorted), then run
\`bun run gen\`.

`;
// No done counts in the file: parallel PRs each tick their own module, and a shared count would make them conflict.
// `bun run progress` prints them instead.
const total = items.length;
const done = items.filter((i) => ticked.has(i.key)).length;
for (const [area, what] of Object.entries(AREAS)) {
  const mine = items.filter((i) => i.area === area);
  portMap += `## ${area}\n\n${what}.\n`;
  for (const [section, title] of Object.entries(SECTIONS)) {
    const here = mine.filter((i) => i.key.startsWith(`${section}:`));
    if (here.length === 0) continue;
    portMap += `\n### ${title}\n\n`;
    for (const i of here) portMap += `- [${ticked.has(i.key) ? "x" : " "}] ${i.text} <!-- ${i.key} -->\n`;
  }
  portMap += "\n";
}

// Each module that serves tools registers them from its tools.ts; src/gen/areas.ts calls them all, so no writer edits
// a shared list. A module without one gets an empty stub (the registry's NotImplemented stubs stand until it fills it).
const toolModules = [...new Set(tools.map((t) => t.module))].sort();
const areasTs = `${header}import type { Registry } from "../hub/api/registry.ts";
${toolModules.map((m, i) => `import { register as r${i} } from "../${m}/tools.ts";`).join("\n")}

/** Every module that serves MCP tools, each replacing the registry's stubs for its own. */
export function registerAll(tools: Registry): void {
${toolModules.map((m, i) => `  r${i}(tools); // ${m}`).join("\n")}
}
`;
const stubs: [string, string][] = toolModules
  .map((m): [string, string] => [
    join(BUN, "src", m, "tools.ts"),
    `import type { Registry } from "../api/registry.ts";

/** Replaces the registry's NotImplemented stubs for this module's tools (src/gen/tools.ts lists them). */
export function register(_tools: Registry): void {}
`,
  ])
  .filter(([path]) => !existsSync(path));

// The same for the hub's background loops: src/gen/loops.ts starts each module's from its loops.ts.
const loopModules = [...new Set(items.filter((i) => i.key.startsWith("loop:hub ")).map((i) => /`src\/(hub\/\w+)`/.exec(i.text)?.[1] ?? ""))].sort();
const loopsTs = `${header}import type { Hub } from "../hub/api/hub.ts";
${loopModules.map((m, i) => `import { start as s${i} } from "../${m}/loops.ts";`).join("\n")}

/** Every module's background loops (the Rust hub's start_loops); each stops on \`hub.shutdown\`. */
export function startAll(hub: Hub): void {
${loopModules.map((m, i) => `  s${i}(hub); // ${m}`).join("\n")}
}
`;
for (const m of loopModules) {
  const path = join(BUN, "src", m, "loops.ts");
  if (existsSync(path)) continue;
  const mine = items.filter((i) => i.key.startsWith("loop:hub ") && i.text.includes(`\`src/${m}\``)).map((i) => /`([^`]+)`/.exec(i.text)?.[1]);
  stubs.push([
    path,
    `import type { Hub } from "../api/hub.ts";

/** Starts this module's loops (Rust: ${mine.join(", ")}); each stops on \`hub.shutdown\`. Not ported yet. */
export function start(_hub: Hub): void {}
`,
  ]);
}

const outputs: [string, string][] = [
  ...stubs,
  [join(BUN, "src/gen/areas.ts"), areasTs],
  [join(BUN, "src/gen/loops.ts"), loopsTs],
  [join(BUN, "src/gen/tools.ts"), toolsTs],
  [join(BUN, "src/gen/migrations.ts"), migrationsTs],
  [join(BUN, "src/gen/wire.ts"), wireTs],
  ...portedOutputs,
  [PORT_MAP, portMap],
];
if (process.argv.includes("--status")) {
  for (const area of Object.keys(AREAS)) {
    const mine = items.filter((i) => i.area === area);
    console.log(`${area.padEnd(36)} ${mine.filter((i) => ticked.has(i.key)).length} / ${mine.length}`);
  }
  console.log(`${"total".padEnd(36)} ${done} / ${total}`);
  process.exit(0);
}
const check = process.argv.includes("--check");
let stale = 0;
for (const [path, text] of outputs) {
  const current = existsSync(path) ? read(path) : undefined;
  if (current === text) continue;
  if (check) {
    console.error(`out of date: ${relative(ROOT, path)}`);
    stale++;
  } else {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    console.log(`wrote ${relative(ROOT, path)}`);
  }
}
if (stale > 0) {
  console.error("fix: cd experimental/bun && bun run gen, then commit the result");
  process.exit(1);
}
if (check) console.log(`generated files are current (${total} port items, ${done} done)`);
