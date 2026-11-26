// One team's hub in the web app: the desktop's own client (main/hub/client.ts) over the browser's WebSocket, straight
// to fleetd cloud at /t/<team>/app on this origin. The session's cookie authenticates the upgrade, as a device key on
// the desktop's upgrade does, so the client's `auth` carries no key. Frames fan out to the page's subscribers as main's
// HubService fans them out to windows: each starts from the state, then a fresh snapshot.
import type { BrowserInput } from "../shared/contracts";
import type { CallOutcome, HubFrame, HubState } from "../shared/hub";
import type { CallRequest, ChatScope, OrderFocus } from "../shared/ipc";
import { HubClient } from "../main/hub/client";
import { H264_CONFIG } from "../shared/h264";
import type { Connection, ConnectionEvents, Transport } from "../main/hub/link";

/** What the cloud answers on the web socket alone: a browser can't send a WebSocket ping, nor see one. */
const PING = JSON.stringify({ t: "ping" });

/** The features the client asks for, as the query the cloud reads (a browser sets no headers on an upgrade). */
const withFeatures = (url: string, headers: Readonly<Record<string, string>> | undefined): string => {
  // No `deflate`: the client's own compression needs Node's zlib, so frames stay Text both ways.
  const features = (headers?.["x-fleetd-features"] ?? "")
    .split(",")
    .map((f) => f.trim())
    .filter((f) => f !== "" && f !== "deflate");
  return features.length === 0 ? url : `${url}${url.includes("?") ? "&" : "?"}features=${encodeURIComponent(features.join(","))}`;
};

/**
 * The browser's WebSocket as the client's transport. Its `authorization` header is dropped: the cookie goes on the
 * upgrade by itself. A Binary frame can only be one this page didn't ask for, so it drops the link.
 */
export const browserTransport =
  (Socket: typeof WebSocket = WebSocket): Transport =>
  (url: string, events: ConnectionEvents, headers?: Readonly<Record<string, string>>): Connection => {
    let closed = false;
    const close = (code: number, reason: string) => {
      if (closed) return;
      closed = true;
      events.onClose(code, reason);
    };
    let socket: WebSocket;
    try {
      socket = new Socket(withFeatures(url, headers));
    } catch (error) {
      queueMicrotask(() => close(1006, error instanceof Error ? error.message : String(error)));
      return { send: () => undefined, ping: () => undefined, close: () => close(1006, "closed by the app"), wholeFrames: true };
    }
    socket.binaryType = "arraybuffer";
    socket.onopen = () => events.onOpen();
    socket.onmessage = (e: MessageEvent) => {
      events.onHeard();
      if (typeof e.data === "string") events.onText(e.data);
      else {
        socket.close(1003, "binary frames aren't read here");
        close(1006, "the workspace sent a frame this page can't read");
      }
    };
    socket.onclose = (e: CloseEvent) => close(e.code, e.reason);
    const open = () => socket.readyState === Socket.OPEN;
    return {
      send: (text) => {
        if (open()) socket.send(text);
      },
      ping: () => {
        if (open()) socket.send(PING);
      },
      close: () => {
        socket.onopen = socket.onmessage = socket.onclose = null;
        socket.close();
        close(1006, "closed by the app");
      },
      // The page hears a frame only once it has all come.
      wholeFrames: true,
    };
  };

/** One team: its client, and the page's subscribers to it. */
export class WebHub {
  readonly #client: HubClient;
  readonly #listeners = new Set<(frame: HubFrame) => void>();
  /** Subscribers that haven't had their snapshot yet: events and live diffs would mean nothing to them. */
  readonly #awaiting = new Set<(frame: HubFrame) => void>();
  readonly #onState: (state: HubState) => void;
  #started = false;

  /**
   * `team`: the team's own address (`https://<team>.fleetd.dev`), which the screens name the hub by; `socket`: where it
   * is dialled, `wss://<this origin>/t/<team>/app`. `onState`: every state, for a refused key's sign-in check.
   */
  constructor(team: string, socket: string, transport: Transport, onState: (state: HubState) => void) {
    this.#onState = onState;
    // The client dials the address it is given; this one dials the team's socket on this origin instead.
    const here: Transport = (_url, events, headers) => transport(socket, events, headers);
    this.#client = new HubClient({ hub: team, key: "", transport: here, emit: (frame) => this.#broadcast(frame) });
    // H.264 only where this browser decodes the codec the nodes send: WebCodecs alone isn't enough (a Firefox on Linux
    // without system codecs has it, and can't).
    if (typeof VideoDecoder !== "undefined") {
      void VideoDecoder.isConfigSupported(H264_CONFIG).then(
        (r) => r.supported === true && this.#client.setVideo(true),
        () => {},
      );
    }
  }

  get state(): HubState {
    return this.#client.state;
  }

  subscribe(listener: (frame: HubFrame) => void): () => void {
    // The first subscriber dials, before it listens: its first frame is the state that dial left.
    const first = !this.#started;
    if (first) {
      this.#started = true;
      this.#client.start();
    }
    this.#listeners.add(listener);
    this.#awaiting.add(listener);
    listener({ t: "state", state: this.#client.state });
    // A later one asks for a fresh snapshot of its own, as a window subscribing to main's HubService does.
    if (!first) {
      this.#client.resync();
      this.#client.refreshLive();
    }
    return () => {
      this.#listeners.delete(listener);
      this.#awaiting.delete(listener);
    };
  }

  call(request: CallRequest): Promise<CallOutcome> {
    return this.#client.call(request);
  }

  chat(project: ChatScope | null): void {
    this.#client.chat(project);
  }

  focus(workstreamId: OrderFocus | null): void {
    this.#client.focus(workstreamId);
  }

  /** `video` false: the page's decoder failed, so the watch asks for JPEG from now on. */
  watch(session: string | null, video?: boolean): void {
    if (video === false) this.#client.setVideo(false);
    this.#client.watch(session);
  }

  thumbs(on: boolean): void {
    this.#client.thumbs(on);
  }

  input(session: string, input: BrowserInput): void {
    this.#client.input(session, input);
  }

  rtc(session: string, peer: string, offer: string | null): void {
    this.#client.rtc(session, peer, offer);
  }

  rtcWatch(session: string, peer: string | null): void {
    this.#client.rtcWatch(session, peer);
  }

  resync(): void {
    this.#client.resync();
  }

  retryNow(): void {
    this.#client.reconnectNow();
  }

  /** The tab came back into view: the live feed again, now, on a link that answers (a tab in the back, or a laptop
   * that slept with it, may hold a dead one). */
  shown(on: boolean): void {
    this.#client.shown(on);
    if (on) {
      this.#client.refreshLive();
      this.#client.check();
    }
  }

  /** The window came to the front: a dead link is found now, not at the next steady ping. */
  check(): void {
    this.#client.check();
  }

  /** The computer slept (followBrowser saw the clock jump): the link is most likely half-open. */
  woke(): void {
    this.#client.woke();
  }

  /** The network came back, or the page came back from the back-forward cache: the link may be half-open. */
  probe(): void {
    this.#client.probe();
  }

  stop(): void {
    this.#client.stop();
  }

  #broadcast(frame: HubFrame): void {
    if (frame.t === "state") this.#onState(frame.state);
    for (const listener of this.#listeners) {
      if (frame.t === "snapshot") this.#awaiting.delete(listener);
      else if ((frame.t === "event" || frame.t === "live") && this.#awaiting.has(listener)) continue;
      listener(frame);
    }
  }
}
