import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { exported, ROOT } from "./purity.ts";

// The package as another repository gets it (docs/CONTRIBUTING.md "The package"): a throwaway project outside this
// repo installs the repo's root package from a tarball, as `bun add github:unlaboredlabs/fleetd#<commit>` would lay
// it out in node_modules, then imports every entry point and typechecks. Nothing here reaches the network.
const dir = mkdtempSync(join(process.env.TMPDIR ?? "/tmp", "fleetd-pkg-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const project = join(dir, "project");
const run = (cmd: string[], cwd: string) => {
  const proc = Bun.spawnSync(cmd, { cwd, env: { ...process.env, BUN_INSTALL_CACHE_DIR: join(dir, "cache") }, stdout: "pipe", stderr: "pipe" });
  return { code: proc.exitCode, out: `${proc.stdout}${proc.stderr}`.trim() };
};
const bun = (args: string[], cwd = project) => run([process.execPath, ...args], cwd);
const typecheck = (file: string) => {
  // fleetd's own compiler options: the importer's typecheck reads the package's sources under its options.
  const { compilerOptions } = JSON.parse(readFileSync(join(ROOT, "fleetd/tsconfig.json"), "utf8")) as { compilerOptions: object };
  writeFileSync(join(project, "tsconfig.json"), JSON.stringify({ compilerOptions, files: [file] }));
  return run([join(ROOT, "fleetd/node_modules/.bin/tsc-rs"), "-p", "tsconfig.json"], project);
};

/** Each entry as an importer names it; the schemas' pattern becomes one name per file. */
function entries(): string[] {
  return exported().flatMap(({ name, path }) => {
    if (!name.includes("*")) return [`fleetd${name.slice(1)}`];
    const [before, after] = path.split("*") as [string, string];
    const files = readdirSync(join(ROOT, before)).filter((f) => f.endsWith(after));
    return files.sort().map((f) => `fleetd${name.slice(1).replace("*", f.slice(0, f.length - after.length))}`);
  });
}

test("a project outside the repo installs the package, imports every entry point and typechecks", () => {
  mkdirSync(join(dir, "pack"));
  expect(bun(["pm", "pack", "--destination", join(dir, "pack")], ROOT).code).toBe(0);
  const [tarball] = readdirSync(join(dir, "pack"));
  mkdirSync(project);
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify({ name: "outside", private: true, type: "module", dependencies: { fleetd: join(dir, "pack", tarball!) } }),
  );
  expect(bun(["install"])).toMatchObject({ code: 0 });
  // The one thing the project has besides the package: Bun's types, fleetd's own copy.
  mkdirSync(join(project, "node_modules/@types"));
  symlinkSync(join(ROOT, "fleetd/node_modules/@types/bun"), join(project, "node_modules/@types/bun"));

  const names = entries();
  expect(names.length).toBeGreaterThan(90);
  // The two schemas the package's own modules read as text load as text here too: one loader per file.
  const asText = (name: string) => /\/(McpTools|LeadCall)\.json$/.test(name);
  writeFileSync(
    join(project, "main.ts"),
    [
      ...names.map((name, i) => `import ${name.endsWith(".json") ? `m${i}` : `* as m${i}`} from "${name}"${asText(name) ? ` with { type: "text" }` : ""};`),
      `const all: unknown[] = [${names.map((_, i) => `m${i}`).join(", ")}];`,
      `console.log(all.filter((m) => m !== undefined).length);`,
    ].join("\n"),
  );
  expect(bun(["main.ts"])).toEqual({ code: 0, out: String(names.length) });
  expect(typecheck("main.ts")).toEqual({ code: 0, out: "" });

  // The tool prompt relay runs outside the hub, on the importer's own requests: a prompt files a card, a prompt gone
  // closes it, and an approval answers the tool with exactly the input shown.
  writeFileSync(join(project, "prompts.ts"), PROMPTS);
  expect(bun(["prompts.ts"])).toEqual({
    code: 0,
    out: JSON.stringify({
      filed: [["Q1", "denied", "expired: the run ended"], ["Q2", "approved", "allowed on devbox, answered by human:desk"]],
      answers: [{ behavior: "allow", updatedInput: { command: "ls" } }],
      project: { machineId: "devbox", projectId: "P1" },
      confirmPays: true,
      personOnly: false,
      alwaysAsks: true,
      plainVisit: false,
      said: "Let through without asking you: `Bash`: ls. The checker's reason: asked for",
      logged: "`Bash`: ls",
    }),
  });
  expect(typecheck("prompts.ts")).toEqual({ code: 0, out: "" });

  // A notification as fleetd cloud makes one, sealed with the hub's code, read by the phone's own reader: it opens
  // whole and tapping it goes to that hub's Devices.
  writeFileSync(join(project, "push.ts"), PUSH);
  expect(bun(["push.ts"])).toEqual({
    code: 0,
    out: JSON.stringify({
      route: "devices",
      shown: { title: "New sign-in", channel: "other", route: { t: "devices", hub: "https://acme.fleetd.test" } },
      stranger: null,
    }),
  });
  expect(typecheck("push.ts")).toEqual({ code: 0, out: "" });

  // A type the package exports is the real one, not `any`: a wrong use fails.
  writeFileSync(join(project, "wrong.ts"), `import { TOOL_LIST } from "fleetd/tools";\nexport const n: number = TOOL_LIST[0]!.name;\n`);
  expect(typecheck("wrong.ts").out).toContain("wrong.ts(2,14): error TS2322");

  // `exports` is the whole list: a file of the repo it doesn't name can't be imported.
  writeFileSync(join(project, "deep.ts"), `import { Hub } from "fleetd/fleetd/src/hub/api/hub.ts";\nconsole.log(Hub);\n`);
  expect(bun(["deep.ts"]).code).not.toBe(0);
  expect(typecheck("deep.ts").out).toContain("error TS2307");
}, 120_000);

/** The prompt relay and the project's prompt rules through the package, as fleetd cloud drives them over its own store. */
const PROMPTS = `
import type { HubEvent, HumanRequest } from "fleetd/contracts";
import { projectOf } from "fleetd/hub/approvals/names";
import { answerPrompt, onThreadEvent } from "fleetd/hub/approvals/permissions";
import { personOnly } from "fleetd/hub/approvals/person_only";
import { defaultHooks, type PermissionDecision, type PromptApprovals } from "fleetd/hub/approvals/ports";
import { alwaysAsks, autoApprovedEntry, autoApprovedText } from "fleetd/hub/project_lead/checker_rules";
import { TOOL } from "fleetd/hub/project_lead/confirm_rules";
import { promptVerdict, visitCarriesData } from "fleetd/hub/project_lead/prompt_rules";

const at = "2026-01-01T00:00:00.000Z";
const rows: HumanRequest[] = [];
const answers: PermissionDecision[] = [];
let pending = { requestId: "r1", toolName: "Bash", summary: "ls", input: { command: "ls" } as unknown };
const row = (id: string) => rows.find((r) => r.requestId === id)!;
const a: PromptApprovals = {
  deps: {
    hooks: { ...defaultHooks(), isLead: async () => true },
    hub: { mcpServers: async () => [], wakeRequest: async () => {} },
    nodes: { answerPermission: async (_m, _t, _r, d) => void answers.push(d), pendingPermission: async () => pending },
    clock: { now: () => 0 },
    events: { append: () => {}, head: () => 0, wait: async () => ({ events: [], cursor: 0 }) },
  },
  checking: new Set(),
  idle: new Set(),
  now: () => at,
  listQuiet: (f) => rows.filter((r) => (!f.states || f.states.includes(r.state)) && (!f.kind || r.kind === f.kind)),
  create: (add) => {
    const r: HumanRequest = { requestId: "Q" + (rows.length + 1), projectRef: add.projectRef, kind: add.kind, text: add.text, state: "open", createdAt: add.at, permission: add.permission };
    rows.push(r);
    return r;
  },
  changeFrom: (id, from, f) => {
    if (row(id).state !== from) throw new Error(id + " is not " + from);
    f(row(id));
    return row(id);
  },
  reopen: (id) => a.changeFrom(id, "approved", (r) => void (r.state = "open")),
  note: (id, evidence) => Object.assign(row(id), { evidence }),
  quietly: (f) => {
    try {
      return f();
    } catch {
      return undefined;
    }
  },
};
const event = (seq: number, type: string, requestId?: string): HubEvent => ({
  seq, at, type, summary: type, machineId: "devbox", projectId: "P1", threadId: "T1",
  ...(requestId ? { data: { permission: { requestId, toolName: "Bash", summary: "ls" } } } : {}),
});
await onThreadEvent(a, event(1, "thread.waiting", "r1"));
await onThreadEvent(a, event(2, "thread.completed"));
pending = { ...pending, requestId: "r2" };
await onThreadEvent(a, event(3, "thread.waiting", "r2"));
Object.assign(row("Q2"), { state: "approved", answeredBy: "human:desk" });
await answerPrompt(a, row("Q2"), undefined);
const pay = promptVerdict(TOOL, { site: "a.example", button: "Pay now", does: "Pays" }, undefined);
const spend = { server: "shop", tool: "buy", action: "spend", title: "Buy", input: "{}" } as const;
console.log(JSON.stringify({
  filed: rows.map((r) => [r.requestId, r.state, r.evidence]),
  answers,
  project: projectOf(row("Q1")),
  confirmPays: pay !== undefined && "deny" in pay,
  personOnly: personOnly(row("Q2")),
  alwaysAsks: alwaysAsks({ tool: "mcp__shop__buy", summary: "", input: {}, preview: spend }),
  plainVisit: visitCarriesData({ url: "https://a.example/" }),
  said: autoApprovedText({ tool: "Bash", summary: "ls", input: {} }, "checker", "asked for"),
  logged: autoApprovedEntry({ tool: "Bash", summary: "ls", input: {} }, "yolo", undefined, 0).what,
}));
`;

/** A "New sign-in" notice sealed as fleetd cloud seals one, opened and shown by the phone's reader through the package. */
const PUSH = `
import { openPayload, shownOf } from "fleetd/apps/push";
import { payloadJson, type PushPayload } from "fleetd/hub/push/payload";
import { openSealed, publicKeyOf, seal } from "fleetd/shared/sealed_box_core";

const secret = new Uint8Array(32).fill(7);
const p: PushPayload = { v: 1, kind: "alert", title: "New sign-in", body: "MacBook signed in to acme as you.", hub: "https://acme.fleetd.test", route: "devices", at: "2026-01-01T00:00:00.000Z" };
const c = Buffer.from(seal(publicKeyOf(secret), payloadJson(p))).toString("base64");
const opened = openPayload(c, (box) => openSealed(secret, box));
const shown = opened === null ? undefined : shownOf(opened);
console.log(JSON.stringify({
  route: opened?.route,
  shown: { title: shown?.title, channel: shown?.channel, route: shown?.route },
  stranger: openPayload(c, (box) => openSealed(new Uint8Array(32).fill(8), box)),
}));
`;
