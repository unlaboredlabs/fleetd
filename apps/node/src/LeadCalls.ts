import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { LeadCallFrame, type LeadResultFrame, type McpToolError } from "@fleetd/contracts";
import { Cause, Data, Deferred, Duration, Effect, Exit, FiberSet, Latch, Option, Schema, type Scope } from "effect";

/** Where the lead-side `fleetd` CLI reaches this node. */
export const leadSocketPath = (home: string) => path.join(home, "node.sock");

/** The node's half of lead-side calls: CLI frames in from the socket, out over whichever link is up. */
export interface LeadRelay {
  /** Forwards one CLI frame and returns the hub's answer under the CLI's id. Never fails: trouble is an error frame. */
  readonly call: (frame: LeadCallFrame) => Effect.Effect<LeadResultFrame>;
  /** A welcomed link routes calls through `send` until its scope closes; calls still waiting then get an error. */
  readonly attach: (send: (frame: LeadCallFrame) => Effect.Effect<void, unknown>) => Effect.Effect<void, never, Scope.Scope>;
  /** A `lead_result` frame from the hub. */
  readonly resolve: (frame: LeadResultFrame) => Effect.Effect<void>;
}

export const HUB_UNREACHABLE = "fleetd hub unreachable; the node keeps retrying — try again shortly";

const errorFrame = (id: string, error: McpToolError): LeadResultFrame => ({ t: "lead_result", id, error });

export interface LeadRelayOptions {
  /** How long a call waits for a link when none is up. */
  readonly linkWait?: Duration.Input;
  /** How long a forwarded call waits for the hub's answer. */
  readonly answerTimeout?: Duration.Input;
}

export const makeLeadRelay = (options: LeadRelayOptions = {}) =>
  Effect.gen(function* () {
    const linkWait = Duration.fromInputUnsafe(options.linkWait ?? "5 seconds");
    const answerTimeout = Duration.fromInputUnsafe(options.answerTimeout ?? "30 seconds");
    const linked = yield* Latch.make(false);
    let send: ((frame: LeadCallFrame) => Effect.Effect<void, unknown>) | undefined;
    const pending = new Map<string, Deferred.Deferred<LeadResultFrame>>();
    let nextId = 0;

    const unanswered = (why: string): McpToolError => ({
      code: "machine_offline",
      message: `${why}; the call may or may not have gone through`,
      fix: "try again shortly",
    });

    const forward = (frame: LeadCallFrame, through: (frame: LeadCallFrame) => Effect.Effect<void, unknown>) =>
      Effect.gen(function* () {
        // The hub sees node-chosen ids, so two CLIs picking the same id cannot cross answers.
        const id = `lc-${++nextId}`;
        const answer = yield* Deferred.make<LeadResultFrame>();
        pending.set(id, answer);
        return yield* through({ ...frame, id }).pipe(
          Effect.andThen(Deferred.await(answer).pipe(Effect.timeoutOption(answerTimeout))),
          Effect.map((result) =>
            Option.isSome(result)
              ? result.value
              : errorFrame(id, unanswered(`the fleetd hub did not answer within ${Duration.toSeconds(answerTimeout)} s`)),
          ),
          Effect.catch(() => Effect.succeed(errorFrame(id, unanswered("the link to the fleetd hub dropped while sending")))),
          Effect.ensuring(Effect.sync(() => pending.delete(id))),
        );
      });

    const call = (frame: LeadCallFrame): Effect.Effect<LeadResultFrame> =>
      Effect.gen(function* () {
        const up = yield* linked.await.pipe(Effect.timeoutOption(linkWait));
        const through = send;
        if (Option.isNone(up) || through === undefined) return errorFrame(frame.id, { code: "machine_offline", message: HUB_UNREACHABLE });
        const result = yield* forward(frame, through);
        return { ...result, id: frame.id };
      });

    const attach = (through: (frame: LeadCallFrame) => Effect.Effect<void, unknown>) =>
      Effect.acquireRelease(
        Effect.suspend(() => {
          send = through;
          return linked.open;
        }),
        () =>
          Effect.gen(function* () {
            send = undefined;
            yield* linked.close;
            for (const [id, answer] of pending) {
              yield* Deferred.succeed(answer, errorFrame(id, unanswered("the link to the fleetd hub dropped before it answered")));
            }
          }),
      ).pipe(Effect.asVoid);

    const resolve = (frame: LeadResultFrame) =>
      Effect.suspend(() => {
        const answer = pending.get(frame.id);
        return answer === undefined ? Effect.void : Deferred.succeed(answer, frame).pipe(Effect.asVoid);
      });

    return { call, attach, resolve } satisfies LeadRelay;
  });

export class LeadSocketError extends Data.TaggedError("LeadSocketError")<{ readonly message: string }> {}

/** One CLI frame is a few KB at most; anything near this is not a CLI. */
const MAX_FRAME_BYTES = 256 * 1024;

const decodeCall = Schema.decodeUnknownExit(Schema.fromJsonString(LeadCallFrame));

const badFrame = (message: string): LeadResultFrame => errorFrame("invalid", { code: "invalid", message: message.slice(0, 500) });

/** Reads one line, answers it with one line, and closes. */
const serveConnection = (conn: net.Socket, answer: (frame: LeadCallFrame) => Promise<LeadResultFrame>) => {
  let buffer = "";
  let done = false;
  const reply = (frame: LeadResultFrame) => {
    if (!conn.destroyed) conn.end(`${JSON.stringify(frame)}\n`);
  };
  const take = (line: string) => {
    if (done) return;
    done = true;
    const decoded = decodeCall(line);
    if (Exit.isFailure(decoded)) {
      reply(badFrame(`not a lead_call frame: ${String(Cause.squash(decoded.cause))}`));
      return;
    }
    // `answer` never rejects except when the node is shutting down; then the CLI just sees the socket close.
    answer(decoded.value).then(reply, () => conn.destroy());
  };
  conn.setEncoding("utf8");
  conn.on("data", (chunk: string) => {
    if (done) return;
    buffer += chunk;
    const newline = buffer.indexOf("\n");
    if (newline >= 0) take(buffer.slice(0, newline));
    else if (buffer.length > MAX_FRAME_BYTES) {
      done = true;
      reply(badFrame(`frame is larger than ${MAX_FRAME_BYTES} bytes`));
    }
  });
  conn.on("end", () => {
    if (buffer.trim().length > 0) take(buffer);
  });
  conn.on("error", () => conn.destroy());
};

const socketAnswers = (socketPath: string) =>
  new Promise<boolean>((resolve) => {
    const probe = net.connect(socketPath);
    probe.once("connect", () => {
      probe.destroy();
      resolve(true);
    });
    probe.once("error", () => resolve(false));
  });

/** Removes a socket left by a node that died; refuses to take over one another node is still serving. */
const clearStaleSocket = (socketPath: string) =>
  Effect.tryPromise({
    try: async () => {
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(socketPath);
      } catch {
        return;
      }
      if (!stat.isSocket()) throw new Error(`${socketPath} exists and is not a socket; move it away and start the node again`);
      if (await socketAnswers(socketPath)) throw new Error(`another fleetd node is already serving ${socketPath}; stop it first`);
      fs.unlinkSync(socketPath);
    },
    catch: (error) => new LeadSocketError({ message: error instanceof Error ? error.message : String(error) }),
  });

/**
 * Serves lead-side CLI calls on a unix socket (mode 0600, in the node's 0700 home) until the scope closes. Every
 * process of the node's OS user can call it; the hub decides which project a call belongs to from its cwd.
 */
export const serveLeadSocket = Effect.fn("serveLeadSocket")(function* (
  socketPath: string,
  call: (frame: LeadCallFrame) => Effect.Effect<LeadResultFrame>,
) {
  const run = yield* FiberSet.makeRuntimePromise();
  yield* Effect.try({
    try: () => fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 }),
    catch: () => new LeadSocketError({ message: `cannot create ${path.dirname(socketPath)}` }),
  });
  yield* clearStaleSocket(socketPath);
  const open = new Set<net.Socket>();
  // Half-open, so a CLI that ends its side after writing still gets the answer.
  const server = net.createServer({ allowHalfOpen: true }, (conn) => {
    open.add(conn);
    conn.once("close", () => open.delete(conn));
    serveConnection(conn, (frame) => run(call(frame)));
  });
  yield* Effect.acquireRelease(
    Effect.callback<void, LeadSocketError>((resume) => {
      server.once("error", (error) =>
        resume(Effect.fail(new LeadSocketError({ message: `cannot listen on ${socketPath}: ${error.message}` }))),
      );
      server.listen(socketPath, () => resume(Effect.void));
    }),
    () =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        // close() waits for open connections; their calls end with this scope, so drop them.
        for (const conn of open) conn.destroy();
      }).pipe(Effect.andThen(Effect.sync(() => fs.rmSync(socketPath, { force: true })))),
  );
  yield* Effect.try({
    try: () => fs.chmodSync(socketPath, 0o600),
    catch: () => new LeadSocketError({ message: `cannot restrict ${socketPath} to mode 0600` }),
  });
  yield* Effect.logInfo("lead socket listening").pipe(Effect.annotateLogs({ socketPath }));
});
