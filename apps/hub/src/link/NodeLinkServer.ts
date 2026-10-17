import { createPublicKey, randomBytes, verify } from "node:crypto";
import {
  type HubToNode,
  type LeadCallFrame,
  type LeadResultFrame,
  type MachineId,
  NodeLinkClose,
  type NodeT3Endpoint,
  NodeToHub,
  PROTOCOL_VERSION,
  ProtocolVersion,
  type Timestamp,
} from "@fleetd/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Socket from "effect/socket/Socket";
import * as Auth from "../auth/Auth.ts";
import * as EventLog from "../store/EventLog.ts";
import * as HubStore from "../store/HubStore.ts";
import { type LeadCallHandler, LeadCallRefused, leadBy, outsideEveryProject, projectForCwd } from "./LeadCalls.ts";

/** The part of W2's Executors the link drives. Typed structurally until Executors lands, then taken from context. */
export interface LinkExecutors {
  /** (Re)connects the machine's executor; a new bearer means reconnect with it. */
  readonly attach: (
    machineId: MachineId,
    session: { readonly t3Url: string; readonly bearer: string },
  ) => Effect.Effect<unknown, unknown>;
  readonly detach: (machineId: MachineId) => Effect.Effect<unknown, unknown>;
}

export interface NodeLinkOptions {
  readonly hubId: string;
  readonly executors: LinkExecutors;
  /** Answers lead-side `fleetd` calls the node forwards. Absent: every such call is refused as not available yet. */
  readonly leadCalls?: LeadCallHandler;
  readonly heartbeatEvery?: Duration.Input;
  readonly silenceTimeout?: Duration.Input;
  readonly helloTimeout?: Duration.Input;
}

export class NodeLinkServer extends Context.Service<
  NodeLinkServer,
  {
    /** Runs one node link until the socket ends. Never fails: refusals close the socket with a NodeLinkClose code. */
    readonly handle: (socket: Socket.Socket) => Effect.Effect<void>;
  }
>()("fleetd/hub/link/NodeLinkServer") {}

class LinkRefused extends Data.TaggedError("LinkRefused")<{ readonly code: number; readonly reason: string }> {}

/** Raw 32-byte ed25519 public key (base64) verifying `sig` (base64) over the nonce's UTF-8 bytes. */
const verifyNonceSignature = (pubKey: string, nonce: string, sig: string): boolean => {
  try {
    const raw = Buffer.from(pubKey, "base64");
    if (raw.length !== 32) return false;
    const key = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") }, format: "jwk" });
    return verify(null, Buffer.from(nonce, "utf8"), key, Buffer.from(sig, "base64"));
  } catch {
    return false;
  }
};

const decodeFrame = Schema.decodeUnknownExit(Schema.fromJsonString(NodeToHub));
const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString());
const refuse = (code: number, reason: string) => Effect.fail(new LinkRefused({ code, reason }));

/** WebSocket close reasons are capped at 123 bytes. */
const closeReason = (reason: string) => (Buffer.byteLength(reason) <= 123 ? reason : `${reason.slice(0, 119)}...`);

const errorTag = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : "unknown";

/** Logs a failed executor call by its tag only: its error may carry the bearer. */
const bestEffort = (what: string, machineId: MachineId) => (effect: Effect.Effect<unknown, unknown>) =>
  effect.pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      Effect.logWarning(`node link: ${what} failed`).pipe(Effect.annotateLogs({ machineId, error: errorTag(error) })),
    ),
  );

/** Frame-at-a-time reads and JSON writes over one socket. */
const openLink = (socket: Socket.Socket) =>
  Effect.gen(function* () {
    const pull = yield* Socket.readerString(socket);
    const writer = yield* socket.writer;
    let buffered: Array<string> = [];
    const next: Effect.Effect<string, Socket.SocketError> = Effect.suspend(() => {
      const head = buffered.shift();
      if (head !== undefined) return Effect.succeed(head);
      return Effect.map(pull, ([first, ...rest]) => {
        buffered = rest;
        return first;
      });
    });
    const send = (frame: HubToNode) => writer.write(JSON.stringify(frame)).pipe(Effect.ignore);
    const close = (code: number, reason: string) =>
      writer.write(new Socket.CloseEvent(code, closeReason(reason))).pipe(Effect.ignore);
    return { next, send, close };
  });

type Link = Effect.Success<ReturnType<typeof openLink>>;

export const make = Effect.fn("NodeLinkServer.make")(function* (options: NodeLinkOptions) {
  const store = yield* HubStore.HubStore;
  const eventLog = yield* EventLog.EventLog;
  const auth = yield* Auth.Auth;
  const { executors } = options;
  const heartbeatEvery = Duration.fromInputUnsafe(options.heartbeatEvery ?? "15 seconds");
  const silenceTimeout = Duration.fromInputUnsafe(options.silenceTimeout ?? "45 seconds");
  const helloTimeout = Duration.fromInputUnsafe(options.helloTimeout ?? "10 seconds");

  /** The live link per machine; a newer link replaces an older one. */
  const links = new Map<MachineId, { readonly id: number; readonly close: Link["close"] }>();
  /** What this hub process last announced per machine, until it announces the machine offline. */
  const announced = new Map<MachineId, "online" | "degraded">();
  const watchdogs = yield* FiberMap.make<MachineId>();
  let nextLinkId = 0;

  /** Attributes a forwarded call to the project its cwd is in, on the machine whose node sent it, and answers it. */
  const answerLeadCall = (machineId: MachineId, frame: LeadCallFrame): Effect.Effect<LeadResultFrame> =>
    Effect.gen(function* () {
      const projects = yield* store.projects.list({ machineId });
      const project = projectForCwd(projects, frame.cwd);
      if (project === undefined) return yield* outsideEveryProject(machineId, frame.cwd, projects);
      if (options.leadCalls === undefined) {
        return yield* new LeadCallRefused({
          code: "forbidden",
          message: "this hub does not take lead-side calls yet",
          fix: "carry on without this call and mention it in your next status line",
        });
      }
      const projectRef = { machineId, projectId: project.projectId };
      return yield* options.leadCalls.handle({ projectRef, by: leadBy(projectRef), cwd: frame.cwd }, frame.call);
    }).pipe(
      Effect.map((result): LeadResultFrame => ({ t: "lead_result", id: frame.id, result })),
      Effect.catchTag("LeadCallRefused", ({ code, message, fix }) =>
        Effect.succeed<LeadResultFrame>({
          t: "lead_result",
          id: frame.id,
          error: { code, message, ...(fix === undefined ? {} : { fix }) },
        }),
      ),
      Effect.catchCause((cause) =>
        Effect.logError("node link: lead call failed").pipe(
          Effect.annotateLogs({ machineId, op: frame.call.op, cause: Cause.pretty(cause) }),
          Effect.as<LeadResultFrame>({
            t: "lead_result",
            id: frame.id,
            error: { code: "t3_error", message: "the hub failed while handling this call", fix: "try again shortly" },
          }),
        ),
      ),
    );

  /** Rewrites the stored machine's status (and T3 info, when given); `degradedReason` is kept only while degraded. */
  const writeStatus = (
    machineId: MachineId,
    at: Timestamp,
    status: "online" | "offline" | "degraded",
    extra: { readonly degradedReason?: string; readonly t3?: NodeT3Endpoint } = {},
  ) =>
    Effect.gen(function* () {
      const stored = yield* store.machines.get(machineId);
      if (stored === undefined) return;
      const { degradedReason: previousReason, ...machine } = stored;
      yield* store.machines.upsert({
        ...machine,
        status,
        lastSeenAt: at,
        ...(extra.t3 === undefined ? {} : { t3: { version: extra.t3.version, protocol: extra.t3.protocol } }),
        ...(status === "degraded" ? { degradedReason: extra.degradedReason ?? previousReason ?? "T3 is down" } : {}),
      });
    });

  /** Emits machine.online or machine.degraded when the machine's announced status changes. */
  const announce = (machineId: MachineId, at: Timestamp, status: "online" | "degraded", degradedReason?: string) =>
    Effect.gen(function* () {
      if (announced.get(machineId) === status) return;
      announced.set(machineId, status);
      yield* status === "online"
        ? eventLog.append({ at, type: "machine.online", machineId, summary: `${machineId} is online` })
        : eventLog.append({
            at,
            type: "machine.degraded",
            machineId,
            summary: `${machineId} is degraded: ${degradedReason}`,
            data: { degradedReason },
          });
    });

  const markOffline = (machineId: MachineId) =>
    Effect.gen(function* () {
      announced.delete(machineId);
      const at = yield* nowIso;
      const seconds = Duration.toSeconds(silenceTimeout);
      yield* writeStatus(machineId, at, "offline");
      yield* eventLog.append({
        at,
        type: "machine.offline",
        machineId,
        summary: `${machineId} went offline: no word from its node for ${seconds} s`,
      });
      yield* executors.detach(machineId).pipe(bestEffort("detach executor", machineId));
      const live = links.get(machineId);
      if (live !== undefined) {
        links.delete(machineId);
        yield* live.close(NodeLinkClose.heartbeatTimeout, `no frame for ${seconds} s`);
      }
      yield* Effect.logInfo("node link: machine offline").pipe(Effect.annotateLogs({ machineId }));
    });

  /** Any frame restarts the machine's silence timer. It outlives the socket, so a quick reconnect never flaps. */
  const touch = (machineId: MachineId) =>
    FiberMap.run(watchdogs, machineId, Effect.sleep(silenceTimeout).pipe(Effect.andThen(markOffline(machineId))));

  // After a hub restart the store still says online for machines whose nodes may never come back, and only a
  // link arms the silence timer; arm it now so they go offline unless their node links again.
  for (const machine of yield* store.machines.list()) {
    if (machine.status !== "offline") yield* touch(machine.machineId);
  }

  const handshake = (link: Link) =>
    Effect.gen(function* () {
      const nonce = randomBytes(32).toString("base64url");
      yield* link.send({ t: "challenge", nonce });
      const first = yield* link.next.pipe(Effect.timeoutOption(helloTimeout));
      if (Option.isNone(first)) {
        return yield* refuse(NodeLinkClose.badFrame, `no hello within ${Duration.toSeconds(helloTimeout)} s`);
      }
      const decoded = decodeFrame(first.value);
      if (Exit.isFailure(decoded) || decoded.value.t !== "hello") {
        return yield* refuse(NodeLinkClose.badFrame, "expected a hello frame");
      }
      const hello = decoded.value;
      if (hello.protocol !== PROTOCOL_VERSION) {
        return yield* refuse(
          NodeLinkClose.protocolMismatch,
          `hub speaks protocol ${PROTOCOL_VERSION}, node speaks ${hello.protocol}: install matching fleetd versions`,
        );
      }
      const { machineId } = hello;
      // Checked before the token, so a bad signature cannot burn someone's enroll token.
      if (!verifyNonceSignature(hello.pubKey, nonce, hello.sig)) {
        return yield* refuse(NodeLinkClose.unauthorized, "signature does not verify against the hello's key");
      }
      if (hello.enrollToken !== undefined) {
        yield* auth.consumeEnrollToken(hello.enrollToken, machineId, hello.pubKey).pipe(
          Effect.catchTags({
            Unauthorized: (error) =>
              refuse(NodeLinkClose.unauthorized, `${error.message}: run fleetd hub token create --machine ${machineId}`),
          }),
        );
        return hello;
      }
      const enrolled = yield* auth.nodePubKey(machineId);
      if (enrolled === undefined) {
        return yield* refuse(
          NodeLinkClose.unauthorized,
          `${machineId} is not enrolled: run fleetd hub token create --machine ${machineId}, then fleetd node join`,
        );
      }
      if (enrolled !== hello.pubKey) {
        return yield* refuse(NodeLinkClose.unauthorized, `key does not match the key enrolled for ${machineId}`);
      }
      return hello;
    });

  const serve = (link: Link) =>
    Effect.gen(function* () {
      const hello = yield* handshake(link);
      const { machineId } = hello;

      const id = ++nextLinkId;
      const previous = links.get(machineId);
      links.set(machineId, { id, close: link.close });
      if (previous !== undefined) yield* previous.close(NodeLinkClose.replaced, "a newer link for this machine took over");
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (links.get(machineId)?.id === id) links.delete(machineId);
        }),
      );

      /** The T3 to attach while the node reports it up; undefined while it is down. */
      let t3: NodeT3Endpoint | undefined = hello.t3;
      let bearer: string | undefined;
      const attach = Effect.suspend(() =>
        t3 === undefined || bearer === undefined
          ? Effect.void
          : executors.attach(machineId, { t3Url: t3.url, bearer }).pipe(bestEffort("attach executor", machineId)),
      );

      const at = yield* nowIso;
      const stored = yield* store.machines.get(machineId);
      const helloReason = "its node cannot reach T3";
      yield* store.machines.upsert({
        machineId,
        name: hello.name,
        tags: hello.tags,
        status: t3 === undefined ? "degraded" : "online",
        lastSeenAt: at,
        // A machine whose T3 is down keeps the version it last reported.
        t3: t3 === undefined ? (stored?.t3 ?? null) : { version: t3.version, protocol: t3.protocol },
        nodeVersion: hello.nodeVersion,
        ...(t3 === undefined ? { degradedReason: helloReason } : {}),
      });
      yield* t3 === undefined ? announce(machineId, at, "degraded", helloReason) : announce(machineId, at, "online");
      yield* touch(machineId);
      yield* link.send({ t: "welcome", hubId: options.hubId, protocol: ProtocolVersion.make(PROTOCOL_VERSION) });
      yield* Effect.logInfo("node link: welcomed").pipe(Effect.annotateLogs({ machineId, linkId: id }));

      yield* Effect.sleep(heartbeatEvery).pipe(
        Effect.andThen(Effect.flatMap(nowIso, (at) => link.send({ t: "hb", at }))),
        Effect.forever,
        Effect.forkScoped,
      );

      while (true) {
        const decoded = decodeFrame(yield* link.next);
        if (Exit.isFailure(decoded)) return yield* refuse(NodeLinkClose.badFrame, "frame does not decode");
        // A replaced or timed-out link must not keep the machine alive.
        if (links.get(machineId)?.id !== id) return;
        yield* touch(machineId);
        const frame = decoded.value;
        switch (frame.t) {
          case "hb":
            yield* Effect.flatMap(nowIso, (at) => store.machines.setStatus(machineId, announced.get(machineId) ?? "online", at));
            break;
          case "t3session":
            bearer = frame.bearer;
            // Kept for when T3 is back if it is down now.
            if (t3 === undefined) break;
            yield* attach;
            yield* Effect.logInfo("node link: t3 session attached").pipe(
              Effect.annotateLogs({ machineId, expiresAt: frame.expiresAt }),
            );
            break;
          case "t3state": {
            const at = yield* nowIso;
            if (frame.state === "up") {
              t3 = frame.t3 ?? hello.t3;
              yield* writeStatus(machineId, at, "online", t3 === undefined ? {} : { t3 });
              yield* announce(machineId, at, "online");
              // The node re-mints right after this, and that session reattaches; the last one may still work.
              yield* attach;
            } else {
              t3 = undefined;
              const reason = frame.reason ?? (frame.state === "restarting" ? "T3 is restarting" : "T3 is down");
              yield* writeStatus(machineId, at, "degraded", { degradedReason: reason });
              yield* announce(machineId, at, "degraded", reason);
              yield* executors.detach(machineId).pipe(bestEffort("detach executor", machineId));
            }
            yield* Effect.logInfo(`node link: t3 ${frame.state}`).pipe(Effect.annotateLogs({ machineId }));
            break;
          }
          case "lead_call":
            // Off the frame loop: a slow call must not hold up heartbeats or other calls.
            yield* answerLeadCall(machineId, frame).pipe(Effect.flatMap(link.send), Effect.forkScoped);
            break;
          case "hello":
            return yield* refuse(NodeLinkClose.badFrame, "hello after welcome");
        }
      }
    });

  const handle = (socket: Socket.Socket) =>
    Effect.gen(function* () {
      const link = yield* openLink(socket);
      yield* serve(link).pipe(
        Effect.catchTags({
          LinkRefused: (refused) =>
            Effect.logInfo("node link: refused").pipe(
              Effect.annotateLogs({ code: refused.code, reason: refused.reason }),
              Effect.andThen(link.close(refused.code, refused.reason)),
            ),
          SocketError: (error) =>
            Effect.logDebug("node link: socket ended").pipe(Effect.annotateLogs({ reason: error.reason._tag })),
        }),
      );
    }).pipe(
      Effect.catchTags({ SocketError: () => Effect.void }),
      Effect.scoped,
    );

  return NodeLinkServer.of({ handle });
});
