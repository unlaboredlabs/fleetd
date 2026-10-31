// `npm run lab -- screens`: how long a person's screen takes from screen_open to its first live frame, stage by stage
// (W245). On lab-a, through the desktop app's protocol (a human key on the hub's /app WebSocket): screen_open, then
// browser_watch, until the first browser_frame, as the app's New screen and its live view do. Browser screens run
// warm (a browser from the node's pool) and cold (pool 0); Linux desktop screens too where FLEETD_LAB_XVFB names an
// Xvfb (its folder goes first on the node's PATH, so a window manager there is found). The hub and node log each
// stage at debug (FLEETD_LOG=info,fleetd::stages=debug); each run's stages and the medians are printed, and written to
// RUN/screens/bench.json. FLEETD_LAB_SCREEN_RUNS sets the runs per kind and mode (default 6). The browser is the
// user's own install (~/.fleetd/node/browser), so nothing is downloaded.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type Body, cli, HUB_PORT, type Lab, nodeHome, RUN } from "./harness.ts";

const MACHINE = "lab-a";
const RUNS = Number(process.env.FLEETD_LAB_SCREEN_RUNS ?? 6);
const LOG_FILTER = "info,fleetd::stages=debug";
const USER_BROWSER = path.join(os.homedir(), ".fleetd/node/browser");

/** The newest of a pinned install's folders, as the node finds it (chrome.rs `newest`). */
const newest = (root: string, prefix: string) =>
  fs.existsSync(root)
    ? fs
        .readdirSync(root)
        .filter((d) => d.startsWith(prefix))
        .toSorted()
        .map((d) => path.join(root, d))
        .at(-1)
    : undefined;

/** One /app session with `key`: the calls and frames the desktop app's client gets, minus the window. */
const appSession = async (key: string) => {
  const ws = new WebSocket(`ws://127.0.0.1:${HUB_PORT}/app`);
  const waiting = new Map<string, { resolve: (v: Body) => void; reject: (e: Error) => void }>();
  const frames = new Map<string, () => void>();
  let ready: (() => void) | undefined;
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data)) as Body;
    if (m.t === "ready") ready?.();
    if (m.t === "browser_frame") {
      frames.get(m.sessionId as string)?.();
      frames.delete(m.sessionId as string);
      return;
    }
    const w = typeof m.id === "string" ? waiting.get(m.id) : undefined;
    if (w === undefined) return;
    waiting.delete(m.id);
    if (m.t === "result") w.resolve(m.output as Body);
    else w.reject(new Error(`${m.code}: ${m.message}`));
  };
  await new Promise<void>((resolve, reject) => {
    ready = resolve;
    ws.onopen = () => ws.send(JSON.stringify({ t: "auth", key }));
    ws.onerror = () => reject(new Error("cannot open /app"));
  });
  let nextId = 0;
  const call = (tool: string, input: Record<string, unknown> = {}) =>
    new Promise<Body>((resolve, reject) => {
      const id = `c${++nextId}`;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ t: "call", id, tool, input }));
    });
  /** Watches `session` and resolves at its first frame, or rejects after `ms`. */
  const firstFrame = (session: string, ms: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`no frame from ${session} in ${ms} ms`)), ms);
      frames.set(session, () => {
        clearTimeout(timer);
        resolve();
      });
      ws.send(JSON.stringify({ t: "browser_watch", session }));
    });
  const unwatch = () => ws.send(JSON.stringify({ t: "browser_watch" }));
  return { call, firstFrame, unwatch, close: () => ws.close() };
};

/** The stages logged since `from` in `file`, by "<start>/<stage>", in ms (a stage logged twice adds up). */
const stagesIn = (file: string, from: number): Record<string, number> => {
  const text = fs.readFileSync(file).subarray(from).toString("utf8");
  const out: Record<string, number> = {};
  for (const line of text.split("\n")) {
    const stage = /screen start stage start="([^"]+)" screen=\S* stage="([^"]+)" ms=(\d+)/u.exec(line);
    if (stage !== null) out[`${stage[1]}/${stage[2]}`] = (out[`${stage[1]}/${stage[2]}`] ?? 0) + Number(stage[3]);
    const frame = /(browser's|desktop's) first frame screen=\S+ ms=(\d+)/u.exec(line);
    if (frame !== null) out["node session/first frame"] = Number(frame[2]);
    const watched = /(browser|desktop) watched screen=\S+ ms=(\d+) frame=(\w+)/u.exec(line);
    if (watched !== null) out[`node session/watched (frame ready: ${watched[3]})`] = Number(watched[2]);
    const relayed = /watched screen's first frame screen=\S+ ms=(\d+)/u.exec(line);
    if (relayed !== null) out["hub/watch to first frame"] = Number(relayed[1]);
  }
  return out;
};

const median = (xs: ReadonlyArray<number>) => {
  const s = xs.toSorted((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length === 0 ? Number.NaN : s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};

interface Run {
  readonly kind: string;
  readonly mode: string;
  readonly openMs: number;
  readonly frameMs: number;
  readonly totalMs: number;
  readonly recorded: boolean;
  readonly stages: Record<string, number>;
}

export async function screensBench(lab: Lab) {
  const { check, ok, log } = lab;
  const chromeRoot = path.join(USER_BROWSER, "ms-playwright");
  const shell = newest(chromeRoot, "chromium_headless_shell");
  const ffmpegDir = newest(chromeRoot, "ffmpeg");
  check(shell !== undefined && ffmpegDir !== undefined, `a browser install under ${chromeRoot}`);
  const chrome = path.join(shell!, "chrome-headless-shell-linux64/chrome-headless-shell");
  const ffmpeg = path.join(ffmpegDir!, "ffmpeg-linux");
  const xvfb = process.env.FLEETD_LAB_XVFB;
  const home = nodeHome(MACHINE);
  // agent-browser is copied from the user's install (never linked: nothing flows back), so no session waits on npm.
  const driver = path.join(USER_BROWSER, "agent-browser");
  if (fs.existsSync(driver)) fs.cpSync(driver, path.join(home, "browser/agent-browser"), { recursive: true });

  const key = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", lab.hubHome, "--human", "--name", "screens", "--role", "admin", "--machines", "*"))?.[0];
  check(key, "hub key create --human printed a key");
  await lab.startHub({ FLEETD_LOG: LOG_FILTER });
  const app = await appSession(key!);
  const roles = await app.call("machine_roles_set", { machineId: MACHINE, roles: ["agents", "sessions"] });
  check(roles, "machine_roles_set sessions on lab-a");
  const projectId = (await lab.callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === MACHINE)?.projectId as string;
  check(projectId, `${MACHINE} has a project`);
  const projectRef = { machineId: MACHINE, projectId };
  const hubLog = path.join(RUN, "logs", "hub.log");
  const nodeLog = path.join(RUN, "logs", `node-${MACHINE}.log`);

  /** lab-a's node again, with its browser and desktop pools at `pool`. */
  const restart = async (pool: number) => {
    await lab.stopNode(MACHINE);
    const file = path.join(home, "node.json");
    const config = JSON.parse(fs.readFileSync(file, "utf8")) as Body;
    config.browser = { chrome, ffmpeg, pool };
    config.desktop = xvfb === undefined ? { enabled: false } : { backend: "xvfb", xvfb, ffmpeg, pool };
    fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    lab.startNode(MACHINE, { env: { FLEETD_LOG: LOG_FILTER }, ...(xvfb === undefined ? {} : { pathPrefix: [path.dirname(xvfb)] }) });
    await lab.waitLive(MACHINE);
  };
  const hostReady = (host: string) =>
    lab.until(`${MACHINE} ready to host ${host}`, 120_000, async () => {
      const m = ((await app.call("machine_roles")).machines as Array<Body>).find((x) => x.machineId === MACHINE);
      const h = (m?.hosts as Array<Body> | undefined)?.find((x) => x.host === host);
      if (m?.online === true && h?.ready === true) return true;
      await new Promise((r) => setTimeout(r, 500));
      return undefined;
    });

  const runs: Array<Run> = [];
  const one = async (kind: string, mode: string) => {
    const [hubFrom, nodeFrom] = [fs.statSync(hubLog).size, fs.statSync(nodeLog).size];
    const t0 = performance.now();
    const opened = await app.call("screen_open", { projectRef, kind, machineId: MACHINE });
    const t1 = performance.now();
    // As the app does: a session it got back opens at once; without one it waits for the list to show it.
    const session = opened.session as Body | undefined;
    const id =
      (session?.sessionId as string | undefined) ??
      (await lab.until("the opened screen listed", 30_000, async () => {
        const listed = (await app.call("browser_sessions", { projectRef })).sessions as Array<Body>;
        return listed.find((s) => s.state === "live" && s.kind === kind)?.sessionId as string | undefined;
      }));
    await app.firstFrame(id, 30_000);
    const t2 = performance.now();
    app.unwatch();
    await app.call("screen_end", { sessionId: id });
    // The log lines of this start, past the frame.
    await new Promise((r) => setTimeout(r, 300));
    const stages = { ...stagesIn(hubLog, hubFrom), ...stagesIn(nodeLog, nodeFrom) };
    const run = { kind, mode, openMs: Math.round(t1 - t0), frameMs: Math.round(t2 - t1), totalMs: Math.round(t2 - t0), recorded: session !== undefined, stages };
    runs.push(run);
    log(`${kind} ${mode}: ${run.totalMs} ms (open ${run.openMs}, first frame ${run.frameMs}${run.recorded ? "" : ", not in screen_open's answer"})`);
    // The pool's next browser or display is ready again, for a warm start.
    await new Promise((r) => setTimeout(r, 4_000));
  };

  const kinds = xvfb === undefined ? [["browser", "browser"]] : [["browser", "browser"], ["linux_desktop", "desktop"]];
  for (const [mode, pool] of [["cold", 0], ["warm", 1]] as const) {
    await restart(pool);
    for (const [kind, host] of kinds) {
      await hostReady(host!);
      await new Promise((r) => setTimeout(r, 4_000));
      for (let n = 0; n < RUNS; n++) await one(kind!, mode);
    }
  }
  app.close();

  const report: Array<string> = [];
  for (const [kind] of kinds) {
    for (const mode of ["cold", "warm"]) {
      const these = runs.filter((r) => r.kind === kind && r.mode === mode);
      const keys = [...new Set(these.flatMap((r) => Object.keys(r.stages)))].toSorted();
      report.push(`${kind} ${mode} (${these.length} runs): total ${median(these.map((r) => r.totalMs))} ms, screen_open ${median(these.map((r) => r.openMs))} ms, then first frame ${median(these.map((r) => r.frameMs))} ms; in screen_open's answer ${these.filter((r) => r.recorded).length}/${these.length}`);
      for (const k of keys) report.push(`  ${k}: ${median(these.flatMap((r) => (r.stages[k] === undefined ? [] : [r.stages[k]!])))} ms`);
    }
  }
  fs.mkdirSync(path.join(RUN, "screens"), { recursive: true });
  fs.writeFileSync(path.join(RUN, "screens", "bench.json"), `${JSON.stringify(runs, null, 2)}\n`);
  for (const line of report) log(line);
  ok(`screens: ${runs.length} starts measured`);
}
