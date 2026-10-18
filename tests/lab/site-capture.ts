// `FLEETD_LAB_SLOT=<n> node tests/lab/site-capture.ts`: re-shoots the fleetd.sh landing page from the real product.
// A lab hub and node, a haiku lead that files three numbered asks, the desktop app under a private Xvfb answering
// them, and the setup CLI in a throwaway HOME. Writes site/capture-*.png and rewrites the `<!-- capture:NAME -->`
// blocks in site/home.html and site/fleetd.txt. Costs three tiny claude-haiku turns. Every process it starts is
// stopped by the PID captured at spawn; it never touches a T3 or hub it didn't start.
//
// Everything that knows the lab runs T3 is in stageLab(); the rest drives only the fleetd CLI, MCP tools and the app.
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import zlib from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import {
  type Body,
  callToolWith,
  check,
  cli,
  fleetdCommand,
  HUB_PORT,
  HUB_URL,
  LAB,
  lab,
  log,
  MACHINES,
  mintT3Bearer,
  MODEL,
  RELEASE,
  REPO,
  SLOT,
  scrubbedEnv,
  T3_SRC,
  takeLabLock,
  until,
  waitEventWith,
} from "./harness.ts";

if (process.env.FLEETD_LAB_SLOT === undefined) throw new Error("set FLEETD_LAB_SLOT (1-9) to the lab slot this run may use");

const SITE = path.join(REPO, "site");
const RUN = path.join(LAB, "site-capture");
const APP = path.join(RELEASE, "fleetd-app");
const BENCH = path.join(RELEASE, "fleetd-bench");
const SYSROOT = process.env.FLEETD_SYSROOT ?? path.join(os.homedir(), "src/fleetd-lab/sysroot");
const MACHINE = "builder-1";
const TURN_MS = 240_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];

// The app, as it is laid out today. A redesign changes these and nothing else in this file.
/** The app's default window, in logical pixels; the captures are this times GPUI_X11_SCALE_FACTOR. */
const APP_WINDOW = { width: 1400, height: 900 };
/** Screen pixels at the page's scale: the Projects entry in the sidebar, and an empty spot to park the pointer on. */
const CLICK = { projects: [73, 223], park: [900, 1316] } as const;
const REPLY = "1 go 2 nvm 3 b";

/** What the lead is told to run: the asks are arranged, the filing, batching and answering are real. */
const ASK_MESSAGE = `Run these three commands in your shell, one after the other, exactly as written, then stop:
fleetd ask --key site.pricing.headline --class product --text "Pricing page headline: the copy review left two variants in site/pricing.md. Ship A?" --rec "Pay for machines, not seats"
fleetd ask --key deps.moment --class product --text "Drop the moment dependency and format invoice and receipt dates with the built-in Intl API instead?" --rec "drop moment"
fleetd ask --key billing.team.trial --class money --text "Free trial length for the Team plan?" --options "7 days,14 days,30 days" --rec "7 days" --blocks "the Team plan launch"`;

/** The demo project the lead works in. */
const STOREFRONT: Record<string, string> = {
  "README.md": "# storefront\n\nMarketing site and checkout for the Team plan.\n\n- `site/pricing.md`: the pricing page copy\n- `src/dates.js`: date formatting for invoices and receipts\n",
  "site/pricing.md": '# Pricing\n\n<!-- headline: two variants from the copy review, pick one before launch -->\n<!-- A: "Pay for machines, not seats" -->\n<!-- B: "One price per machine. Every agent included." -->\n\n## Team\n\nPer machine, billed monthly. Free trial included.\n',
  "package.json": '{\n  "name": "storefront",\n  "private": true,\n  "type": "module",\n  "dependencies": {\n    "moment": "2.30.1"\n  }\n}\n',
  "src/dates.js": 'import moment from "moment";\n\nexport const invoiceDate = (d) => moment(d).format("D MMM YYYY");\nexport const receiptTime = (d) => moment(d).format("D MMM YYYY, HH:mm");\n',
};

/** Undone last to first in `finally`: processes by their spawn PID, lab state put back. */
const cleanups: Array<() => Promise<void> | void> = [];

const spawnTracked = (name: string, [cmd, args]: [string, Array<string>], env: Record<string, string>) => {
  fs.mkdirSync(path.join(RUN, "logs"), { recursive: true });
  const out = fs.openSync(path.join(RUN, "logs", `${name}.log`), "a");
  const child = spawn(cmd, args, { env, stdio: ["ignore", out, out] });
  log(`started ${name} pid=${child.pid}`);
  cleanups.push(async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise((r) => child.once("exit", r));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
    log(`stopped ${name} pid=${child.pid}`);
  });
  return child;
};

const pause = (ms: number) => new Promise<undefined>((r) => setTimeout(() => r(undefined), ms));

// ---- The lab: a stock T3 (lab-a) with the storefront project, a hub, and node builder-1 on that T3. ----

async function stageLab() {
  takeLabLock();
  const t3 = MACHINES[0];
  if (!/already running/u.test(lab("up", t3.id))) cleanups.push(() => void log(lab("down", t3.id).trim()));

  const workspace = path.join(LAB, "storefront");
  fs.rmSync(workspace, { recursive: true, force: true });
  for (const [file, text] of Object.entries(STOREFRONT)) {
    fs.mkdirSync(path.dirname(path.join(workspace, file)), { recursive: true });
    fs.writeFileSync(path.join(workspace, file), text);
  }
  const gitEnv = { ...scrubbedEnv(), GIT_AUTHOR_NAME: "lab", GIT_AUTHOR_EMAIL: "lab@localhost", GIT_COMMITTER_NAME: "lab", GIT_COMMITTER_EMAIL: "lab@localhost" };
  for (const args of [["init", "-q", "-b", "main"], ["add", "."], ["commit", "-q", "-m", "storefront: pricing page draft and invoice dates"]]) {
    execFileSync("git", args, { cwd: workspace, env: gitEnv, stdio: "ignore" });
  }

  // T3 holds exactly the storefront project for the run; the slot's own projects come back afterwards.
  const bearer = mintT3Bearer(t3);
  const api = async (method: string, route: string, body?: unknown) => {
    const r = await fetch(`${t3.t3Url}${route}`, {
      method,
      headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!r.ok) throw new Error(`T3 ${method} ${route}: HTTP ${r.status} ${(await r.text()).slice(0, 300)}`);
    return (await r.json()) as Body;
  };
  const mutate = (command: Body) => api("POST", "/api/projects/mutate", { commandId: randomUUID(), ...command });
  const before = (await api("GET", "/api/projects")).projects as Array<Body>;
  for (const p of before) await mutate({ type: "project.delete", projectId: p.id, force: true });
  const storefrontId = randomUUID();
  await mutate({ type: "project.create", projectId: storefrontId, title: "storefront", workspaceRoot: workspace });
  cleanups.push(async () => {
    await mutate({ type: "project.delete", projectId: storefrontId, force: true });
    for (const p of before.filter((p) => p.workspaceRoot !== workspace)) {
      await mutate({ type: "project.create", projectId: randomUUID(), title: p.title, workspaceRoot: p.workspaceRoot });
    }
    log(`T3 ${t3.id}: projects restored (${before.map((p) => p.title).join(", ")})`);
  });

  // The lead's shell: lab.mjs puts LAB/bin on T3's PATH and points FLEETD_NODE_SOCK at LAB/sock/<instance>.sock.
  const nodeHome = path.join(RUN, `node-${MACHINE}`);
  const [bin, prefix] = fleetdCommand([]);
  fs.mkdirSync(path.join(LAB, "bin"), { recursive: true });
  fs.writeFileSync(path.join(LAB, "bin", "fleetd"), `#!/bin/sh\nexec ${[bin, ...prefix].map((a) => `'${a}'`).join(" ")} "$@"\n`, { mode: 0o755 });
  fs.mkdirSync(path.join(LAB, "sock"), { recursive: true });
  fs.rmSync(path.join(LAB, "sock", `${t3.id}.sock`), { force: true });
  fs.symlinkSync(path.join(nodeHome, "node.sock"), path.join(LAB, "sock", `${t3.id}.sock`));

  const hubHome = path.join(RUN, "hub");
  spawnTracked("hub", fleetdCommand(["hub", "start", "--home", hubHome, "--listen", `127.0.0.1:${HUB_PORT}`]), scrubbedEnv());
  await until("hub /healthz", 30_000, async () => (await fetch(`${HUB_URL}/healthz`).then((r) => r.ok, () => false)) || (await pause(250)));
  const keyOf = (out: string) => {
    const key = /fld_[a-z2-7]{20,}/u.exec(out)?.[0];
    check(key, "hub key create printed a key");
    return key!;
  };
  const operateKey = keyOf(cli("hub", "key", "create", "--home", hubHome, "--name", "site-capture", "--role", "operate", "--machines", "*"));
  const humanKey = keyOf(cli("hub", "key", "create", "--home", hubHome, "--human", "--name", "laptop"));
  const token = /^\S{16,}$/mu.exec(cli("hub", "token", "create", "--home", hubHome, "--machine", MACHINE))?.[0];
  check(token, "hub token create printed a token");
  spawnTracked(
    "node",
    fleetdCommand([
      "node", "join", "--hub", HUB_URL, "--token", token!, "--machine", MACHINE, "--t3-home", t3.t3Home, "--t3-url", t3.t3Url,
      "--t3-cmd", `${process.execPath} ${path.join(T3_SRC, "apps/server/src/bin.ts")}`, "--home", nodeHome,
    ]),
    scrubbedEnv(),
  );
  return { operateKey, humanKey, workspace };
}

// ---- The app under a private Xvfb (app/bench's sysroot build), read through the framebuffer Xvfb keeps under -fbdir. ----

async function startDisplay(width: number, height: number, humanKey: string) {
  const xvfb = path.join(SYSROOT, "usr/bin/Xvfb-fleetd");
  check(fs.existsSync(xvfb), `${xvfb} exists (run app/bench/linux-sysroot.sh)`);
  // Xvfb-fleetd looks for xkbcomp in /tmp/xk (see linux-sysroot.sh). Refuse a directory we don't own.
  fs.mkdirSync("/tmp/xk", { recursive: true, mode: 0o700 });
  check(fs.statSync("/tmp/xk").uid === process.getuid?.(), "/tmp/xk is ours");
  fs.rmSync("/tmp/xk/xkbcomp", { force: true });
  fs.symlinkSync(path.join(SYSROOT, "usr/bin/xkbcomp"), "/tmp/xk/xkbcomp");
  const n = Array.from({ length: 53 }, (_, i) => i + 47).find((d) => !fs.existsSync(`/tmp/.X${d}-lock`));
  check(n, "a free X display");
  const fbdir = path.join(RUN, "fb");
  fs.mkdirSync(fbdir, { recursive: true });
  spawnTracked("xvfb", [xvfb, [`:${n}`, "-screen", "0", `${width}x${height}x24`, "-fbdir", fbdir, "-nolisten", "tcp"]], scrubbedEnv());
  await until("Xvfb socket", 10_000, async () => fs.existsSync(`/tmp/.X11-unix/X${n}`) || (await pause(100)));
  const lib = path.join(SYSROOT, "usr/lib", process.arch === "arm64" ? "aarch64-linux-gnu" : "x86_64-linux-gnu");
  const env = {
    ...scrubbedEnv(),
    LANG: "C.UTF-8",
    DISPLAY: `:${n}`,
    LD_LIBRARY_PATH: lib,
    VK_ICD_FILENAMES: path.join(SYSROOT, "usr/share/vulkan/icd.d/lvp_icd.json"),
  };
  const scale = width / APP_WINDOW.width;
  check(height === APP_WINDOW.height * scale, `the page's ${width}x${height} is the app window at one scale`);
  spawnTracked("app", [APP, []], { ...env, GPUI_X11_SCALE_FACTOR: String(scale), FLEETD_HUB_URL: HUB_URL, FLEETD_AGENT_KEY: humanKey });
  const fb = path.join(fbdir, "Xvfb_screen0");
  const bench = (...args: Array<string>) => execFileSync(BENCH, args, { env, stdio: "ignore" });
  return {
    click: ([x, y]: readonly [number, number]) => bench("click", String(x), String(y)),
    type: (text: string) => bench("type", text),
    hash: () => createHash("sha1").update(fs.readFileSync(fb)).digest("hex"),
    /** Waits until the screen differs from `from` (when given) and then holds still for 2 s. */
    settled: async (from?: string) => {
      let last = "";
      let since = Date.now();
      return until("the app to settle", 60_000, async () => {
        const h = createHash("sha1").update(fs.readFileSync(fb)).digest("hex");
        if (h !== last) [last, since] = [h, Date.now()];
        if (h !== from && Date.now() - since >= 2_000) return h;
        await pause(250);
        return undefined;
      });
    },
    png: (out: string) => fs.writeFileSync(out, xwdToPng(fs.readFileSync(fb), width, height)),
  };
}

/** Xvfb's -fbdir file is an XWD dump, 32 bpp BGRX; a PNG is IHDR + one zlib IDAT + IEND. */
function xwdToPng(xwd: Buffer, width: number, height: number) {
  const h = (i: number) => xwd.readUInt32BE(i * 4);
  check(h(4) === width && h(5) === height && h(11) === 32, `framebuffer is ${h(4)}x${h(5)} at ${h(11)} bpp`);
  const [bpl, offset] = [h(12), h(0) + h(19) * 12];
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x++) {
      const src = offset + y * bpl + x * 4;
      raw[row + 1 + x * 3] = xwd[src + 2]!;
      raw[row + 2 + x * 3] = xwd[src + 1]!;
      raw[row + 3 + x * 3] = xwd[src]!;
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), body.length + 4);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

// ---- Setup transcripts and train lines ----

/** `fleetd init` and `machine add --dry-run` in a throwaway HOME. --no-service: with a service, init drives the real
 * systemd user manager. */
function setupTranscripts() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-site-"));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "demo");
  fs.mkdirSync(path.join(home, ".local/bin"), { recursive: true });
  fs.copyFileSync(fleetdCommand([])[0], path.join(home, ".local/bin/fleetd"));
  const run = (cmd: string) => {
    const r = spawnSync("bash", ["-c", `cd ~ && ${cmd} 2>&1`], {
      env: { HOME: home, USER: "demo", LOGNAME: "demo", LANG: "C.UTF-8", PATH: `${home}/.local/bin:/usr/bin:/bin` },
      encoding: "utf8",
    });
    check(r.status === 0, `${cmd}: exit ${r.status} ${r.stdout}`);
    return { cmd, out: `${r.stdout.replace(/\n$/u, "")}\n[exit ${r.status}]`.replaceAll(home, "~") };
  };
  const init = run('fleetd init --listen 127.0.0.1:4778 --git-identity "Demo <demo@users.noreply.github.com>" --no-service');
  const add = run("fleetd machine add builder-1 --dry-run");
  // The page shows the plan, not the shell command indented under each step or the trailing notes.
  add.out = add.out.split("\n").filter((l) => !/^\s/u.test(l) && !l.startsWith("note:")).join("\n");
  return { init, add };
}

interface TrainLine {
  readonly ms: number;
  readonly type: string;
  readonly summary: string;
  readonly statusOn?: string;
}

/** The merge train from the newest lab m7 run on this box (any slot), with the `fleetd/train` commit status the
 * train posted on GitHub before each merge. Undefined when no run has merged anything. */
function trainLines(): { lines: Array<TrainLine>; from: string } | undefined {
  const root = SLOT === 0 ? LAB : path.dirname(LAB);
  const runs = [root, ...fs.readdirSync(root).filter((d) => /^slot-\d$/u.test(d)).map((d) => path.join(root, d))].flatMap((dir) =>
    fs.readdirSync(dir).filter((d) => d.startsWith("e2e-")).map((d) => path.join(dir, d, "hub", "hub.sqlite")),
  );
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "fleetd-site-train-"));
  cleanups.push(() => fs.rmSync(tmp, { recursive: true, force: true }));
  let best: { db: DatabaseSync; at: number; from: string } | undefined;
  for (const [i, file] of runs.filter((f) => fs.existsSync(f)).entries()) {
    // A copy, so a reader never takes a lock in or checkpoints a lab run's own files.
    const copy = path.join(tmp, `${i}.sqlite`);
    for (const ext of ["", "-wal"]) if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, copy + ext);
    const db = new DatabaseSync(copy);
    const at = Number((db.prepare("SELECT max(created_ms) AS at FROM events WHERE type = 'pr.merged'").get() as { at: number | null }).at ?? 0);
    if (at > (best?.at ?? 0)) best = { db, at, from: file };
  }
  if (best === undefined) return undefined;
  const rows = best.db
    .prepare("SELECT created_ms, type, data FROM events WHERE type LIKE 'change.%' OR type LIKE 'train.%' OR type IN ('review.verdict', 'pr.merged') ORDER BY seq")
    .all() as Array<{ created_ms: number; type: string; data: string }>;
  const lines: Array<TrainLine> = [];
  for (const row of rows) {
    const event = JSON.parse(row.data) as Body;
    lines.push({ ms: row.created_ms, type: row.type, summary: String(event.summary).replace(/\(log: https?:\/\/[^)]+\)/u, "(log: …)") });
    if (row.type !== "pr.merged") continue;
    const { repo, prNumber } = event.data as { repo: string; prNumber: number };
    const gh = (route: string): unknown => JSON.parse(execFileSync("gh", ["api", route], { env: scrubbedEnv(), encoding: "utf8" }));
    const head = String((gh(`repos/${repo}/pulls/${prNumber}`) as Body).head.sha);
    // Newest first: the last status the train set before merging.
    const status = (gh(`repos/${repo}/commits/${head}/statuses`) as Array<Body>).find((s) => s.context === "fleetd/train");
    if (status !== undefined) lines.push({ ms: Date.parse(status.created_at), type: "fleetd/train", summary: String(status.description), statusOn: head.slice(0, 7) });
  }
  // The run ends at its last merge; a later review verdict belongs to other work.
  return { lines: lines.filter((l) => l.ms <= best.at).toSorted((a, b) => a.ms - b.ms), from: best.from };
}

// ---- The page's capture blocks ----

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const indentAll = (text: string, by: string) => text.split("\n").map((l) => (l === "" ? l : by + l)).join("\n");
type Blocks = Record<string, (indent: string) => string>;

const transcriptBlocks = ({ cmd, out }: { cmd: string; out: string }) => ({
  html: (indent: string) => `${indent}<pre class="lines"><span class="c">${esc(`$ ${cmd}`)}</span>\n<span class="o">${esc(out)}</span></pre>`,
  txt: () => `$ ${cmd}\n${out}`,
});

const trainBlocks = (lines: ReadonlyArray<TrainLine>) => {
  const time = (ms: number) => new Date(ms).toISOString().slice(11, 19);
  const tone = (type: string) => (["change.refused", "change.ci_failed", "change.needs_rebase"].includes(type) ? ' class="bad"' : type === "pr.merged" ? ' class="ok"' : "");
  const width = Math.max(...lines.map((l) => l.type.length)) + 2;
  return {
    html: (indent: string) =>
      lines
        .map((l) => {
          const status = l.statusOn === undefined ? "" : ` <span class="x">· commit status on ${l.statusOn}</span>`;
          return `${indent}<li${tone(l.type)}><span class="t">${time(l.ms)}</span><span class="e">${esc(l.type)}</span><span class="s">${esc(l.summary)}${status}</span></li>`;
        })
        .join("\n"),
    txt: () => lines.map((l) => `${time(l.ms)}  ${l.type.padEnd(width)}${l.summary}${l.statusOn === undefined ? "" : `   [commit status on ${l.statusOn}]`}`).join("\n"),
  };
};

/** Replaces what is between `<!-- capture:NAME -->` and `<!-- /capture:NAME -->`; each block gets the opening marker's indentation. */
function fill(file: string, blocks: Blocks) {
  let text = fs.readFileSync(file, "utf8");
  for (const [name, make] of Object.entries(blocks)) {
    const re = new RegExp(`^([ \\t]*)<!-- capture:${name} -->\\n[\\s\\S]*?\\n([ \\t]*<!-- /capture:${name} -->)$`, "mu");
    check(re.test(text), `${path.basename(file)} has a capture:${name} block`);
    text = text.replace(re, (_all, indent: string, close: string) => `${indent}<!-- capture:${name} -->\n${make(indent)}\n${close}`);
  }
  fs.writeFileSync(file, text);
}

/** Nothing on a public page may name this machine, its paths or its network, or carry a key. */
function assertPublishable(name: string, text: string) {
  const host = os.hostname();
  const leaks: Array<[string, RegExp | string]> = [
    ["home directory", os.homedir()],
    ["lab directory", LAB],
    ["a /home path", /\/home\/(?!demo\b)/u],
    ["hostname", new RegExp(`\\b${host.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "iu")],
    ["fleetd key", /fld_[a-z2-7]{20,}/u],
    ["non-loopback IPv4", /\b(?!127\.0\.0\.1\b)\d{1,3}(\.\d{1,3}){3}\b/u],
  ];
  for (const [what, needle] of leaks) {
    check(typeof needle === "string" ? !text.includes(needle) : !needle.test(text), `${name} would publish a ${what}`);
  }
}

/** All string values in a JSON value. */
const strings = (v: unknown): Array<string> =>
  typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(strings) : v !== null && typeof v === "object" ? Object.values(v).flatMap(strings) : [];

/** Hand-written callouts that quote the product, and ids on the page, that this run's output no longer contains. */
function staleQuotes(haystack: string) {
  const norm = (s: string) => s.replaceAll("**", "").replaceAll("’", "'").replace(/\s+/gu, " ").trim();
  const hay = norm(haystack);
  const html = fs.readFileSync(path.join(SITE, "home.html"), "utf8");
  const txt = fs.readFileSync(path.join(SITE, "fleetd.txt"), "utf8");
  const quotes = [...html.matchAll(/<code class="q">([\s\S]*?)<\/code>|<q>([\s\S]*?)<\/q>/gu)].map((m) =>
    norm((m[1] ?? m[2] ?? "").replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")),
  );
  const ids = [...new Set([...(html + txt).matchAll(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gu)].map((m) => m[0]))];
  // "blocks: the Team plan launch" is the app's label around the ask's own text.
  return [...quotes, ...ids].filter((q) => !hay.includes(q) && !hay.includes(q.replace(/^[a-z]+: /u, "")));
}

// ---- The run ----

async function main() {
  const html = fs.readFileSync(path.join(SITE, "home.html"), "utf8");
  const size = /<img src="\/capture-inbox\.png" width="(\d+)" height="(\d+)"/u.exec(html);
  check(size, "home.html sizes capture-inbox.png");
  const [width, height] = [Number(size![1]), Number(size![2])];
  for (const bin of [APP, BENCH, fleetdCommand([])[0]]) check(fs.existsSync(bin), `${bin} is built (cargo build --release --locked -p fleetd -p fleetd-app -p fleetd-bench)`);
  fs.rmSync(RUN, { recursive: true, force: true });
  const shots = path.join(RUN, "shots");
  fs.mkdirSync(shots, { recursive: true });

  const { operateKey, humanKey, workspace } = await stageLab();
  const client = new Client({ name: "fleetd-site-capture", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${HUB_URL}/mcp`), { requestInit: { headers: { authorization: `Bearer ${operateKey}` } } }) as Transport);
  cleanups.push(() => client.close().catch(() => undefined));
  const callTool = callToolWith(() => client);
  const waitEvent = waitEventWith(callTool);
  const cursor = async () => (await callTool("fleetd_status")).body.cursor as number;
  const ok = (r: { isError: boolean; body: Body }, what: string) => {
    check(!r.isError, `${what}: ${JSON.stringify(r.body)}`);
    return r.body;
  };

  const projectId = await until(`${MACHINE} online with the storefront project`, 120_000, async () => {
    const s = (await callTool("fleetd_status")).body;
    const p = s.projects.find((p: Body) => p.machineId === MACHINE && p.workspaceRoot === workspace);
    const online = s.machines.some((m: Body) => m.machineId === MACHINE && m.status === "online");
    if (online && p && (await callTool("project_get", { machineId: MACHINE, projectId: p.projectId })).body.stale === false) return p.projectId as string;
    await callTool("events_wait", { cursor: s.cursor, timeoutSec: 5 });
    return undefined;
  });
  const turn = async (what: string, from: number, threadId: string) => {
    const { event } = await waitEvent(what, TURN_MS, { cursor: from, machineId: MACHINE, match: (e) => e.threadId === threadId && ENDED.includes(e.type) });
    check(event.type === "thread.completed", `${what}: ${event.type}`);
  };

  // Turn 1: the lead starts. The app comes up meanwhile, with an empty inbox.
  let from = await cursor();
  const lead = ok(await callTool("lead_start", { machineId: MACHINE, projectId, model: MODEL, effort: "low" }), "lead_start").threadId as string;
  const screen = await startDisplay(width, height, humanKey);
  await turn("lead start", from, lead);
  const empty = await screen.settled();
  log(`lead ${lead} started; app up`);

  // Turn 2: the lead files the asks from its shell; the hub batches them; the app shows the batch.
  from = await cursor();
  ok(await callTool("thread_send", { machineId: MACHINE, threadId: lead, message: ASK_MESSAGE, clientRequestId: randomUUID() }), "thread_send");
  await turn("the lead filing its asks", from, lead);
  await waitEvent("batch.ready", 120_000, { cursor: from, types: ["batch.ready"] });
  const open = ok(await callTool("asks_list", { state: "open" }), "asks_list");
  check(open.asks.length === 3, `the lead filed 3 asks, found ${open.asks.length}`);
  await screen.settled(empty);
  screen.png(path.join(shots, "capture-inbox.png"));
  log("captured the inbox");

  // The reply, typed into the app; Enter sends it as the human. Turn 3: the hub wakes the lead with the answers.
  from = await cursor();
  screen.type(REPLY);
  screen.type("\n");
  const woken = await waitEvent("the lead woken with the answers", 120_000, { cursor: from, types: ["lead.woken"], match: (e) => e.threadId === lead });
  await turn("the lead's wake", woken.cursor, lead);
  let shown = screen.hash();
  screen.click(CLICK.projects);
  shown = await screen.settled(shown);
  screen.type("\n");
  shown = await screen.settled(shown);
  screen.click(CLICK.park);
  await screen.settled();
  screen.png(path.join(shots, "capture-lead.png"));
  log("captured the lead's view");

  const tail = ok(await callTool("thread_tail", { machineId: MACHINE, threadId: lead, n: 50 }), "thread_tail");
  const messages = (tail.items as Array<Body>).filter((i) => i.kind === "message");
  const wake = String(messages.find((m) => m.role === "user")?.text ?? "");
  check(wake.includes("## Why you are woken"), "the newest user message is the wake");
  const digest = String(ok(await callTool("digest_get"), "digest_get").text).trim();
  const answered = ok(await callTool("asks_list", { state: "answered" }), "asks_list answered");

  const { init, add } = setupTranscripts();
  const train = trainLines();
  log(train === undefined ? "train: no lab run has merged a PR; the train blocks stay as they are" : `train: ${train.lines.length} lines from ${train.from}`);

  // The wake without its header (project id, timestamp) and without the sections that say "none".
  const sections = wake.slice(wake.indexOf("## ")).split(/\n(?=## )/u).filter((s) => s.split("\n").slice(1).join("\n").trim() !== "none");
  const wakeText = sections.map((s) => s.trimEnd()).join("\n\n");
  const [digestHead = "", ...digestRest] = digest.split("\n");
  const htmlBlocks: Blocks = {
    init: transcriptBlocks(init).html,
    "machine-add": transcriptBlocks(add).html,
    digest: (indent) => `${indent}<pre class="lines"><span class="c">${esc(digestHead)}</span>${digestRest.length === 0 ? "" : `\n<span class="o">${esc(digestRest.join("\n"))}</span>`}</pre>`,
  };
  const txtBlocks: Blocks = {
    init: transcriptBlocks(init).txt,
    "machine-add": transcriptBlocks(add).txt,
    digest: () => indentAll(digest, "  "),
    wake: () => indentAll(wakeText, "  "),
  };
  if (train !== undefined) {
    htmlBlocks.train = trainBlocks(train.lines).html;
    txtBlocks.train = trainBlocks(train.lines).txt;
  }
  for (const [name, make] of [...Object.entries(htmlBlocks), ...Object.entries(txtBlocks)]) assertPublishable(`capture:${name}`, make(""));

  // Everything checked: now the site changes.
  for (const shot of ["capture-inbox.png", "capture-lead.png"]) fs.copyFileSync(path.join(shots, shot), path.join(SITE, shot));
  fill(path.join(SITE, "home.html"), htmlBlocks);
  fill(path.join(SITE, "fleetd.txt"), txtBlocks);
  const stale = staleQuotes([...strings(tail), ...strings(answered), wake, digest, init.out, add.out].join("\n"));
  log(`wrote site/capture-inbox.png, site/capture-lead.png and the capture blocks in site/home.html and site/fleetd.txt`);
  if (stale.length > 0) log(`check by hand: the page says these, this run's output doesn't:\n${stale.map((s) => `  - ${s}`).join("\n")}`);
  log("callouts are placed by hand: if the app's layout moved, re-aim --x/--y in home.html (see the comment above Fig. 1)");
}

main()
  .catch((error: unknown) => {
    log(`FAIL ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    log(`logs: ${path.join(RUN, "logs")}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    for (const undo of cleanups.toReversed()) await Promise.resolve(undo()).catch((e: unknown) => log(`cleanup: ${String(e)}`));
  });
