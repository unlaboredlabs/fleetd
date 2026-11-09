// The hub link (crates/fleetd/src/node/link.rs): challenge, signed hello, welcome, then heartbeats and the hub's
// requests until the socket ends or the hub goes silent. Reconnects with backoff (250 ms doubling to 30 s, ±20%
// jitter, reset by each welcome), and only gives up when the hub refuses the node. A quiet link is pinged before it is
// given up on (QUIET_PROBE, QUIET_DEAD). With a hub that lists `link_deflate`, frames go compressed (./deflate.ts).
//
// Unlike the Rust node, silence is timed from the last whole message or pong, not the last byte read: Bun's client
// WebSocket doesn't surface partial frames. A large frame still arriving over a slow link counts as silence after
// QUIET_DEAD (30 s), where the Rust node waits for it.
import { HUB_TO_NODE } from "../../shared/wire_tags.ts";
import { PROTOCOL_VERSION } from "../../shared/contracts.ts";
import type { NodeIdentity } from "../identity.ts";
import {
  CAP,
  CLOSE,
  HEARTBEAT_INTERVAL_SECS,
  HEARTBEAT_TIMEOUT_SECS,
  HUB_CAP,
  protocolBehind,
  type HubFrame,
  type NodeFrame,
} from "../wire.ts";
import { Deflater, Inflater, MIN_DEFLATE_BYTES } from "./deflate.ts";
import { BadFrames, knownBy, readHubFrame, refusal } from "./frames.ts";

const HEARTBEAT_EVERY_MS = HEARTBEAT_INTERVAL_SECS * 1000;
const SILENCE_TIMEOUT_MS = HEARTBEAT_TIMEOUT_SECS * 1000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** The dial and the upgrade: a hub that takes the connection but never answers it is as gone as a silent one. */
export const CONNECT_TIMEOUT_MS = SILENCE_TIMEOUT_MS;
/** Nothing heard for this long, a hub heartbeat 5 s late: the node pings, and any hub answers with a pong. */
export const QUIET_PROBE_MS = (HEARTBEAT_INTERVAL_SECS + 5) * 1000;
/** Nothing heard for this long, the ping unanswered for 10 s: the link is gone. */
export const QUIET_DEAD_MS = (HEARTBEAT_INTERVAL_SECS + 15) * 1000;
/** The largest frame the node takes from its hub: an attachment's put_file with room to spare. */
export const LINK_MAX_FRAME_BYTES = 64 << 20;
/** The largest frame of any other kind. */
export const LINK_MAX_OTHER_FRAME_BYTES = 16 << 20;

/** The hub refused this node in a way retrying cannot fix (bad key or token, protocol mismatch). */
export class LinkFatal extends Error {
  constructor(readonly reason: string) {
    super(`hub refused this node: ${reason}`);
  }
}

type LinkEnd =
  | { kind: "lost"; why: string }
  /** The hub closed the link as a restart (`CLOSE.RESTART`): it is back within a moment. */
  | { kind: "restarting"; why: string }
  | { kind: "fatal"; fatal: LinkFatal }
  | { kind: "woke" }
  | { kind: "relink"; why: string };

/** `<hub>/node/link` as a ws(s) URL. */
export function linkUrl(hub: string): string {
  let url: URL;
  try {
    url = new URL(hub);
  } catch (error) {
    throw new Error(`hub URL '${hub}' does not parse: ${(error as Error).message}`);
  }
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = "/node/link";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** The wait before reconnect `attempt` (0 first), `jitter` in 0.8..1.2. */
export function reconnectDelay(attempt: number, jitter: number): number {
  return Math.round(Math.min(30_000, 250 * 2 ** Math.min(attempt, 16)) * jitter);
}

/** How long the node redials every `RESTART_REDIAL_MS` after the hub closed its link as a restart. */
const RESTART_WINDOW_MS = 60_000;
/** The wait between redials while the hub restarts: it is down for a moment, so a backoff would only relink late. */
export const RESTART_REDIAL_MS = 250;

/**
 * When the node redials: right behind a hub that said it restarts (`CLOSE.RESTART`), for `RESTART_WINDOW_MS`;
 * otherwise, and once that window is over, with the backoff of `reconnectDelay`.
 */
export class Redial {
  private attempt = 0;
  restartUntil: number | undefined;

  /** The wait before the next try, after one that ended at `now` (`restarting`: with the hub's restart close). */
  next(restarting: boolean, now: number, jitter: number): number {
    if (restarting) this.restartUntil = now + RESTART_WINDOW_MS;
    if (this.restartUntil !== undefined && now < this.restartUntil) return RESTART_REDIAL_MS;
    this.restartUntil = undefined;
    return reconnectDelay(this.attempt++, jitter);
  }

  /** A welcome: the next loss starts over. */
  linked(): void {
    this.attempt = 0;
    this.restartUntil = undefined;
  }
}

/** Whether the node compresses: only when its own hello listed `link_deflate` and the welcome says the hub inflates. */
export const compresses = (hello: string[], welcome: string[]) =>
  hello.includes(CAP.LINK_DEFLATE) && welcome.includes(HUB_CAP.LINK_DEFLATE);

/** Only a file transfer may use the room the socket has for one. */
export function sizeAllowed(frame: HubFrame, len: number): boolean {
  return len <= LINK_MAX_OTHER_FRAME_BYTES || (frame.t === "session_call" && (frame.call as { op?: string } | undefined)?.op === "put_file");
}

/** What one welcomed link gives the node's modules. */
export type LinkContext = {
  hubId: string;
  hubCaps: string[];
  /** Queues a frame; frames go out in order. */
  send: (frame: NodeFrame) => void;
  /** Resolves once every frame queued before it is written: what an update's answer waits on before its restart. */
  flush: () => Promise<void>;
  /** Aborted when this link ends: work the link started ends with it. */
  signal: AbortSignal;
  /** Ends this link and dials again at once, for a new hello (its capabilities changed). */
  relink: (why: string) => void;
};

export type LinkSettings = { hub: string; machineId: string; name: string; nodeVersion: string };

export type RunNodeOptions = {
  settings: LinkSettings;
  identity: NodeIdentity;
  /** The X25519 key the app seals this machine's secrets to, base64; absent: the node takes no secrets. */
  boxPubKey?: string;
  machineFingerprint?: string;
  /** Sent on links until the hub first welcomes this node, then forgotten. */
  enrollToken?: string;
  /** Runs after the first welcome of a link that carried the enroll token. */
  onEnrolled?: () => void;
  /** What the hello lists, at each link. */
  capabilities: () => string[];
  /** The heartbeat's fields beyond `at`, every 15 s. */
  heartbeat: () => Promise<Record<string, unknown>>;
  /** A welcomed link: the modules attach (sleeps to report, streams to restart); the returned function detaches. */
  attach: (link: LinkContext) => () => void;
  /** Every hub frame after the welcome. */
  handle: (frame: HubFrame, link: LinkContext) => void;
  /** Resolves when the machine woke from sleep: the link ends at once, and the next one reports the sleep. */
  woke?: (signal: AbortSignal) => Promise<void>;
  log?: (level: "info" | "warn" | "debug", message: string, fields?: Record<string, unknown>) => void;
  /** Bounds, for tests. */
  quiet?: { probeMs: number; deadMs: number };
  heartbeatMs?: number;
  /** Ends the loop (the node's shutdown): run resolves with undefined. */
  signal?: AbortSignal;
};

const defaultLog: NonNullable<RunNodeOptions["log"]> = (level, message, fields) => {
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${fields ? ` ${JSON.stringify(fields)}` : ""}`;
  if (level !== "debug" || process.env.FLEETD_LOG === "debug") console.log(line);
};

/** The node's main loop: keep a link to the hub, reconnecting with backoff. Ends only with the hub's refusal (or
 * `signal`). */
export async function runNode(options: RunNodeOptions): Promise<LinkFatal | undefined> {
  const log = options.log ?? defaultLog;
  let enrollToken = options.enrollToken;
  let onEnrolled = options.onEnrolled;
  const redial = new Redial();
  let downSince: number | undefined;
  let linkedOnce = false;
  while (!options.signal?.aborted) {
    const end = await runLinkOnce(options, enrollToken, (hubId) => {
      redial.linked();
      const since = downSince;
      downSince = undefined;
      if (!linkedOnce) log("info", "linked to hub", { hubId, machineId: options.settings.machineId });
      else if (since !== undefined)
        log("info", "hub link back", { hubId, machineId: options.settings.machineId, downS: Math.floor((Date.now() - since) / 1000) });
      else log("info", "linked to hub again", { hubId, machineId: options.settings.machineId });
      linkedOnce = true;
      if (enrollToken !== undefined) {
        enrollToken = undefined;
        const enrolled = onEnrolled;
        onEnrolled = undefined;
        enrolled?.();
      }
    });
    if (end.kind === "fatal") return end.fatal;
    if (end.kind === "woke") {
      log("info", "the machine woke; linking to the hub again");
      continue;
    }
    if (end.kind === "relink") {
      log("info", "linking to the hub again", { why: end.why });
      continue;
    }
    if (options.signal?.aborted) break;
    const delay = redial.next(end.kind === "restarting", Date.now(), 0.8 + Math.random() * 0.4);
    if (downSince === undefined) {
      downSince = Date.now();
      log("warn", "hub link lost; reconnecting until it is back", { why: end.why, retryInMs: delay });
    } else log("debug", "hub link still down", { why: end.why, retryInMs: delay });
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay);
      options.signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
    });
  }
  return undefined;
}

/** One link, from the dial to its end. */
function runLinkOnce(options: RunNodeOptions, enrollToken: string | undefined, onWelcome: (hubId: string) => void): Promise<LinkEnd> {
  const quiet = options.quiet ?? { probeMs: QUIET_PROBE_MS, deadMs: QUIET_DEAD_MS };
  return new Promise<LinkEnd>((resolve) => {
    let url: string;
    try {
      url = linkUrl(options.settings.hub);
    } catch (error) {
      return resolve({ kind: "lost", why: (error as Error).message });
    }
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const linkAbort = new AbortController();
    const inflater = new Inflater(LINK_MAX_FRAME_BYTES);
    const deflater = new Deflater();
    let deflate = false;
    let stage: "connect" | "challenge" | "welcome" | "live" = "connect";
    let ended = false;
    let detach: (() => void) | undefined;
    let heard = Date.now();
    let pinged: number | undefined;
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let writes: Promise<void> = Promise.resolve();
    // Frames in arrival order, each decoded (inflated) before the next is handled.
    let reads: Promise<void> = Promise.resolve();
    const badFrames = new BadFrames();

    const finish = (end: LinkEnd) => {
      if (ended) return;
      ended = true;
      for (const t of timers) clearTimeout(t);
      timers.clear();
      linkAbort.abort();
      detach?.();
      inflater.close();
      deflater.close();
      try {
        ws.close();
      } catch {}
      resolve(end);
    };
    const after = (ms: number, fn: () => void) => {
      const t = setTimeout(() => {
        timers.delete(t);
        fn();
      }, ms);
      timers.add(t);
      return t;
    };

    const send = (frame: NodeFrame) => {
      if (ended) return;
      const text = JSON.stringify(frame);
      writes = writes.then(async () => {
        if (ended) return;
        if (deflate && text.length >= MIN_DEFLATE_BYTES) {
          const data = await deflater.deflate(text);
          if (!ended) ws.send(data);
        } else ws.send(text);
      });
      writes = writes.catch((error) => finish({ kind: "lost", why: `writing to the hub: ${(error as Error).message}` }));
    };
    const ctx = (hubId: string, hubCaps: string[]): LinkContext => ({
      hubId,
      hubCaps,
      send,
      flush: () => writes,
      signal: linkAbort.signal,
      relink: (why) => void writes.then(() => finish({ kind: "relink", why })),
    });

    const connectTimer = after(CONNECT_TIMEOUT_MS, () =>
      finish({ kind: "lost", why: `the hub did not answer the link within ${CONNECT_TIMEOUT_MS / 1000} s` }),
    );
    let handshake: ReturnType<typeof setTimeout> | undefined;
    const waitFor = (what: "challenge" | "welcome") => {
      stage = what;
      if (handshake) clearTimeout(handshake);
      handshake = after(HANDSHAKE_TIMEOUT_MS, () =>
        finish({ kind: "lost", why: `no ${what} from the hub for ${HANDSHAKE_TIMEOUT_MS / 1000} s` }),
      );
    };
    let hello: string[] = [];
    let live: LinkContext | undefined;

    const watchQuiet = () => {
      if (ended) return;
      const now = Date.now();
      if (now >= heard + quiet.deadMs)
        return finish({ kind: "lost", why: `nothing from the hub for ${Math.round(quiet.deadMs / 1000)} s, and no answer to a ping` });
      if (now >= heard + quiet.probeMs && pinged !== heard) {
        pinged = heard;
        try {
          ws.ping();
        } catch {}
      }
      const wake = pinged === heard ? heard + quiet.deadMs : heard + quiet.probeMs;
      after(Math.max(10, wake - now), watchQuiet);
    };

    const onFrame = (frame: HubFrame) => {
      switch (stage) {
        case "challenge": {
          if (frame.t !== "challenge") return finish({ kind: "lost", why: `expected a challenge, got ${frame.t}` });
          const nonce = String(frame.nonce ?? "");
          hello = options.capabilities();
          const helloFrame: NodeFrame = {
            t: "hello",
            machineId: options.settings.machineId,
            name: options.settings.name,
            // Tags are gone; an older hub still reads the list.
            tags: [],
            nodeVersion: options.settings.nodeVersion,
            protocol: PROTOCOL_VERSION,
            pubKey: options.identity.pubKey(),
            sig: options.identity.sign(nonce),
            ...(enrollToken ? { enrollToken } : {}),
            ...(options.boxPubKey ? { boxPubKey: options.boxPubKey } : {}),
            ...(hello.length ? { capabilities: hello } : {}),
            ...(options.machineFingerprint ? { machineFingerprint: options.machineFingerprint } : {}),
          };
          send(helloFrame);
          return waitFor("welcome");
        }
        case "welcome": {
          if (frame.t !== "welcome") return finish({ kind: "lost", why: `expected a welcome, got ${frame.t}` });
          if (frame.protocol !== PROTOCOL_VERSION)
            return finish({ kind: "fatal", fatal: new LinkFatal(protocolBehind(Number(frame.protocol), PROTOCOL_VERSION)) });
          if (handshake) clearTimeout(handshake);
          const caps = Array.isArray(frame.capabilities) ? (frame.capabilities as string[]) : [];
          deflate = compresses(hello, caps);
          const hubId = String(frame.hubId ?? "");
          stage = "live";
          live = ctx(hubId, caps);
          onWelcome(hubId);
          detach = options.attach(live);
          heartbeat();
          watchQuiet();
          options.woke?.(linkAbort.signal).then(() => finish({ kind: "woke" }));
          return;
        }
        case "live":
          if (frame.t === "challenge" || frame.t === "welcome" || frame.t === "hb") return;
          try {
            options.handle(frame, live!);
          } catch (error) {
            // A request its handler can't take (a field it can't read) is answered as one that doesn't decode, so the
            // hub's wait for it ends now.
            (options.log ?? defaultLog)("warn", "a hub frame's handler threw", { t: frame.t, error: String(error) });
            const answer = refusal(knownBy(frame, String(error)));
            if (answer) send(answer);
          }
          return;
        case "connect":
          return;
      }
    };

    const heartbeat = () => {
      after(options.heartbeatMs ?? HEARTBEAT_EVERY_MS, async () => {
        if (ended) return;
        let fields: Record<string, unknown> = {};
        try {
          fields = await options.heartbeat();
        } catch {}
        send({ t: "hb", at: new Date().toISOString(), ...fields } as NodeFrame);
        heartbeat();
      });
    };

    ws.addEventListener("open", () => {
      clearTimeout(connectTimer);
      timers.delete(connectTimer);
      heard = Date.now();
      waitFor("challenge");
    });
    ws.addEventListener("pong", () => {
      heard = Date.now();
    });
    ws.addEventListener("message", (event) => {
      heard = Date.now();
      const data = event.data as string | ArrayBuffer;
      reads = reads.then(async () => {
        if (ended) return;
        let raw: string;
        if (typeof data === "string") raw = data;
        else {
          try {
            raw = await inflater.inflate(new Uint8Array(data));
          } catch (error) {
            return finish({ kind: "lost", why: (error as Error).message });
          }
        }
        const read = readHubFrame(raw, HUB_TO_NODE);
        if ("bad" in read) {
          const { bad } = read;
          // The handshake has no room for a frame it can't read.
          if (stage !== "live") return finish({ kind: "lost", why: `hub sent a ${bad.tag} frame that does not decode: ${bad.error}` });
          const log = options.log ?? defaultLog;
          // Refused alone on a live link: the frames around it still read. Only a flood of them ends the link.
          if (!badFrames.take(Date.now())) {
            log("warn", "too many hub frames that do not decode; dropping the link", { tag: bad.tag, bytes: raw.length, error: bad.error });
            return finish({ kind: "lost", why: "the hub sent too many frames that do not decode" });
          }
          log("warn", "a hub frame does not decode; refused it alone", { tag: bad.tag, bytes: raw.length, error: bad.error });
          const answer = refusal(bad);
          if (answer) send(answer);
          return;
        }
        const { frame } = read;
        if (!sizeAllowed(frame, raw.length)) {
          (options.log ?? defaultLog)("warn", "hub frame over the cap for anything but a file transfer; ignored", {
            kind: frame.t,
            bytes: raw.length,
          });
          return;
        }
        onFrame(frame);
      });
    });
    ws.addEventListener("close", (event) => {
      const { code, reason } = event as CloseEvent;
      if (stage === "connect") return finish({ kind: "lost", why: `cannot reach the hub: closed with ${code}` });
      // After the frames that came before it.
      reads = reads.then(() => {
        if (code === CLOSE.UNAUTHORIZED || code === CLOSE.PROTOCOL_MISMATCH)
          return finish({ kind: "fatal", fatal: new LinkFatal(reason || `closed with ${code}`) });
        const why = `hub closed the link (${code} ${reason})`.trim();
        finish(code === CLOSE.RESTART ? { kind: "restarting", why } : { kind: "lost", why });
      });
    });
    ws.addEventListener("error", () => {
      if (stage === "connect") finish({ kind: "lost", why: "cannot reach the hub: connection refused or failed" });
    });
  });
}
