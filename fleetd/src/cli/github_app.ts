// `fleetd github-app [create|test|remove]`: the hub's own GitHub App, from the
// hub machine, on src/hub/github_app. It opens the hub home's database directly; the running hub reads the App's row
// at its next GitHub call. `create` serves the manifest page on a loopback port, as the desktop app does, and trades
// GitHub's code for the App's keys, which go straight into the hub's sealed row.
import type { GithubApp } from "../shared/contracts.ts";
import { systemClock } from "../shared/clock.ts";
import { Hub } from "../hub/api/hub.ts";
import { githubApps, type GithubApps, manifest, newAppPage } from "../hub/github_app/index.ts";
import type { HubDb } from "../hub/store/db.ts";
import { ArgError, parse } from "./args.ts";
import { eprintln, isLiveHubHome, liveHubRefusal, println, readSetup, resolveHome } from "./common.ts";
import { localHostName, machineIdFromHost } from "./project.ts";
import { openHub, secret } from "./store.ts";
import { GITHUB_APP_USAGE } from "./usages.ts";
export { GITHUB_APP_USAGE };

/** How long GitHub's form may take: reading it, renaming the App, signing in. */
const WAIT_MS = 15 * 60_000;

function usage(message: string): number {
  process.stderr.write(`fleetd: ${message}\n\nusage:\n${GITHUB_APP_USAGE}`);
  return 2;
}

export async function githubAppCommand(argv: string[]): Promise<number> {
  const v = parse(argv, { options: { org: "str", name: "str", port: "str" }, positionals: true });
  if (v instanceof ArgError) return usage(v.message);
  const home = resolveHome();
  const verb = v.positionals[0];
  if ((verb === "create" || verb === "remove") && isLiveHubHome(home)) {
    eprintln(`fleetd: ${liveHubRefusal(`github-app ${verb}`)}`);
    return 1;
  }
  let db: HubDb;
  try {
    db = openHub(home);
  } catch (error) {
    eprintln(`fleetd: ${(error as Error).message}`);
    return 1;
  }
  const hub = new Hub({ home, listen: { host: "127.0.0.1", port: 4790 } }, db, systemClock);
  const apps = githubApps(hub);
  try {
    switch (v.positionals[0]) {
      case undefined:
        show(apps);
        return 0;
      case "create": {
        const org = v.str("org");
        if (org !== undefined && !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(org)) {
          return usage("--org takes an organization's login, as in github.com/<login>");
        }
        const rawPort = v.str("port");
        const port = rawPort === undefined ? 0 : /^\+?[0-9]+$/.test(rawPort) && Number(rawPort) <= 65535 ? Number(rawPort) : NaN;
        if (Number.isNaN(port)) return usage("--port takes a port number");
        return await create(apps, home, org, v.str("name"), port);
      }
      case "test":
        return await test(apps);
      case "remove":
        return await remove(apps);
      default:
        return usage(`unknown github-app command '${v.positionals[0]}'`);
    }
  } catch (error) {
    eprintln(`fleetd: ${(error as Error).message}`);
    return 1;
  } finally {
    db.conn.close();
  }
}

const installLink = (app: GithubApp) => `https://github.com/apps/${app.slug}/installations/new`;

function describe(app: GithubApp) {
  println(`${app.name} (${app.settingsUrl}), owned by ${app.owner}`);
  const installations = app.installations ?? [];
  if (installations.length === 0) println(`  not installed yet: ${installLink(app)}`);
  for (const i of installations) {
    const reach = i.allRepositories ? `all ${i.repositoryCount} repositories` : `${i.repositoryCount} chosen repositories`;
    println(`  installed on ${i.account}: ${reach}`);
  }
  if (app.lastTest) println(`  last test ${app.lastTest.at}: ${app.lastTest.said}`);
}

function show(apps: GithubApps) {
  const app = apps.get();
  if (app) describe(app);
  else {
    println(
      "This hub has no GitHub App yet: `fleetd github-app create`, or Settings › Hub accounts › GitHub in the app.\nUntil then the hub's gh uses this machine's own login.",
    );
  }
}

async function test(apps: GithubApps): Promise<number> {
  const app = await apps.test();
  if (!app) throw new Error("this hub has no GitHub App yet: `fleetd github-app create`");
  describe(app);
  return app.lastTest?.ok === true ? 0 : 1;
}

async function remove(apps: GithubApps): Promise<number> {
  const app = await apps.remove();
  if (!app) throw new Error("this hub has no GitHub App");
  println(`Forgot ${app.name}. GitHub keeps it until you delete it there: ${app.settingsUrl}/advanced`);
  return 0;
}

const escape = (t: string) => t.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/** The page the browser opens first: it posts the manifest to GitHub at once, with a button in case scripts are off. */
export function postPage(postTo: string, state: string, manifestText: string): string {
  return `<!doctype html><meta charset="utf-8"><title>fleetd</title><body style="font:14px/1.5 system-ui,sans-serif;color:#444;margin:3rem"><form id="f" method="post" action="${escape(postTo)}?state=${escape(state)}"><input type="hidden" name="manifest" value="${escape(manifestText)}"><p>Taking you to GitHub to create the hub's App…</p><button>Continue to GitHub</button></form><script>document.getElementById('f').submit()</script></body>`;
}

/** The page the browser lands on after GitHub. */
const landing = (title: string, line: string) =>
  new Response(
    `<!doctype html><meta charset="utf-8"><title>fleetd</title><body style="font:14px/1.5 system-ui,sans-serif;color:#444;margin:3rem"><p style="font-weight:600;color:#111">${title}</p><p>${line}</p></body>`,
    { headers: { "content-type": "text/html; charset=utf-8" } },
  );

async function create(apps: GithubApps, home: string, org: string | undefined, givenName: string | undefined, port: number): Promise<number> {
  let setup;
  try {
    setup = readSetup(home);
  } catch {}
  const hubUrl = setup?.url ?? "http://127.0.0.1:4790";
  const localId = setup ? Object.entries(setup.machines).find(([, m]) => m.local)?.[0] : undefined;
  const name = [...(givenName ?? `fleetd on ${localId ?? machineIdFromHost(localHostName())}`)].slice(0, 34).join("");
  const state = secret("s_");
  let resolveCode: (code: string) => void = () => {};
  const code = new Promise<string>((resolve) => (resolveCode = resolve));
  let taken = false;
  let server: ReturnType<typeof Bun.serve>;
  let page = "";
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
        if (url.pathname !== "/created") return new Response(null, { status: 404 });
        if (url.searchParams.get("state") !== state) return landing("This isn't fleetd's page", "Go back to the terminal and run it again.");
        const c = url.searchParams.get("code");
        if (c === null || !/^[A-Za-z0-9_-]{1,200}$/.test(c)) return landing("No App was created", "GitHub sent no code. Go back to the terminal.");
        if (taken) return landing("Already done", "Go back to the terminal.");
        taken = true;
        resolveCode(c);
        return landing("The App is created", "fleetd keeps its keys on the hub. You can close this tab and go back to the terminal.");
      },
    });
  } catch (error) {
    throw new Error(`can't listen on 127.0.0.1:${port}: ${(error as Error).message}`);
  }
  const at = server.port;
  const redirect = `http://127.0.0.1:${at}/created`;
  page = postPage(newAppPage(apps.endpoints().web, org), state, JSON.stringify(manifest(name, hubUrl, redirect)));
  const link = `http://127.0.0.1:${at}/`;
  println(`Creating "${name}" on GitHub${org === undefined ? "" : ` in ${org}`}.`);
  println(`Open ${link} in a browser on this machine, then press Create on GitHub's page.`);
  println(`From another computer: ssh -L ${at}:127.0.0.1:${at} <this machine>, then open it there.`);
  try {
    Bun.spawnSync([process.platform === "darwin" ? "open" : "xdg-open", link], { stdout: "ignore", stderr: "ignore" });
  } catch {}
  let timer: ReturnType<typeof setTimeout> | undefined;
  const got = await Promise.race([code, new Promise<undefined>((r) => (timer = setTimeout(() => r(undefined), WAIT_MS)))]);
  clearTimeout(timer);
  // The landing page is sent before the server goes.
  await Bun.sleep(200);
  server.stop(true);
  if (got === undefined) throw new Error("GitHub didn't send the App back within 15 minutes; run it again");
  const app = await apps.create(got);
  println(`✓ The hub has its GitHub App: ${app.name} (${app.htmlUrl})`);
  println(`Next: install it on the repositories fleetd works on, ${installLink(app)}\nthen run \`fleetd github-app test\`.`);
  return 0;
}
