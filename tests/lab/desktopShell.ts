// The Electron app's main process against the real hub (`npm run lab -- desktop`; needs `pnpm build` in app/desktop).
// The built app runs with the lab key from FLEETD_HUB_URL/FLEETD_AGENT_KEY and a throwaway FLEETD_HOME, and the page
// is driven over the DevTools protocol through window.fleetd, exactly as the renderer uses it:
// 1. auth + snapshot: the state goes live and a snapshot with both lab machines arrives;
// 2. call: fleetd_status answers, an unknown tool comes back as not_found, a malformed request is refused in main;
// 3. live: a board subscription gets a full frame;
// 4. events: stopping and starting lab-b's node streams machine.offline and machine.online;
// 5. liveness: with live frames off, a quiet link stays live for 50 s (the client pings; the hub answers);
// 6. reconnect: a hub restart shows retrying, then live with a fresh snapshot, and events and live flow again;
// 7. pairing through window.fleetd.hub.connect: a refused key (close 4401) stops at the refused state; the right key
//    goes live, is saved (0600, never in the page), and a relaunch connects from the saved key.
// The key never reaches the page. No claude turns.
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { type Body, type Lab, onCleanup, recordPid, REPO, scrubbedEnv, slotPort } from "./harness.ts";

const DESKTOP = path.join(REPO, "app/desktop");
const MAIN = path.join(DESKTOP, "out/main/index.js");
/** Slot-0 DevTools ports for the two app instances; they differ mod 20 from the other lab ports. */
const DEVTOOLS = [4788, 4789] as const;
const MACHINE = "lab-b";

interface Page {
  readonly eval: <A>(expression: string) => Promise<A>;
  /** Resolves once the app (when launched here) has exited. */
  readonly close: () => Promise<void>;
}

/** One DevTools connection to the app's page; `eval` awaits promises and returns JSON values. */
const connectPage = async (port: number): Promise<Page> => {
  const pages = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as Array<Body>;
  const page = pages.find((p) => p.type === "page" && String(p.url).startsWith("app://fleetd/"));
  if (page === undefined) throw new Error(`no app page on DevTools port ${port}`);
  const ws = new WebSocket(String(page.webSocketDebuggerUrl));
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
  let next = 0;
  const waiting = new Map<number, (message: Body) => void>();
  ws.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as Body;
    waiting.get(message.id)?.(message);
    waiting.delete(message.id);
  });
  return {
    eval: async <A>(expression: string) => {
      const id = ++next;
      const answer = new Promise<Body>((resolve) => waiting.set(id, resolve));
      ws.send(JSON.stringify({ id, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
      const message = await answer;
      if (message.result?.exceptionDetails !== undefined) throw new Error(`page threw: ${JSON.stringify(message.result.exceptionDetails)}`);
      return message.result?.result?.value as A;
    },
    close: async () => ws.close(),
  };
};

/** Launches the built app, with the hub and key for this run only or (null) its saved ones; stopped by its PID. */
const launch = async (lab: Lab, name: string, port: number, hub: { url: string; key: string } | null, fresh = true): Promise<Page> => {
  // Electron fetches its binary on first use and prints its progress to stdout, so the path comes after a marker.
  const out = execFileSync(process.execPath, ["-e", "process.stdout.write('\\n@electron=' + require('electron') + '\\n')"], { cwd: DESKTOP, encoding: "utf8" });
  const electron = /^@electron=(.+)$/mu.exec(out)?.[1];
  if (electron === undefined || !fs.existsSync(electron)) throw new Error(`no Electron binary from app/desktop: ${out}`);
  const home = path.join(lab.dir, name);
  if (fresh) fs.rmSync(home, { recursive: true, force: true });
  fs.mkdirSync(home, { recursive: true });
  const display = Object.fromEntries(
    ["DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR"].flatMap((k) => (process.env[k] ? [[k, process.env[k]]] : [])),
  ) as Record<string, string>;
  const args = [MAIN, `--user-data-dir=${path.join(home, "chromium")}`, `--remote-debugging-port=${port}`];
  // chrome-sandbox isn't SUID root in an unprivileged checkout; without a display, Chromium draws offscreen.
  if (process.platform === "linux") {
    args.push("--no-sandbox", ...(display.DISPLAY === undefined && display.WAYLAND_DISPLAY === undefined ? ["--ozone-platform=headless"] : []));
  }
  const log = fs.openSync(path.join(home, "app.log"), "a");
  const child = spawn(electron, args, {
    cwd: DESKTOP,
    env: {
      ...scrubbedEnv(),
      ...display,
      ...(hub === null ? {} : { FLEETD_HUB_URL: hub.url, FLEETD_AGENT_KEY: hub.key }),
      FLEETD_HOME: path.join(home, "fleetd"),
    },
    stdio: ["ignore", log, log],
  });
  recordPid(child.pid, electron);
  const quit = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    await exited;
  };
  onCleanup(quit);
  const page = await lab.until(`${name} app's page`, 30_000, async () => connectPage(port).catch(() => undefined));
  // The page target shows up before the document has loaded, and with it the preload's bridge.
  await lab.until(`${name} app's window.fleetd`, 30_000, async () => ((await page.eval<boolean>(`document.readyState === "complete" && typeof window.fleetd === "object"`)) ? true : undefined));
  // Every frame main sends, in order, as the renderer's store would see them.
  await page.eval(`(window.__frames = [], window.fleetd.hub.subscribe((f) => window.__frames.push(f)), true)`);
  return {
    ...page,
    close: async () => {
      await page.close();
      await quit();
    },
  };
};

export async function desktopShell(lab: Lab) {
  const { check, ok, until } = lab;
  check(fs.existsSync(MAIN), `${MAIN} is missing; run pnpm install && pnpm build in app/desktop`);
  fs.mkdirSync(lab.dir, { recursive: true });

  const app = await launch(lab, "app", slotPort(DEVTOOLS[0]), { url: lab.hubUrl, key: lab.key });
  const frames = () => app.eval<Array<Body>>("window.__frames");
  const states = async () => (await frames()).flatMap((f) => (f.t === "state" ? [f.state.phase as string] : []));
  const count = async (t: string) => (await frames()).filter((f) => f.t === t).length;

  // 1. auth + snapshot
  const snapshot = await until("live with a snapshot", 30_000, async () => {
    const all = await frames();
    const live = all.some((f) => f.t === "state" && f.state.phase === "live" && typeof f.state.protocol === "number");
    return live ? all.find((f) => f.t === "snapshot")?.snapshot : undefined;
  });
  const machines = (snapshot.machines as Array<Body>).map((m) => `${m.machineId}=${m.status}`).sort();
  check(machines.join(",") === "lab-a=online,lab-b=online", `snapshot machines: ${machines.join(",")}`);
  ok(`auth + snapshot: ${(await states()).join(" -> ")}, cursor ${snapshot.cursor}, ${machines.join(", ")}`);

  // 2. call
  const status = await app.eval<Body>(`window.fleetd.hub.call("fleetd_status", {})`);
  check(status.ok === true && Array.isArray(status.output.machines), `fleetd_status over IPC: ${JSON.stringify(status).slice(0, 300)}`);
  const unknown = await app.eval<Body>(`window.fleetd.hub.call("no_such_tool", {})`);
  check(unknown.ok === false && unknown.error.code === "not_found", `unknown tool: ${JSON.stringify(unknown)}`);
  const invalid = await app.eval<string>(`window.fleetd.hub.call("Bad Tool", {}).then(() => "accepted", (e) => String(e))`);
  check(invalid.includes("invalid request"), `main refuses a malformed request: ${invalid}`);
  ok(`call: fleetd_status ok (${status.output.machines.length} machines); unknown tool -> ${unknown.error.code}; malformed request refused in main`);

  // 3. live
  await app.eval(`window.fleetd.hub.live({ board: true })`);
  const live = await until("a full live frame", 15_000, async () => (await frames()).find((f) => f.t === "live" && f.frame.full === true)?.frame);
  ok(`live: full frame with ${(live.lanes as Array<unknown>).length} lanes, ${(live.machines as Array<unknown> | undefined)?.length ?? 0} machines`);

  // 4. events after the snapshot's cursor
  const seen = async (type: string, after: number) =>
    (await frames()).find((f) => f.t === "event" && f.event.type === type && f.event.machineId === MACHINE && f.event.seq > after)?.event;
  await lab.stopNode(MACHINE);
  const offline = await until(`machine.offline for ${MACHINE}`, 120_000, () => seen("machine.offline", snapshot.cursor));
  lab.startNode(MACHINE);
  const online = await until(`machine.online for ${MACHINE}`, 120_000, () => seen("machine.online", offline.seq));
  const seqs = (await frames()).flatMap((f) => (f.t === "event" ? [f.event.seq as number] : []));
  check(
    seqs.every((s, i) => i === 0 || s > seqs[i - 1]!),
    `event seqs only increase: ${seqs.join(",")}`,
  );
  ok(`events: machine.offline #${offline.seq}, machine.online #${online.seq}, ${seqs.length} events in order after cursor ${snapshot.cursor}`);

  // 5. liveness
  await app.eval(`window.fleetd.hub.live(null)`);
  const quietFrom = (await frames()).length;
  await new Promise((r) => setTimeout(r, 50_000));
  const quiet = (await frames()).slice(quietFrom);
  check(!quiet.some((f) => f.t === "state"), `a quiet link stays live: ${JSON.stringify(quiet.filter((f) => f.t === "state"))}`);
  await app.eval(`window.fleetd.hub.live({ board: true })`);
  ok(`liveness: 50 s with ${quiet.length} frames and no state change`);

  // 6. reconnect
  const snapshotsBefore = await count("snapshot");
  const statesBefore = (await states()).length;
  await lab.startHub();
  await until("live again after the hub restart", 60_000, async () => {
    const after = (await states()).slice(statesBefore);
    return after.includes("retrying") && after.at(-1) === "live" && (await count("snapshot")) > snapshotsBefore ? true : undefined;
  });
  const lastSnapshot = (await frames()).findLast((f) => f.t === "snapshot")!.snapshot;
  await lab.stopNode(MACHINE);
  await until(`machine.offline after the reconnect`, 120_000, () => seen("machine.offline", lastSnapshot.cursor));
  lab.startNode(MACHINE);
  await until(`machine.online after the reconnect`, 120_000, () => seen("machine.online", lastSnapshot.cursor));
  await until("a full live frame after the reconnect", 15_000, async () => {
    const all = await frames();
    return all.slice(all.findLastIndex((f) => f.t === "snapshot")).find((f) => f.t === "live" && f.frame.full === true);
  });
  ok(`reconnect: ${(await states()).slice(statesBefore).join(" -> ")}, fresh snapshot at cursor ${lastSnapshot.cursor}, events and live resumed`);

  check(!JSON.stringify(await frames()).includes(lab.key), "the key never reaches the page");

  // 7. pairing
  const pairPort = slotPort(DEVTOOLS[1]);
  let pairing = await launch(lab, "pairing", pairPort, null);
  const phase = async () => (await pairing.eval<Body>("window.fleetd.hub.state()")).phase as string;
  check((await phase()) === "unpaired", "a fresh home starts unpaired");
  const unpairedCall = await pairing.eval<Body>(`window.fleetd.hub.call("fleetd_status", {})`);
  check(unpairedCall.ok === false && unpairedCall.error.code === "offline", `a call while unpaired: ${JSON.stringify(unpairedCall)}`);
  const badUrl = await pairing.eval<Body>(`window.fleetd.hub.connect("ftp://hub", "k")`);
  check(badUrl.ok === false, `a bad URL is refused before anything is saved: ${JSON.stringify(badUrl)}`);
  await pairing.eval(`window.fleetd.hub.connect(${JSON.stringify(lab.hubUrl)}, "fld_${"a".repeat(26)}")`);
  const refused = await until("the refused state", 30_000, async () => {
    const state = await pairing.eval<Body>("window.fleetd.hub.state()");
    return state.phase === "refused" ? state : undefined;
  });
  ok(`refused key: "${refused.message}"`);
  await pairing.eval(`window.fleetd.hub.connect(${JSON.stringify(lab.hubUrl)}, ${JSON.stringify(lab.key)})`);
  await until("live after pairing", 30_000, async () => ((await phase()) === "live" ? true : undefined));
  const fleetdHome = path.join(lab.dir, "pairing", "fleetd");
  const saved = fs.readdirSync(fleetdHome).filter((f) => f.startsWith("desktop-hub."));
  check(saved.length === 1, `one saved key file in ${fleetdHome}: ${saved.join(",")}`);
  const mode = fs.statSync(path.join(fleetdHome, saved[0]!)).mode & 0o777;
  check(mode === 0o600, `the saved key is 0600, not ${mode.toString(8)}`);
  check(!JSON.stringify(await pairing.eval("window.__frames")).includes(lab.key), "the key never reaches the page");
  await pairing.close();
  pairing = await launch(lab, "pairing", pairPort, null, false);
  await until("live from the saved key after a relaunch", 30_000, async () => ((await phase()) === "live" ? true : undefined));
  await pairing.eval(`window.fleetd.hub.forget()`);
  check((await phase()) === "unpaired" && !fs.readdirSync(fleetdHome).some((f) => f.startsWith("desktop-hub.")), "forget deletes the saved key");
  ok(`pairing: refused -> live, saved as ${saved[0]} (0600), relaunch connects from it, forget deletes it`);
  await pairing.close();
  await app.close();
}
