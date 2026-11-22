// The hub link: challenge, signed hello, welcome, then heartbeats and the hub's
// requests until the socket ends or the hub goes silent. Reconnects with backoff (250 ms doubling to 5 s, ±20%
// jitter, reset by each welcome), and only gives up when the hub refuses the node. A quiet link is pinged before it is
// given up on (QUIET_PROBE, QUIET_DEAD): a link cut under it (a network switch, wifi that drops) is found dead within
// seconds, not at the next heartbeats. With a hub that lists `link_deflate`, frames go compressed (./deflate.ts).
//
// Unlike the Rust node, silence is timed from the last whole message or pong, not the last byte read: Bun's client
// WebSocket doesn't surface partial frames. So while a big frame may still be crossing a slow link (one the node sent,
// until the ping behind it is answered; one the hub said is coming, until it arrives), the bound is BULK_DEAD (30 s),
// heartbeats from the other side keeping it alive. A hub that doesn't list `link_bulk` (an older hub or cloud) never
// says a frame is coming, so its link always has BULK_DEAD. A large frame that takes longer than that to arrive still counts
// as silence, where the Rust node waits for it. A watched screen's frames go one at a time, each once the one before
// it has crossed, so a screen faster than the machine's uplink never queues up ahead of its agents' output.
import { HUB_TO_NODE } from "../../shared/wire_tags.ts";
import { PROTOCOL_VERSION } from "../../shared/contracts.ts";
import { systemClock, type Clock } from "../../shared/clock.ts";
import { isUpgradeProofMessage, makeUpgradeProof } from "../../shared/upgrade_proof.ts";
import type { NodeIdentity } from "../identity.ts";
import {
  CAP,
  CLOSE,
  HEARTBEAT_INTERVAL_SECS,
  HEARTBEAT_TIMEOUT_SECS,
  HUB_CAP,
  NOT_ENROLLED,
  protocolBehind,
  REMOVED,
  type HubFrame,
  type NodeFrame,
} from "../wire.ts";
import { LINK_BULK_BYTES } from "../../shared/node_link.ts";
import { Deflater, Inflater, MIN_DEFLATE_BYTES } from "./deflate.ts";
import { BadFrames, knownBy, readHubFrame, refusal } from "./frames.ts";

const HEARTBEAT_EVERY_MS = HEARTBEAT_INTERVAL_SECS * 1000;
const SILENCE_TIMEOUT_MS = HEARTBEAT_TIMEOUT_SECS * 1000;
const HANDSHAKE_TIMEOUT_MS = 10_000;
/** The dial and the upgrade: a hub that takes the connection but never answers it is as gone as a silent one. */
export const CONNECT_TIMEOUT_MS = SILENCE_TIMEOUT_MS;
/** Nothing heard for this long: the node pings, and any hub answers with a pong. */
export const QUIET_PROBE_MS = 5_000;
/** Nothing heard for this long, the ping unanswered for 7 s (a satellite link answers in under one): the link is gone. */
export const QUIET_DEAD_MS = 12_000;
/** The bound instead while a big frame may still be crossing the link: pongs queue behind it, and only the hub's
 * heartbeats (every 15 s) come through meanwhile. */
export const BULK_DEAD_MS = (HEARTBEAT_INTERVAL_SECS + 15) * 1000;
/** A frame this big (as it goes on the wire) may take seconds on a slow link. */
export const BULK_BYTES = LINK_BULK_BYTES;
/** A watched screen's frames on the link at once: the next, the newest made meanwhile, goes once this one has crossed.
 * Two would show a 3G or satellite screen at 1.4-1.7 fps instead of 0.9, and keep the rest waiting twice as long. */
export const SCREEN_IN_FLIGHT = 1;
/** A screen's H.264 frames that wait for the link, in order, before its stream drops until a keyframe: a third of a
 * second at 10 fps, so a short stall is ridden out and a slow link isn't queued ahead of the rest. */
export const H264_WAITING = 3;

/** A screen's frame as the link has it: its text, whether it is H.264, and a keyframe. */
type Waiting = { text: string; h264: boolean; key: boolean };
/** The largest frame the node takes from its hub: an attachment's put_file with room to spare. */
export const LINK_MAX_FRAME_BYTES = 64 << 20;
/** The largest frame of any other kind. */
export const LINK_MAX_OTHER_FRAME_BYTES = 16 << 20;

/** The hub refused this node in a way retrying cannot fix (bad key or token, protocol mismatch). `removed`: the hub
 * removed this machine, so the node is no longer enrolled with it. `unknown`: the hub holds no key for it at all. */
export class LinkFatal extends Error {
  constructor(
    readonly reason: string,
    readonly removed = false,
    readonly unknown = false,
  ) {
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

/** The longest wait between redials: a network back after a long outage is relinked within it. A dial to a hub that
 * is down costs a refused connection, about 300 bytes. */
export const RECONNECT_MAX_MS = 5_000;

/** The wait before reconnect `attempt` (0 first), `jitter` in 0.8..1.2. */
export function reconnectDelay(attempt: number, jitter: number): number {
  return Math.round(Math.min(RECONNECT_MAX_MS, 250 * 2 ** Math.min(attempt, 16)) * jitter);
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
  /** Runs after the first welcome of a link that carried the enroll token, with the id the hub enrolled it as. */
  onEnrolled?: (machineId: string) => void;
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
  /** The upgrade proof's time; tests pass their own. */
  clock?: Clock;
  /** Bounds, for tests. */
  quiet?: { probeMs: number; deadMs: number; bulkMs?: number };
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
    const end = await runLinkOnce(options, enrollToken, (hubId, machineId) => {
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
        enrolled?.(machineId);
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
function runLinkOnce(
  options: RunNodeOptions,
  enrollToken: string | undefined,
  onWelcome: (hubId: string, machineId: string) => void,
): Promise<LinkEnd> {
  const quiet = { probeMs: QUIET_PROBE_MS, deadMs: QUIET_DEAD_MS, bulkMs: BULK_DEAD_MS, ...options.quiet };
  return new Promise<LinkEnd>((resolve) => {
    let url: string;
    try {
      url = linkUrl(options.settings.hub);
    } catch (error) {
      return resolve({ kind: "lost", why: (error as Error).message });
    }
    // An enrolled node proves itself in the upgrade too (../../shared/upgrade_proof.ts); a first join, with its code,
    // sends nothing there. Never logged.
    const proof = enrollToken
      ? undefined
      : makeUpgradeProof({
          url,
          machineId: options.settings.machineId,
          pubKey: options.identity.pubKey(),
          now: (options.clock ?? systemClock).now(),
          sign: (message) => options.identity.signUpgrade(message),
        });
    const ws = proof ? new WebSocket(url, { headers: proof }) : new WebSocket(url);
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
    // A big frame may still be crossing: one of the node's own, until the ping written behind it is answered; or one the
    // hub said is coming (its heartbeat's `bulk`), until the next frame arrives.
    let bulkOut = 0;
    let inbound = false;
    // Whether the hub announces its big frames (`link_bulk`): one that doesn't (an older hub or cloud) may send one
    // unannounced at any time, so its link keeps the heartbeats' bound.
    let announces = false;
    // What runs once the hub answered the ping written behind a frame: that frame has crossed the link.
    const crossed = new Map<string, () => void>();
    let pings = 0;
    // Each watched screen's frames on the link (SCREEN_IN_FLIGHT at most), and those waiting for room (the newest, or
    // with H.264 a few in order); `lost`: an H.264 frame was dropped, so the stream waits for a keyframe.
    const screens = new Map<string, { flying: number; waiting: Waiting[]; lost?: boolean }>();
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

    /** Runs `fn` once everything written before now has crossed the link. */
    const afterCrossing = (fn: () => void) => {
      const id = `crossed-${++pings}`;
      crossed.set(id, fn);
      try {
        ws.ping(id);
      } catch {}
    };
    const send = (frame: NodeFrame) => {
      if (ended) return;
      const text = JSON.stringify(frame);
      if (frame.t === "browser_frame") return screen(String(frame.sessionId), { text, h264: frame.h264B64 !== undefined, key: frame.key === true });
      write(text);
    };
    // A screen's frames go only as fast as the link carries them, the newest of those made meanwhile next: a watched
    // screen faster than the machine's uplink would otherwise queue up ahead of everything else on it. An H.264 frame
    // can't be skipped alone (the ones after it are made from it): a few wait in order instead (H264_WAITING), a
    // keyframe or a JPEG replaces whatever waits, and past that the stream drops until a keyframe, which the screen
    // is asked for as the hub asks when its own watcher loses one.
    const screen = (id: string, frame: Waiting) => {
      const lane = screens.get(id) ?? { flying: 0, waiting: [] };
      screens.set(id, lane);
      if (frame.h264 && !frame.key && lane.lost) return;
      if (lane.flying >= SCREEN_IN_FLIGHT) {
        if (!frame.h264 || frame.key) {
          // A whole picture: what waits isn't needed. Deltas after a JPEG that replaced some are made from those.
          lane.lost = !frame.key && lane.waiting.some((w) => w.h264);
          lane.waiting = [frame];
        } else if (lane.waiting.length < H264_WAITING && !lane.waiting.some((w) => !w.h264)) {
          lane.waiting.push(frame);
        } else {
          lane.lost = true;
          if (live) options.handle({ t: "browser_watch", sessionId: id, on: true, video: true, key: true }, live);
        }
        return;
      }
      if (!frame.h264 || frame.key) lane.lost = false;
      lane.flying++;
      write(frame.text, () => {
        lane.flying--;
        const next = lane.waiting.shift();
        if (next !== undefined) screen(id, next);
        else if (lane.flying === 0) screens.delete(id);
      });
    };
    const write = (text: string, onCrossed?: () => void) => {
      writes = writes.then(async () => {
        if (ended) return;
        // In UTF-8 bytes, as it goes on the wire, not the string's length.
        let bytes = Buffer.byteLength(text);
        if (deflate && text.length >= MIN_DEFLATE_BYTES) {
          const data = await deflater.deflate(text);
          if (ended) return;
          ws.send(data);
          bytes = data.byteLength;
        } else ws.send(text);
        const bulk = bytes >= BULK_BYTES;
        if (bulk) bulkOut++;
        if (bulk || onCrossed)
          afterCrossing(() => {
            if (bulk) bulkOut--;
            onCrossed?.();
          });
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
      const deadMs = !announces || bulkOut > 0 || inbound ? quiet.bulkMs : quiet.deadMs;
      if (now >= heard + deadMs)
        return finish({ kind: "lost", why: `nothing from the hub for ${Math.round(deadMs / 1000)} s, and no answer to a ping` });
      if (now >= heard + quiet.probeMs && pinged !== heard) {
        pinged = heard;
        try {
          ws.ping();
        } catch {}
      }
      const wake = pinged === heard ? heard + deadMs : heard + quiet.probeMs;
      after(Math.max(10, wake - now), watchQuiet);
    };

    const onFrame = (frame: HubFrame) => {
      switch (stage) {
        case "challenge": {
          if (frame.t !== "challenge") return finish({ kind: "lost", why: `expected a challenge, got ${frame.t}` });
          const nonce = String(frame.nonce ?? "");
          if (isUpgradeProofMessage(nonce)) return finish({ kind: "lost", why: "the hub's challenge is not a nonce" });
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
          announces = caps.includes(HUB_CAP.LINK_BULK);
          const hubId = String(frame.hubId ?? "");
          stage = "live";
          live = ctx(hubId, caps);
          // A code minted for no machine: the hub says which id it settled on.
          onWelcome(hubId, typeof frame.machineId === "string" ? frame.machineId : options.settings.machineId);
          detach = options.attach(live);
          heartbeat();
          watchQuiet();
          options.woke?.(linkAbort.signal).then(() => finish({ kind: "woke" }));
          return;
        }
        case "live":
          inbound = frame.t === "hb" && typeof frame.bulk === "number";
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
    ws.addEventListener("pong", (event) => {
      heard = Date.now();
      const data = (event as MessageEvent).data;
      const id = data instanceof ArrayBuffer && data.byteLength ? new TextDecoder().decode(data) : undefined;
      const fn = id === undefined ? undefined : crossed.get(id);
      if (fn) {
        crossed.delete(id!);
        fn();
      }
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
          return finish({
            kind: "fatal",
            fatal: new LinkFatal(
              reason || `closed with ${code}`,
              code === CLOSE.UNAUTHORIZED && reason.includes(REMOVED),
              code === CLOSE.UNAUTHORIZED && reason.includes(NOT_ENROLLED),
            ),
          });
        const why = `hub closed the link (${code} ${reason})`.trim();
        finish(code === CLOSE.RESTART ? { kind: "restarting", why } : { kind: "lost", why });
      });
    });
    ws.addEventListener("error", () => {
      if (stage === "connect") finish({ kind: "lost", why: "cannot reach the hub: connection refused or failed" });
    });
  });
}
