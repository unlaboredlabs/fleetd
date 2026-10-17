// M8 "done when" 1-5 on lab-a, through the real phone web app: headless Chromium (chrome-headless-shell over CDP)
// opens the hub's PWA behind a local TLS terminator whose lab CA it trusts by SPKI pin. The device pairs from the
// link `fleetd hub device add` prints; it subscribes to Web Push with a mock push service on loopback; a secret
// ask is sealed in the page and lands 0600 on the node, its value found nowhere in the hub's files, logs or events;
// a checklist ticked done fails its verify check, reopens, then passes; a gated irreversible command is refused to
// an agent key and runs after a tap on Approve, waking the lead with its exit code. The first loud item is pushed at
// once and decrypts to one line without the secret; later ones wait out the 20-minute window. The asks are filed
// from the project's shell as a lead would, so they cost no turns; a lead is started only if none exists, just
// before the approval, so a run alone costs two haiku turns (lead start, the approval's wake).
import { type ChildProcess, execFileSync, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import tls from "node:tls";
import { decryptPayload } from "../push/webPush.ts";
import { type Body, CLI, cli, HUB_PORT, LAB, type Lab, MODEL, RUN, scrubbedEnv } from "./harness.ts";
import { TESTBED } from "./m7Train.ts";

const MACHINE = "lab-a";
const CHROME =
  process.env.FLEETD_LAB_CHROME ?? path.join(os.homedir(), ".cache/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell");
/** Shared libraries the headless shell needs that this box lacks, extracted from .debs (no system installs). */
const CHROME_LIBS = ["chrome-libs/root", "sysroot"].map((d) => path.join(LAB, d, "usr/lib/x86_64-linux-gnu")).join(":");
const TURN_MS = 240_000;
const ENDED = ["thread.completed", "thread.failed", "thread.interrupted"];

/** Listens on an OS-assigned loopback port (so nothing else in the lab range can clash) and returns it. */
const listen = (server: net.Server) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });

/** A lab CA and a localhost certificate it signs, made with openssl; returns the chain and the CA's SPKI pin. */
const labTls = (dir: string) => {
  fs.mkdirSync(dir, { recursive: true });
  const at = (f: string) => path.join(dir, f);
  const ssl = (...args: Array<string>) => execFileSync("openssl", args, { stdio: ["ignore", "ignore", "pipe"] });
  const ec = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes"];
  ssl("req", "-x509", ...ec, "-keyout", at("ca.key"), "-out", at("ca.pem"), "-days", "2", "-subj", "/CN=fleetd lab CA");
  ssl("req", ...ec, "-keyout", at("srv.key"), "-out", at("srv.csr"), "-subj", "/CN=localhost");
  fs.writeFileSync(at("srv.ext"), "subjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n");
  ssl("x509", "-req", "-in", at("srv.csr"), "-CA", at("ca.pem"), "-CAkey", at("ca.key"), "-CAcreateserial", "-out", at("srv.pem"), "-days", "2", "-extfile", at("srv.ext"));
  const ca = fs.readFileSync(at("ca.pem"), "utf8");
  const spki = new crypto.X509Certificate(ca).publicKey.export({ type: "spki", format: "der" });
  return { key: fs.readFileSync(at("srv.key")), cert: fs.readFileSync(at("srv.pem"), "utf8") + ca, pin: crypto.createHash("sha256").update(spki).digest("base64") };
};

/** A Web Push service on loopback: keeps each POST and answers 201. */
const mockPushService = () => {
  const received: Array<{ readonly path: string; readonly headers: http.IncomingHttpHeaders; readonly body: Buffer }> = [];
  const waiters: Array<() => void> = [];
  const server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      received.push({ path: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks) });
      for (const w of waiters.splice(0)) w();
      res.writeHead(201).end();
    });
  });
  const next = (count: number, ms: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out after ${ms / 1000}s: push ${count} at the mock push service`)), ms);
      const check = () => (received.length >= count ? (clearTimeout(timer), resolve()) : void waiters.push(check));
      check();
    });
  return { server, received, next };
};

interface Cdp {
  readonly send: (method: string, params?: Record<string, unknown>) => Promise<Body>;
  /** Runs `expression` in the page, awaiting a promise; returns its JSON value. */
  readonly evaluate: <A = unknown>(expression: string) => Promise<A>;
  /** Uncaught exceptions, console errors and browser log errors (CSP violations among them). */
  readonly problems: Array<string>;
  readonly close: () => void;
}

const connectCdp = async (url: string, problems: Array<string>): Promise<Cdp> => {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error(`CDP: cannot connect to ${url}`));
  });
  let nextId = 0;
  const waiting = new Map<number, { resolve: (v: Body) => void; reject: (e: Error) => void }>();
  ws.onmessage = (event) => {
    const m = JSON.parse(String(event.data)) as Body;
    if (typeof m.id === "number") {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error !== undefined) w?.reject(new Error(`CDP: ${JSON.stringify(m.error)}`));
      else w?.resolve(m.result as Body);
    }
    if (m.method === "Runtime.exceptionThrown") problems.push(String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
    if (m.method === "Runtime.consoleAPICalled" && m.params.type === "error") problems.push(m.params.args.map((a: Body) => a.value ?? a.description).join(" "));
    if (m.method === "Log.entryAdded" && m.params.entry.level === "error") problems.push(`${m.params.entry.source}: ${m.params.entry.text}`);
  };
  const send = (method: string, params: Record<string, unknown> = {}) =>
    new Promise<Body>((resolve, reject) => {
      const id = ++nextId;
      waiting.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async <A>(expression: string) => {
    const out = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (out.exceptionDetails !== undefined) throw new Error(`in page: ${out.exceptionDetails.exception?.description ?? out.exceptionDetails.text}`);
    return out.result.value as A;
  };
  return { send, evaluate, problems, close: () => ws.close() };
};

/** Resolves once `js` is truthy in the page, re-checking on every DOM change (no polling). */
const waitInPage = <A = unknown>(cdp: Cdp, what: string, js: string, ms = 90_000) =>
  cdp.evaluate<A>(`new Promise((resolve, reject) => {
    const probe = () => { try { return (${js}); } catch { return undefined; } };
    let obs;
    const timer = setTimeout(() => { obs?.disconnect(); reject(new Error(${JSON.stringify(`timed out after ${ms / 1000}s: ${what}; the page says: `)} + document.body.textContent.replace(/\\s+/g, " ").slice(0, 1500))); }, ${ms});
    const done = (v) => { obs?.disconnect(); clearTimeout(timer); resolve(v); };
    const first = probe();
    if (first) return done(first);
    obs = new MutationObserver(() => { const v = probe(); if (v) done(v); });
    obs.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
  })`);

/** The inbox card whose text includes `text`, as a page expression. */
const card = (text: string) => `[...document.querySelectorAll("article.card")].find((c) => c.textContent.includes(${JSON.stringify(text)}))`;
const tap = (text: string, label: string) =>
  `(() => { const b = [...(${card(text)})?.querySelectorAll("button") ?? []].find((b) => b.textContent.trim() === ${JSON.stringify(label)} && !b.disabled); b?.click(); return b !== undefined; })()`;

const filesUnder = (dir: string): Array<[string, string]> =>
  !fs.existsSync(dir)
    ? []
    : fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) return filesUnder(full);
        return entry.isFile() ? [[full, fs.readFileSync(full).toString("latin1")]] : [];
      });

export async function m8Phone(lab: Lab) {
  const { callTool, check, ok } = lab;
  check(fs.existsSync(CHROME), `chrome-headless-shell at ${CHROME} (set FLEETD_LAB_CHROME to another one)`);
  await lab.waitLive(MACHINE);
  // The hub keeps m7's deleted testbed project in its list; this scenario uses lab-a's own repo.
  const projectId = (await callTool("fleetd_status")).body.projects.find((p: Body) => p.machineId === MACHINE && p.workspaceRoot !== TESTBED)?.projectId as string;
  check(projectId, `${MACHINE} has a project`);
  const ref = { machineId: MACHINE, projectId };
  const root = (await callTool("project_get", ref)).body.project.workspaceRoot as string;
  fs.rmSync(lab.dir, { recursive: true, force: true });
  fs.mkdirSync(lab.dir, { recursive: true });
  const scenarioStart = await lab.cursor();
  // A fresh value per run, so a hit can only come from this run.
  const VALUE = `sk_test_lab_${crypto.randomBytes(12).toString("hex")}`;

  const fleetd = (...args: Array<string>) => {
    const out = spawnSync(process.execPath, [CLI, ...args], {
      cwd: root,
      encoding: "utf8",
      env: { ...scrubbedEnv(), PWD: root, FLEETD_NODE_SOCK: path.join(LAB, "sock", `${MACHINE}.sock`) },
    });
    check(out.status === 0, `fleetd ${args.slice(0, 3).join(" ")}: exit ${out.status} ${out.stdout}${out.stderr}`);
    return out.stdout;
  };
  /** Every event after `cursor` that matches, page by page. */
  const allEvents = async (cursor: number, filter: Record<string, unknown> = {}) => {
    const events: Array<Body> = [];
    for (let from = cursor; ; ) {
      const page = (await callTool("events_wait", { cursor: from, timeoutSec: 0, ...filter })).body;
      events.push(...(page.events as Array<Body>));
      if (page.more !== true) return events;
      from = page.cursor as number;
    }
  };
  const askOf = async (askId: string, state: "open" | "answered") =>
    ((await callTool("asks_list", { state })).body.asks as Array<Body>).find((a) => a.askId === askId);

  const cleanup: Array<() => void | Promise<void>> = [];
  const problems: Array<string> = [];
  let cdpRef: Cdp | undefined;
  try {
    // A local TLS terminator in front of the hub: the PWA needs a secure context for its service worker and push.
    const certs = labTls(path.join(lab.dir, "tls"));
    const terminator = tls.createServer({ key: certs.key, cert: certs.cert }, (client) => {
      const upstream = net.connect(HUB_PORT, "127.0.0.1");
      client.pipe(upstream).pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    });
    const TLS_PORT = await listen(terminator);
    cleanup.push(() => new Promise<void>((resolve) => terminator.close(() => resolve())));
    const push = mockPushService();
    const PUSH_PORT = await listen(push.server);
    cleanup.push(() => new Promise<void>((resolve) => push.server.close(() => resolve())));
    ok(`TLS terminator https://localhost:${TLS_PORT} -> hub :${HUB_PORT} (lab CA pin ${certs.pin.slice(0, 12)}…); mock push service on :${PUSH_PORT}`);

    // Headless Chromium, trusting only the lab CA by its SPKI pin.
    const chrome: ChildProcess = spawn(
      CHROME,
      [
        // Chromium picks the port and writes it to DevToolsActivePort in the profile.
        "--remote-debugging-port=0",
        `--user-data-dir=${path.join(lab.dir, "chrome-profile")}`,
        `--ignore-certificate-errors-spki-list=${certs.pin}`,
        "--no-sandbox",
        "--no-first-run",
        "--window-size=390,1400",
        "about:blank",
      ],
      { env: { ...scrubbedEnv(), LD_LIBRARY_PATH: CHROME_LIBS }, stdio: ["ignore", "ignore", fs.openSync(path.join(RUN, "logs", "chrome.log"), "a")] },
    );
    lab.log(`started chrome-headless-shell pid=${chrome.pid}`);
    cleanup.push(async () => {
      if (chrome.exitCode !== null || chrome.signalCode !== null) return;
      const exited = new Promise((r) => chrome.once("exit", r));
      chrome.kill("SIGTERM");
      await exited;
      lab.log(`stopped chrome-headless-shell pid=${chrome.pid}`);
      fs.rmSync(path.join(lab.dir, "chrome-profile"), { recursive: true, force: true });
    });
    const activePort = path.join(lab.dir, "chrome-profile", "DevToolsActivePort");
    const target = await lab.until("Chromium's DevTools endpoint", 30_000, async () => {
      const cdpPort = fs.existsSync(activePort) ? fs.readFileSync(activePort, "utf8").split("\n")[0] : undefined;
      const pages = cdpPort ? await fetch(`http://127.0.0.1:${cdpPort}/json/list`).then((r) => r.json() as Promise<Array<Body>>, () => undefined) : undefined;
      if (pages === undefined) await new Promise((r) => setTimeout(r, 200));
      return pages?.find((p) => p.type === "page");
    });
    const cdp = await connectCdp(target.webSocketDebuggerUrl as string, problems);
    cdpRef = cdp;
    cleanup.push(() => cdp.close());
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.enable");

    // 5. Pairing: the printed link mints a human key the browser keeps in IndexedDB.
    const link = cli("hub", "device", "add", "--name", "phone", "--url", `https://localhost:${TLS_PORT}`, "--home", lab.hubHome).trim();
    check(new RegExp(`^https://localhost:${TLS_PORT}/#pair=flp_[a-z2-7]+$`, "u").test(link), `hub device add printed a pairing link: ${link.replace(/flp_\w+/u, "flp_…")}`);
    await cdp.send("Page.navigate", { url: link });
    await waitInPage(cdp, "the inbox after pairing", `document.querySelector("header .status")?.textContent.includes("machines online")`);
    const stored = await lab.until("the device key in IndexedDB", 10_000, () =>
      cdp.evaluate<Body | undefined>(`new Promise((resolve) => { const q = indexedDB.open("fleetd"); q.onsuccess = () => { const g = q.result.transaction("kv").objectStore("kv").get("humanKey"); g.onsuccess = () => resolve(g.result ?? null) } })`).then((v) => v ?? undefined),
    );
    check(String(stored.key).startsWith("fld_") && (await cdp.evaluate<string>("location.hash")) === "", "paired: the key is in IndexedDB and the token is gone from the address bar");
    const listed = cli("hub", "key", "list", "--home", lab.hubHome);
    check(listed.includes(`${stored.keyId}\t`) && listed.split("\n").some((l) => l.startsWith(`${stored.keyId}\t`) && l.includes("phone (human)") && l.endsWith("active")), `hub key list shows ${stored.keyId} as phone (human), active`);
    const page = await cdp.evaluate<Body>(`(async () => {
      const res = await fetch("/");
      const reg = await navigator.serviceWorker.ready;
      return { secure: isSecureContext, worker: reg.active !== null, push: "PushManager" in window, csp: res.headers.get("content-security-policy") };
    })()`);
    check(page.secure && page.worker && page.push && String(page.csp).includes("script-src 'self' 'wasm-unsafe-eval'"), `secure context over the lab CA, service worker active, CSP: ${page.csp}`);
    ok(`5. paired ${stored.keyId} via the link; /app runs over wss through TLS; the PWA is served with its CSP`);

    // 4a. Push subscription. Headless Chromium has no browser push service, so the page registers a mock one, over
    // its own /app session with the device's key, the way PushManager's subscription would be sent.
    const ua = crypto.createECDH("prime256v1");
    ua.generateKeys();
    const uaAuth = crypto.randomBytes(16);
    const subscription = { endpoint: `http://127.0.0.1:${PUSH_PORT}/push/phone`, keys: { p256dh: ua.getPublicKey("base64url"), auth: uaAuth.toString("base64url") }, deviceName: "phone" };
    const agentSubscribe = await callTool("push_subscribe", subscription);
    check(agentSubscribe.isError && agentSubscribe.body.code === "forbidden", `push_subscribe with an agent key is refused: ${agentSubscribe.body.message}`);
    const viaPage = await cdp.evaluate<Body>(`new Promise((resolve, reject) => {
      const ws = new WebSocket("wss://" + location.host + "/app");
      const out = {};
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.t === "ready") ws.send(JSON.stringify({ t: "call", id: "v", tool: "push_vapid_key", input: {} }));
        else if (m.t === "result" && m.id === "v") { out.vapid = m.output.publicKey; ws.send(JSON.stringify({ t: "call", id: "s", tool: "push_subscribe", input: ${JSON.stringify(subscription)} })); }
        else if (m.t === "result" && m.id === "s") { out.subscribed = m.output.ok; ws.close(); resolve(out); }
        else if (m.t === "error") { ws.close(); reject(new Error(m.message)); }
      };
      ws.onopen = () => ws.send(JSON.stringify({ t: "auth", key: ${JSON.stringify(stored.key)} }));
    })`);
    check(viaPage.subscribed === true && Buffer.from(String(viaPage.vapid), "base64url").length === 65, "the device subscribed to push with its human key");
    const vapidFile = path.join(lab.hubHome, "vapid.json");
    check((fs.statSync(vapidFile).mode & 0o777) === 0o600, `VAPID keys in ${vapidFile}, mode 0600`);
    ok(`4a. push_vapid_key ${String(viaPage.vapid).slice(0, 12)}…; the device subscribed from the page (an agent key was refused)`);

    // 1. Secret ask, sealed in the page.
    const sinkDir = path.join(lab.dir, "secrets");
    fs.mkdirSync(sinkDir, { recursive: true });
    const sinkPath = path.join(sinkDir, ".env");
    fs.writeFileSync(sinkPath, "OTHER=1\n");
    const secretAsk = /\bA\d+\b/u.exec(fleetd("ask", "--kind", "secret", "--key", "stripe.test_key", "--sink", `env:${MACHINE}:${sinkPath}`, "--text", "Need the Stripe test key"))?.[0];
    check(secretAsk, "fleetd ask --kind secret filed an ask");
    await waitInPage(cdp, "the masked entry for the secret ask", `${card("Need the Stripe test key")}?.querySelector(".secret input[type=password]:not([disabled])")`);
    await cdp.evaluate(`${card("Need the Stripe test key")}.querySelector(".secret input").focus()`);
    await cdp.send("Input.insertText", { text: VALUE });
    await cdp.evaluate(`${card("Need the Stripe test key")}.querySelector(".secret button.go").click()`);
    const fingerprint = crypto.createHash("sha256").update(VALUE).digest("hex").slice(0, 8);
    await waitInPage(cdp, "the fingerprint echo", `document.body.textContent.includes("fingerprint ${fingerprint}")`);
    const sink = fs.readFileSync(sinkPath, "utf8");
    check(sink === `OTHER=1\nSTRIPE_TEST_KEY=${VALUE}\n` && (fs.statSync(sinkPath).mode & 0o777) === 0o600, "the node wrote STRIPE_TEST_KEY into the env sink, mode 0600");
    const saved = await askOf(secretAsk!, "answered");
    check(saved?.evidence === `fingerprint ${fingerprint}`, `${secretAsk} closed with evidence "${saved?.evidence}"`);
    check(!(await cdp.evaluate<string>("document.body.innerHTML")).includes(VALUE), "the value is gone from the page");
    ok(`1. secret ${secretAsk}: typed into the masked field, sealed in the browser, saved on ${MACHINE}; fingerprint ${fingerprint}`);

    // 3. Checklist with a verify check: ticked done before the step is done fails and reopens; after, it passes.
    const flag = path.join(lab.dir, "flag");
    const doAsk = /\bA\d+\b/u.exec(
      fleetd(
        "ask", "--kind", "do", "--key", "lab.m8.flag", "--class", "irreversible", "--text", "Create the M8 lab flag file", "--blocks", "the M8 lab check",
        "--step", JSON.stringify({ text: "Create the flag file", where: MACHINE, command: `touch ${flag}` }),
        "--verify", JSON.stringify({ type: "cmd", machineId: MACHINE, argv: ["test", "-f", flag], expectExit: 0 }),
      ),
    )?.[0];
    check(doAsk, "fleetd ask --kind do filed an ask");

    // 4b. It blocks an irreversible step, so it is loud: pushed at once, one line, no secret.
    await push.next(1, 30_000);
    const first = push.received[0]!;
    const line = decryptPayload(first.body, { privateKey: ua.getPrivateKey(), auth: uaAuth }).toString("utf8");
    check(line.startsWith(`${doAsk} irreversible checklist: Create the M8 lab flag file`) && !line.includes("\n") && !line.includes(VALUE), `push decrypts to one line without the secret: "${line}"`);
    const jwt = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/u.exec(String(first.headers.authorization));
    const vapidPub = Buffer.from(String(viaPage.vapid), "base64url");
    const verifier = crypto.createPublicKey({ key: { kty: "EC", crv: "P-256", x: vapidPub.subarray(1, 33).toString("base64url"), y: vapidPub.subarray(33).toString("base64url") }, format: "jwk" });
    check(
      jwt !== null && jwt[4] === viaPage.vapid && first.headers["content-encoding"] === "aes128gcm" &&
        JSON.parse(Buffer.from(jwt[2]!, "base64url").toString()).aud === `http://127.0.0.1:${PUSH_PORT}` &&
        crypto.verify("sha256", Buffer.from(`${jwt[1]}.${jwt[2]}`), { key: verifier, dsaEncoding: "ieee-p1363" }, Buffer.from(jwt[3]!, "base64url")),
      "the push is aes128gcm with a VAPID JWT for the push service's origin, signed by the hub's key",
    );
    const sent = await lab.waitEvent("push.sent", 10_000, { cursor: scenarioStart, types: ["push.sent"] });
    check(sent.event.data?.items === 1 && sent.event.data?.devices === 1 && !JSON.stringify(sent.event).includes("flag"), `push.sent carries counts only: ${JSON.stringify(sent.event.data)}`);
    ok(`4b. loud ${doAsk} pushed at once: "${line}"`);

    let cursor = await lab.cursor();
    check(await waitInPage(cdp, "the checklist's Done tap", tap("Create the M8 lab flag file", "✓ Done")), "tapped ✓ Done");
    await lab.waitEvent(`${doAsk} reopened`, 60_000, { cursor, types: ["ask.created"], match: (e) => e.data?.askId === doAsk && e.data?.reopened === true });
    const evidence = await waitInPage<string>(cdp, "the reopened checklist with its evidence", `${card("Create the M8 lab flag file")}?.querySelector("pre.evidence")?.textContent`);
    check(evidence.startsWith("ticked done, but its check failed"), `reopened with the failing evidence: ${JSON.stringify(evidence)}`);
    fs.writeFileSync(flag, "");
    check(await waitInPage(cdp, "the Done tap after the step", tap("Create the M8 lab flag file", "✓ Done")), "tapped ✓ Done again");
    const verified = await lab.until(`${doAsk} verified`, 60_000, async () => {
      const ask = await askOf(doAsk!, "answered");
      if (ask?.evidence?.startsWith("verified:")) return ask;
      await callTool("events_wait", { cursor: await lab.cursor(), timeoutSec: 5 });
      return undefined;
    });
    ok(`3. checklist ${doAsk}: the first tick reopened it ("${evidence.split("\n")[0]}"), the second passed: ${verified.evidence}`);

    // 2. Approve ask. The lead: an earlier scenario's, else a fresh one now.
    const outcome = (await callTool("project_get", ref)).body;
    let leadThread = outcome.lead?.threadId as string | undefined;
    let turns = 0;
    if (leadThread === undefined) {
      const from = await lab.cursor();
      const started = await callTool("lead_start", { ...ref, model: MODEL, effort: "low" });
      check(!started.isError, `lead_start: ${JSON.stringify(started.body)}`);
      leadThread = started.body.threadId as string;
      await lab.waitEvent("lead start turn", TURN_MS, { cursor: from, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) });
      turns++;
      ok(`lead ${leadThread} started (${MODEL})`);
    }
    const gatedFile = path.join(lab.dir, "fleetd-gated-test");
    const argv = ["sh", "-c", `echo deployed > ${gatedFile}`];
    const gatedAsk = /\bA\d+\b/u.exec(fleetd("gated", "run", "--class", "irreversible", "--argv", JSON.stringify(argv), "--reason", "prod deploy test"))?.[0];
    check(gatedAsk, "fleetd gated run filed an approve ask");
    const approve = await askOf(gatedAsk!, "open");
    check(JSON.stringify(approve?.gated?.argv) === JSON.stringify(argv) && approve?.gated?.cwd === root, `${gatedAsk} stores the exact argv and the workspace as cwd`);
    const byAgent = await callTool("inbox_reply", { raw: `${approve!.number} go`, batchId: approve!.batchId });
    check(byAgent.isError && byAgent.body.code === "forbidden", `an agent key's "go" is refused: ${byAgent.body.message}`);
    await waitInPage(cdp, "the approval card with the exact argv", `${card("prod deploy test")}?.querySelector("dl.gated code")?.textContent === ${JSON.stringify(JSON.stringify(argv))}`);
    cursor = await lab.cursor();
    check(await cdp.evaluate(tap("prod deploy test", "Approve")), "tapped Approve");
    const ran = await lab.waitEvent("gated.ran", 60_000, { cursor, types: ["gated.ran"], match: (e) => e.data?.askId === gatedAsk });
    check(ran.event.data.exitCode === 0 && ran.event.data.by === "human:phone", `gated.ran: ${JSON.stringify(ran.event.data)}`);
    check(fs.readFileSync(gatedFile, "utf8") === "deployed\n", "the node ran the stored argv");
    const done = await askOf(gatedAsk!, "answered");
    check(String(done?.evidence).startsWith(`exit 0 on ${MACHINE}, approved by human:phone`), `evidence: ${JSON.stringify(done?.evidence)}`);
    const woken = await lab.waitEvent("the lead woken with the result", 120_000, {
      cursor: ran.cursor,
      types: ["lead.woken"],
      match: (e) => e.threadId === leadThread && (e.data?.triggers as Array<string> | undefined)?.includes("answer") === true,
    });
    await lab.waitEvent("the lead's wake turn", TURN_MS, { cursor: woken.cursor, machineId: MACHINE, match: (e) => e.threadId === leadThread && ENDED.includes(e.type) });
    ok(`2. approval ${gatedAsk}: refused to an agent, run after the tap (${done?.evidence?.split("\n")[0]}); ${woken.event.summary}`);

    // 4c. Coalescing: the reopened checklist and the approval were loud too, but within 20 minutes of the first push.
    const pushes = await allEvents(scenarioStart, { types: ["push.sent"] });
    check(push.received.length === 1 && pushes.length === 1, `one push in the window: ${push.received.length} at the push service, ${pushes.length} push.sent`);
    ok("4c. later loud items wait for the 20-minute window (unit tests cover the folded +N more push and quiet hours)");

    // 1b. The value appears nowhere but the sink: hub DB files, hub and node logs, every event, the node homes.
    const events = await allEvents(0);
    const places: Array<[string, string]> = [
      ...filesUnder(lab.hubHome),
      ...filesUnder(path.join(RUN, "logs")),
      ...fs.readdirSync(RUN).filter((d) => d.startsWith("node-")).flatMap((d) => filesUnder(path.join(RUN, d))),
      ["events", JSON.stringify(events)],
      ...push.received.map((p, i): [string, string] => [`push ${i}`, decryptPayload(p.body, { privateKey: ua.getPrivateKey(), auth: uaAuth }).toString()]),
    ];
    const hits = places.filter(([, text]) => text.includes(VALUE)).map(([where]) => where);
    check(hits.length === 0, `the secret is in ${hits.join(", ")}`);
    ok(`1b. the plaintext is in none of ${places.length} places searched (hub db and files, ${events.length} events, hub/node/chrome logs, node homes, pushes)`);

    check(cdp.problems.length === 0, `page errors (CSP violations would show here): ${cdp.problems.join(" | ")}`);
    const leadTurns = (await allEvents(scenarioStart, { machineId: MACHINE, types: ["thread.completed"] })).filter((e) => e.threadId === leadThread).length;
    ok(`m8: no page errors; ${Math.max(turns, leadTurns)} lead turn(s) in this scenario`);
  } catch (error) {
    // What the page looked like when it failed, for the person reading the log.
    if (cdpRef !== undefined) {
      const cdp = cdpRef;
      await cdp.evaluate<string>("location.href + '\\n' + document.documentElement.outerHTML").then((html) => fs.writeFileSync(path.join(lab.dir, "page.html"), html), () => undefined);
      await cdp.send("Page.captureScreenshot", { format: "png" }).then((shot) => fs.writeFileSync(path.join(lab.dir, "page.png"), Buffer.from(String(shot.data), "base64")), () => undefined);
      lab.log(`page at failure: ${path.join(lab.dir, "page.html")}, page.png`);
    }
    throw problems.length === 0 ? error : new Error(`${error instanceof Error ? error.message : String(error)}; page errors: ${problems.join(" | ")}`, { cause: error });
  } finally {
    for (const step of cleanup.toReversed()) await step();
    fs.rmSync(path.join(lab.dir, "secrets"), { recursive: true, force: true });
  }
}
