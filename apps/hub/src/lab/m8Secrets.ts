// `node apps/hub/src/lab/m8Secrets.ts` (after `pnpm --filter fleetd build`): one sealed secret and one approved
// command through a real `fleetd node` process from the bundled CLI. Runs a bare hub in-process (node link, ledger,
// leads and approvals) on a lab port; the node links as degraded, since no T3 and no claude turns are needed. Seals
// the value with libsodium as the browser does, then searches the hub's files, events and logs and the node's log
// for it. Never used in CI.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import * as NodeHttp from "node:http";
import path from "node:path";
import type { DecisionKey, MachineId, ProjectId, ProjectSummary } from "@fleetd/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import sodium from "libsodium-wrappers";
import { Approvals, layer as approvalsLayer } from "../approvals/Approvals.ts";
import * as Auth from "../auth/Auth.ts";
import * as NodeCommands from "../checks/NodeCommands.ts";
import * as Executors from "../executor/Executors.ts";
import * as LeadsLayer from "../leads/layer.ts";
import { Asks } from "../ledger/Asks.ts";
import { Inbox } from "../ledger/Inbox.ts";
import * as NodeLinkServer from "../link/NodeLinkServer.ts";
import * as WriteQueue from "../queue/WriteQueue.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import { CLI, LAB, scrubbedEnv } from "./harness.ts";

const PORT = Number(process.env.FLEETD_LAB_M8_PORT ?? 4783);
const DIR = path.join(LAB, `m8a-secrets-${PORT}`);
const MACHINE = "lab-m8a" as MachineId;
const REF = { machineId: MACHINE, projectId: "m8a" as ProjectId };
const WORKSPACE = path.join(DIR, "workspace");
// A fresh value per run, so a hit can only come from this run.
const VALUE = `lab-fake-secret-${createHash("sha256").update(String(process.hrtime.bigint())).digest("hex").slice(0, 24)}`;

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(WORKSPACE, { recursive: true });

const say = (line: string) => console.log(line);
const check = (cond: unknown, what: string) => {
  if (!cond) throw new Error(`check failed: ${what}`);
  say(`ok  ${what}`);
};

const logs: Array<string> = [];
const capture = Logger.map(Logger.formatJson, (line) => void logs.push(line));

const executors = Executors.Executors.of({
  attach: () => Effect.void,
  detach: () => Effect.void,
  isConnected: () => Effect.succeed(false),
  awaitLive: () => Effect.never,
  launch: (machineId) => Effect.fail(new Executors.MachineNotConnected({ machineId })),
  send: (ref) => Effect.fail(new Executors.MachineNotConnected({ machineId: ref.machineId })),
  interrupt: () => Effect.void,
  tail: (ref) => Effect.fail(new Executors.ThreadNotFound({ machineId: ref.machineId, threadId: ref.threadId })),
  actions: () => Effect.succeed([]),
});

const linkRoute = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const link = yield* NodeLinkServer.NodeLinkServer;
    yield* router.add(
      "GET",
      "/node/link",
      Effect.gen(function* () {
        const socket = yield* (yield* HttpServerRequest.HttpServerRequest).upgrade;
        yield* Effect.scoped(link.handle(socket));
        return HttpServerResponse.empty();
      }),
    );
  }),
);

const linkServer = Layer.effect(
  NodeLinkServer.NodeLinkServer,
  Effect.gen(function* () {
    return yield* NodeLinkServer.make({ hubId: "fleetd-lab-m8a", executors, commands: yield* NodeCommands.NodeCommands });
  }),
);

const hub = HttpRouter.serve(linkRoute, { disableLogger: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: PORT })),
  Layer.provideMerge(linkServer),
  Layer.provideMerge(approvalsLayer),
  Layer.provideMerge(LeadsLayer.layerWithLedger({ prompt: "You lead {{project}}." })),
  Layer.provideMerge(WriteQueue.layer()),
  Layer.provideMerge(Layer.mergeAll(NodeCommands.layer, HubStore.layer, EventLog.layer, Auth.layer, Layer.succeed(Executors.Executors, executors))),
  Layer.provideMerge(HubDb.layer(path.join(DIR, "hub"))),
);

const filesUnder = (dir: string): Array<[string, string]> =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.isFile() ? [[full, fs.readFileSync(full).toString("latin1")]] : [];
  });

const program = Effect.gen(function* () {
  const auth = yield* Auth.Auth;
  const events = yield* EventLog.EventLog;
  const store = yield* HubStore.HubStore;
  const asks = yield* Asks;
  const approvals = yield* Approvals;
  yield* store.projects.upsertMany(MACHINE, [
    { machineId: MACHINE, projectId: REF.projectId, title: "m8a", workspaceRoot: WORKSPACE, threads: { running: 0, waiting: 0, idle: 0, failed: 0 }, lastActivityAt: new Date().toISOString() } as ProjectSummary,
  ]);
  const { token } = yield* auth.createEnrollToken(MACHINE);
  const cursor = yield* events.head();

  const nodeLog = path.join(DIR, "node.log");
  const out = fs.openSync(nodeLog, "a");
  const node = spawn(
    process.execPath,
    [
      CLI, "node", "join",
      "--hub", `http://127.0.0.1:${PORT}`,
      "--token", token,
      "--machine", MACHINE,
      "--t3-home", path.join(DIR, "t3-home"),
      // Nothing listens here: the node links as degraded, which secrets and approved commands do not mind.
      "--t3-url", `http://127.0.0.1:${PORT + 1}`,
      "--home", path.join(DIR, "node"),
    ],
    { env: scrubbedEnv(), stdio: ["ignore", out, out] },
  );
  say(`started fleetd node pid=${node.pid}`);
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => {
      const exited = new Promise((resolve) => node.once("exit", resolve));
      node.kill("SIGTERM");
      return exited.then(() => say(`stopped fleetd node pid=${node.pid}`));
    }),
  );
  const linked = yield* events.wait({ cursor, types: ["machine.online", "machine.degraded"], machineId: MACHINE, timeoutSec: 60 });
  if (linked.events.length === 0) return yield* Effect.die(new Error("the node did not link within 60 s; see node.log"));
  const machine = yield* store.machines.get(MACHINE);
  const keyFile = path.join(DIR, "node", "node-box-key.pem");
  check(machine?.boxPubKey !== undefined && (fs.statSync(keyFile).mode & 0o777) === 0o600, `node linked with boxPubKey ${machine?.boxPubKey}, key file 0600`);

  // 1. fleetd ask --kind secret, then the phone seals and submits.
  const sinkPath = path.join(WORKSPACE, ".env");
  fs.writeFileSync(sinkPath, "OTHER=1\nSTRIPE_TEST_KEY=old\n");
  const { ask } = yield* asks.create(
    { projectRef: REF, kind: "secret", key: "stripe.test_key" as DecisionKey, class: "credential", text: "Need the Stripe test key", sink: `env:${MACHINE}:${sinkPath}`, blocks: "nothing", proceededOnRec: false },
    "lead:lab-m8a/m8a",
  );
  yield* Effect.promise(() => sodium.ready);
  const sealed = Buffer.from(sodium.crypto_box_seal(new TextEncoder().encode(VALUE), Buffer.from(machine!.boxPubKey!, "base64"))).toString("base64");
  const agent = (yield* auth.createKey("lab-agent", [{ role: "operate", machines: "*" }])).info;
  const phone = (yield* auth.createKey("lab-phone", [{ role: "operate", machines: "*" }], "human")).info;
  const refused = yield* Effect.flip(approvals.submitSecret(agent, { askId: ask.askId, sealed }));
  check(refused.code === "forbidden", `agent key refused for secret_submit: ${refused.message}`);
  const fingerprint = createHash("sha256").update(VALUE).digest("hex").slice(0, 8);
  const saved = yield* approvals.submitSecret(phone, { askId: ask.askId, sealed });
  check(saved.fingerprint === fingerprint, `node returned fingerprint ${saved.fingerprint}`);
  check(fs.readFileSync(sinkPath, "utf8") === `OTHER=1\nSTRIPE_TEST_KEY=${VALUE}\n` && (fs.statSync(sinkPath).mode & 0o777) === 0o600, "sink rewritten 0600, existing line replaced");
  const closed = (yield* asks.get(ask.askId))!;
  check(closed.state === "answered" && closed.evidence === `fingerprint ${fingerprint}`, `ask ${ask.askId} closed with evidence "${closed.evidence}"`);

  // 2. fleetd gated run, refused for an agent, run after a human's go.
  const filed = yield* approvals.gatedRun(REF, "lead:lab-m8a/m8a", {
    argv: ["sh", "-c", 'echo "deploying with $STRIPE"; echo deployed > deployed.txt'],
    class: "irreversible",
    reason: "lab deploy test",
    secretEnv: [{ name: "STRIPE", secretKey: "stripe.test_key" as DecisionKey }],
    timeoutSec: 60,
  });
  const approve = (yield* asks.get(filed.askId))!;
  say(`approve ask ${approve.askId} (${approve.key}): ${approve.text}`);
  const inbox = yield* Inbox;
  const raw = `#${approve.batchId} ${approve.number} go`;
  const byAgent = yield* Effect.flip(inbox.reply({ raw }, { source: "agent", by: "lab-agent" }));
  check(byAgent.code === "forbidden", `agent "go" refused: ${byAgent.message}`);
  const before = yield* events.head();
  const replied = yield* inbox.reply({ raw }, { source: "human", by: "human:lab-phone" });
  say(`human reply: ${replied.echo}`);
  const ran = yield* events.wait({ cursor: before, types: ["gated.ran"], timeoutSec: 60 });
  check(ran.events.length === 1, `gated.ran: ${JSON.stringify(ran.events[0]?.data)}`);
  const evidence = (yield* asks.get(filed.askId))!.evidence ?? "";
  check(evidence.includes("deploying with [secret]") && evidence.startsWith("exit 0"), `evidence: ${JSON.stringify(evidence)}`);
  check(fs.readFileSync(path.join(WORKSPACE, "deployed.txt"), "utf8") === "deployed\n", "the stored command ran in the project workspace");

  // 3. The value and its ciphertext appear nowhere but the sink.
  const everywhere: Array<[string, string]> = [
    ...filesUnder(path.join(DIR, "hub")),
    ["events", JSON.stringify((yield* events.wait({ cursor: 0, timeoutSec: 0 })).events)],
    ["hub logs", logs.join("\n")],
    [nodeLog, fs.readFileSync(nodeLog, "utf8")],
    ...filesUnder(path.join(DIR, "node")),
  ];
  for (const [where, text] of everywhere) {
    if (text.includes(VALUE) || text.includes(sealed)) throw new Error(`check failed: ${where} holds the secret or its ciphertext`);
  }
  check(true, `plaintext and ciphertext found in none of ${everywhere.length} places searched (hub db files, events, hub logs, node log, node home)`);
});

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(hub), Effect.provide(Logger.layer([capture]))));
