// A sealed secret and an approved command end to end over a real node link: the hub's approvals, ledger, event log
// and file database on one side, the real node with its box key and sinks on the other. The plaintext must reach the
// sink file and the approved command, and nothing else: no hub row, event, log line or result.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { type DecisionKey, MachineId, type ProjectId, type ProjectSummary } from "@fleetd/contracts";
import { Approvals, layer as approvalsLayer } from "@fleetd/hub/approvals/Approvals.ts";
import * as Auth from "@fleetd/hub/auth/Auth.ts";
import * as NodeCommands from "@fleetd/hub/checks/NodeCommands.ts";
import * as Executors from "@fleetd/hub/executor/Executors.ts";
import * as LeadsLayer from "@fleetd/hub/leads/layer.ts";
import { Asks } from "@fleetd/hub/ledger/Asks.ts";
import { Inbox } from "@fleetd/hub/ledger/Inbox.ts";
import * as NodeLinkServer from "@fleetd/hub/link/NodeLinkServer.ts";
import * as WriteQueue from "@fleetd/hub/queue/WriteQueue.ts";
import * as EventLog from "@fleetd/hub/store/EventLog.ts";
import * as HubDb from "@fleetd/hub/store/HubDb.ts";
import * as HubStore from "@fleetd/hub/store/HubStore.ts";
import { loadOrCreateBoxKey, loadOrCreateIdentity } from "@fleetd/node/identity.ts";
import { runNode } from "@fleetd/node/link.ts";
import { T3Sessions } from "@fleetd/node/T3Sessions.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Queue from "effect/Queue";
import * as Redacted from "effect/Redacted";
import * as Socket from "effect/socket/Socket";
import sodium from "libsodium-wrappers";
import { afterAll, describe, expect, it } from "vitest";

const tmp = (prefix: string) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
const hubHome = tmp("fleetd-hub-");
const nodeHome = tmp("fleetd-node-");
const workspace = tmp("fleetd-workspace-");
afterAll(() => {
  for (const dir of [hubHome, nodeHome, workspace]) fs.rmSync(dir, { recursive: true, force: true });
});

const LAB = MachineId.make("lab-a");
const REF = { machineId: LAB, projectId: "p1" as ProjectId };
const VALUE = "fake-secret-plaintext-never-on-the-hub";

const socketPair = Effect.gen(function* () {
  const closed = (code: number) => new Socket.SocketError({ reason: new Socket.SocketCloseError({ code }) });
  const toHub = yield* Queue.unbounded<string, Socket.SocketError>();
  const toNode = yield* Queue.unbounded<string, Socket.SocketError>();
  const end = (inbox: typeof toHub, outbox: typeof toHub) =>
    Socket.make({
      reader: Effect.succeed({ pull: Effect.map(Queue.take(inbox), (frame) => [frame] as const), upgrade: () => Effect.void }),
      writer: Effect.succeed({
        write: (chunk) =>
          Socket.isCloseEvent(chunk)
            ? Effect.all([Queue.fail(outbox, closed(chunk.code)), Queue.fail(inbox, closed(chunk.code))]).pipe(Effect.asVoid)
            : Queue.offer(outbox, String(chunk)).pipe(Effect.asVoid),
        writeAll: (chunks) => Queue.offerAll(outbox, chunks.map(String)).pipe(Effect.asVoid),
      }),
    });
  return { hub: end(toHub, toNode), node: end(toNode, toHub) };
});

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

const logs: Array<string> = [];
const capture = Logger.map(Logger.formatJson, (line) => void logs.push(line));

const hubLayer = approvalsLayer.pipe(
  Layer.provideMerge(LeadsLayer.layerWithLedger({ prompt: "You lead {{project}}." })),
  Layer.provideMerge(WriteQueue.layer()),
  Layer.provideMerge(
    Layer.mergeAll(HubStore.layer, EventLog.layer, Auth.layer, NodeCommands.layer, Layer.succeed(Executors.Executors, executors)),
  ),
  Layer.provideMerge(HubDb.layer(hubHome)),
);

/** Every byte under `dir`, as one string per file, so a test can look for a value anywhere on disk. */
const filesUnder = (dir: string): Array<[string, string]> =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry): Array<[string, string]> => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return filesUnder(full);
    return entry.isFile() ? [[full, fs.readFileSync(full).toString("latin1")]] : [];
  });

describe("sealed secrets and approved commands over a node link", () => {
  it("writes the secret only to its sink, injects it into the approved command, and keeps it out of every hub record", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const auth = yield* Auth.Auth;
        const store = yield* HubStore.HubStore;
        const events = yield* EventLog.EventLog;
        const approvals = yield* Approvals;
        yield* store.projects.upsertMany(LAB, [
          { machineId: LAB, projectId: REF.projectId, title: "Demo", workspaceRoot: workspace, threads: { running: 0, waiting: 0, idle: 0, failed: 0 }, lastActivityAt: "2026-10-17T10:00:00.000Z" } as ProjectSummary,
        ]);
        const server = yield* NodeLinkServer.make({ hubId: "hub", executors, commands: yield* NodeCommands.NodeCommands });
        const { token } = yield* auth.createEnrollToken(LAB);
        const box = yield* Effect.promise(() => loadOrCreateBoxKey(nodeHome));
        yield* runNode({
          settings: { machineId: LAB, name: "Lab A", tags: [], nodeVersion: "0.0.0", t3Url: "http://127.0.0.1:4711" },
          identity: loadOrCreateIdentity(nodeHome),
          dial: Effect.gen(function* () {
            const pair = yield* socketPair;
            yield* Effect.forkDetach(server.handle(pair.hub));
            return pair.node;
          }),
          t3Info: Effect.succeed({ version: "0.1.0", protocol: 2 }),
          enrollToken: token,
          cmdRoots: [workspace],
          secrets: { box, home: nodeHome },
        }).pipe(
          Effect.provide(
            Layer.succeed(T3Sessions)({
              mint: Effect.succeed({ sessionId: "s-1", bearer: Redacted.make("bearer-1"), expiresAt: "later" }),
              revoke: () => Effect.void,
            }),
          ),
          Effect.scoped,
          Effect.forkScoped,
        );
        yield* events.wait({ cursor: 0, types: ["machine.online"], timeoutSec: 10 });
        const machine = yield* store.machines.get(LAB);
        expect(machine?.boxPubKey).toBe(box.publicKey);

        // The lead's `fleetd ask --kind secret`, then the phone: sealed in the browser to the machine's box key.
        const asks = yield* Asks;
        const { ask } = yield* asks.create(
          {
            projectRef: REF,
            kind: "secret",
            key: "stripe.test_key" as DecisionKey,
            class: "credential",
            text: "Need the Stripe test key",
            sink: `env:lab-a:${workspace}/app.env`,
            blocks: "nothing",
            proceededOnRec: false,
          },
          "lead:lab-a/p1",
        );
        yield* Effect.promise(() => sodium.ready);
        const sealed = Buffer.from(sodium.crypto_box_seal(new TextEncoder().encode(VALUE), Buffer.from(machine!.boxPubKey!, "base64"))).toString("base64");
        const phone = (yield* auth.createKey("phone", [{ role: "operate", machines: "*" }], "human")).info;
        const fingerprint = createHash("sha256").update(VALUE).digest("hex").slice(0, 8);
        expect(yield* approvals.submitSecret(phone, { askId: ask.askId, sealed })).toMatchObject({ fingerprint });
        const sink = path.join(workspace, "app.env");
        expect(fs.readFileSync(sink, "utf8")).toBe(`STRIPE_TEST_KEY=${VALUE}\n`);
        expect(fs.statSync(sink).mode & 0o777).toBe(0o600);
        expect(yield* asks.get(ask.askId)).toMatchObject({ state: "answered", evidence: `fingerprint ${fingerprint}` });

        // `fleetd gated run`, approved with a human's "go": the node runs the stored argv with the secret injected.
        const filed = yield* approvals.gatedRun(REF, "lead:lab-a/p1", {
          argv: ["sh", "-c", 'echo "deploying with $STRIPE"; echo deployed > deployed.txt'],
          class: "irreversible",
          reason: "prod deploy test",
          secretEnv: [{ name: "STRIPE", secretKey: "stripe.test_key" as DecisionKey }],
          timeoutSec: 60,
        });
        const approve = (yield* asks.get(filed.askId))!;
        const cursor = yield* events.head();
        yield* (yield* Inbox).reply({ raw: `#${approve.batchId} ${approve.number} go` }, { source: "human", by: "human:phone" });
        const ran = yield* events.wait({ cursor, types: ["gated.ran"], timeoutSec: 30 });
        expect(ran.events[0]!.data).toMatchObject({ askId: filed.askId, exitCode: 0, timedOut: false, by: "human:phone" });
        expect(fs.readFileSync(path.join(workspace, "deployed.txt"), "utf8")).toBe("deployed\n");
        expect((yield* asks.get(filed.askId))!.evidence).toBe("exit 0 on lab-a, approved by human:phone\ndeploying with [secret]");

        // Neither the value nor its ciphertext is anywhere the hub keeps or says anything.
        const everything = [
          ...filesUnder(hubHome),
          ["events", JSON.stringify((yield* events.wait({ cursor: 0, timeoutSec: 0 })).events)],
          ["logs", logs.join("\n")],
        ] as Array<[string, string]>;
        // The search reads what it should: the database files hold the ask, the logs hold the link's lines.
        expect(filesUnder(hubHome).some(([, text]) => text.includes(`fingerprint ${fingerprint}`))).toBe(true);
        expect(logs.join("\n")).toContain("linked to hub");
        for (const [where, text] of everything) {
          expect(text.includes(VALUE), `${where} holds the plaintext`).toBe(false);
          expect(text.includes(sealed), `${where} holds the ciphertext`).toBe(false);
        }
        // The node keeps only an index of which sink holds which key.
        expect(fs.readFileSync(path.join(nodeHome, "secret-sinks.json"), "utf8")).not.toContain(VALUE);
      }).pipe(Effect.scoped, Effect.provide(hubLayer), Effect.provide(Logger.layer([capture]))),
    ), 30_000);
});
