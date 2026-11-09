// The app's setup fixtures (app/desktop/fixtures/setup/steps.json) are the hub's own setup catalog answering:
// `setup_list`, and `setup_test` for a hub `fleetd init` just made on devbox, read from the checks the doctor would
// report at each point. The app keeps no catalog of its own, so its screenshots and tests show exactly what a hub says.
//
//   bun scripts/setup-fixtures.ts           writes the file
//   bun scripts/setup-fixtures.ts --check   writes nothing, fails while it differs (CI)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeFirstUse, guides, read, requiredLeft } from "../src/hub/setup/index.ts";
import { claudeKey, claudeOwner, ghAuth, hubReachable, setupChecks } from "../src/hub/doctor/checks.ts";
import type { ClaudeSetupView } from "../src/hub/doctor/checks.ts";
import type { DoctorCheck, DoctorStatus, GithubApp, HubSetupStep } from "../src/shared/contracts.ts";

const ROOT = join(import.meta.dir, "../../..");
const PATH = "app/desktop/fixtures/setup/steps.json";

/** The fixtures' hub (app/desktop/fixtures/kit HUB): a tailnet name would fail their leak check. */
const HUB = "http://devbox:4790";
const AT = "2026-10-19T09:01:35.585Z";
/** A local build's version, so the guides' commands name no release. */
const VERSION = "0.0.0";

const machine = (name: string, status: DoctorStatus, message: string): DoctorCheck => ({
  id: `devbox/${name}`,
  scope: "machine",
  machineId: "devbox",
  status,
  message,
});

const gh = (loggedIn: boolean) =>
  ghAuth({ ran: true, exitCode: loggedIn ? 0 : 1, stdout: "", stderr: loggedIn ? "Logged in to github.com account dev" : "" });

/** The hub's Claude accounts: a tested API key, or none (and the owner, Dev, with no subscription). */
function claude(key: boolean): DoctorCheck[] {
  const view: ClaudeSetupView = {
    configured: key,
    hubApi: key
      ? { updatedAt: AT, sealedOn: [{ machineId: "devbox", fingerprint: "5ec2e7a1" }], lastTest: { at: AT, machineId: "devbox", ok: true } }
      : undefined,
    owner: ["Dev"],
    machines: ["devbox"],
  };
  return [claudeKey(view), claudeOwner(view)];
}

/** Where the hub is after each point of a first run. */
type Point = { key: boolean; logins: boolean; github: boolean };

const GITHUB_APP = {
  appId: 1048576, slug: "fleetd-on-devbox", name: "fleetd on devbox", clientId: "Iv23liQ4fXk8w2ZsT0aB",
  owner: "acme", htmlUrl: "https://github.com/apps/fleetd-on-devbox",
  settingsUrl: "https://github.com/organizations/acme/settings/apps/fleetd-on-devbox", createdAt: AT,
  installations: [{ installationId: 51234567, account: "acme", allRepositories: false,
    repositoryCount: 2, repositories: ["acme/storefront", "acme/api"] }],
  lastTest: { at: AT, ok: true, said: "\"fleetd on devbox\" is installed on acme (2 repositories), and its tokens work." },
} as GithubApp;

function doctorAt(p: Point): DoctorCheck[] {
  return [
    hubReachable("http://127.0.0.1:4790/healthz", { ok: true }, ""),
    {
      id: "hub/https",
      scope: "hub",
      status: "ok",
      message: `The hub's address ${HUB} is plain HTTP, which is fine: it stays inside your tailnet's encrypted tunnel.`,
    },
    gh(p.github),
    machine("online", "ok", "devbox is online."),
    p.logins
      ? machine("claude_login", "ok", "devbox: claude is logged in.")
      : machine("claude_login", "fail", "devbox: claude is not logged in, so its sessions can't start."),
    ...claude(p.key),
    ...setupChecks({ joined: [], githubApp: p.github ? GITHUB_APP : undefined, onepassword: [] }),
  ];
}

/** The checks at `p`, on a hub with no project yet (the fixtures' empty hub). */
const checksAt = (p: Point) => beforeFirstUse(doctorAt(p), 0);

/** What a read adds to a step's guide: its status and what its checks say. The guides are written once. */
const reads = (steps: HubSetupStep[]) =>
  Object.fromEntries(steps.map((s) => [s.id, { status: s.status, said: s.said, way: s.way, fix: s.fix, failing: s.failing }]));

/** One fixture: `setup_list` now, and `setup_test` of each step as `after` finds it. */
function scenario(now: Point, after: Point) {
  const steps = read(guides(HUB, VERSION), checksAt(now));
  return {
    requiredLeft: steps.filter(requiredLeft).length,
    list: reads(steps),
    tests: reads(read(guides(HUB, VERSION), checksAt(after))),
  };
}

/** Object keys sorted at every level, as the file has always been written. */
function sorted(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sorted);
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])]));
}

export function fixtures(): string {
  const fresh: Point = { key: false, logins: false, github: false };
  const key = { ...fresh, key: true };
  const github = { ...key, github: true };
  const logins = { ...fresh, logins: true };
  const all = {
    hub: HUB,
    guides: guides(HUB, VERSION),
    scenarios: {
      "setup-fresh": scenario(fresh, fresh),
      "setup-claude-logins": scenario(logins, logins),
      "setup-github": scenario(key, github),
      "setup-done": scenario(github, github),
    },
  };
  return `${JSON.stringify(sorted(all), null, 2)}\n`;
}

if (import.meta.main) {
  const path = join(ROOT, PATH);
  const text = fixtures();
  let saved = "";
  try {
    saved = readFileSync(path, "utf8");
  } catch {}
  if (saved === text) {
    console.log(`setup-fixtures: ${PATH} is current`);
  } else if (process.argv.includes("--check")) {
    console.log(`::error file=${PATH}::${PATH} is out of date; run \`bun scripts/setup-fixtures.ts\` in experimental/bun and commit it`);
    process.exit(1);
  } else {
    writeFileSync(path, text);
    console.log(`setup-fixtures: wrote ${PATH}`);
  }
}
