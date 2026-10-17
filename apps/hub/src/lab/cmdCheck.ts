// `node apps/hub/src/lab/cmdCheck.ts`: real `cmd_check`s through a real `fleetd node` process. Runs a bare hub
// in-process (node link and NodeCommands only) on a lab port, enrolls a node that dials it, and runs commands in the
// lab's repo-a. No T3 and no claude turns are needed: the node links as degraded. Never used in CI.
import { spawn } from "node:child_process";
import fs from "node:fs";
import * as NodeHttp from "node:http";
import path from "node:path";
import type { MachineId } from "@fleetd/contracts";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as Auth from "../auth/Auth.ts";
import * as NodeCommands from "../checks/NodeCommands.ts";
import * as NodeLinkServer from "../link/NodeLinkServer.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubDb from "../store/HubDb.ts";
import * as HubStore from "../store/HubStore.ts";
import { LAB, REPO, scrubbedEnv } from "./harness.ts";

const PORT = Number(process.env.FLEETD_LAB_CMD_PORT ?? 4781);
const DIR = path.join(LAB, `m6a-cmd-check-${PORT}`);
const MACHINE = "lab-m6a" as MachineId;
const WORKSPACE = path.join(LAB, "repo-a");

fs.rmSync(DIR, { recursive: true, force: true });
fs.mkdirSync(DIR, { recursive: true });

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
    return yield* NodeLinkServer.make({
      hubId: "fleetd-lab-m6a",
      executors: { attach: () => Effect.void, detach: () => Effect.void },
      commands: yield* NodeCommands.NodeCommands,
    });
  }),
);

const hub = HttpRouter.serve(linkRoute, { disableLogger: true }).pipe(
  Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: PORT })),
  Layer.provideMerge(linkServer),
  Layer.provideMerge(Layer.mergeAll(NodeCommands.layer, HubStore.layer, EventLog.layer, Auth.layer)),
  Layer.provideMerge(HubDb.layer(path.join(DIR, "hub"))),
);

const program = Effect.gen(function* () {
  const auth = yield* Auth.Auth;
  const events = yield* EventLog.EventLog;
  const commands = yield* NodeCommands.NodeCommands;
  const { token } = yield* auth.createEnrollToken(MACHINE);
  const cursor = yield* events.head();

  const log = fs.openSync(path.join(DIR, "node.log"), "a");
  const node = spawn(
    process.execPath,
    [
      path.join(REPO, "apps/cli/src/bin.ts"),
      "node", "join",
      "--hub", `http://127.0.0.1:${PORT}`,
      "--token", token,
      "--machine", MACHINE,
      "--t3-home", path.join(DIR, "t3-home"),
      // Nothing listens here: the node links as degraded, which is all cmd_check needs.
      "--t3-url", `http://127.0.0.1:${PORT + 1}`,
      "--home", path.join(DIR, "node"),
    ],
    { env: scrubbedEnv(), stdio: ["ignore", log, log] },
  );
  console.log(`started fleetd node pid=${node.pid}`);
  yield* Effect.addFinalizer(() =>
    Effect.promise(() => {
      const exited = new Promise((resolve) => node.once("exit", resolve));
      node.kill("SIGTERM");
      return exited.then(() => console.log(`stopped fleetd node pid=${node.pid}`));
    }),
  );

  const linked = yield* events.wait({ cursor, types: ["machine.online", "machine.degraded"], machineId: MACHINE, timeoutSec: 60 });
  if (linked.events.length === 0) return yield* Effect.die(new Error("the node did not link within 60 s; see node.log"));
  console.log(`node linked: ${linked.events[0]!.summary}`);

  const cases: ReadonlyArray<{ readonly argv: ReadonlyArray<string>; readonly cwd?: string; readonly timeoutSec?: number }> = [
    { argv: ["test", "-f", "README.md"] },
    { argv: ["false"] },
    { argv: ["sh", "-c", "echo before; sleep 30"], timeoutSec: 2 },
    { argv: ["true"], cwd: "/etc" },
  ];
  for (const c of cases) {
    const out = yield* Effect.result(commands.run(MACHINE, { cwd: c.cwd ?? WORKSPACE, argv: c.argv, ...(c.timeoutSec === undefined ? {} : { timeoutSec: c.timeoutSec }) }));
    console.log(`${JSON.stringify(c.argv)} in ${c.cwd ?? WORKSPACE} → ${JSON.stringify(out._tag === "Success" ? out.success : out.failure)}`);
  }
});

await Effect.runPromise(program.pipe(Effect.scoped, Effect.provide(hub)));
