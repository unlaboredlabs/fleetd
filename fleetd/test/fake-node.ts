// A stand-in node for link tests: an ed25519 key, the hello the Rust node sends, and the frames it gets back.
import { generateKeyPairSync, sign } from "node:crypto";
import { Deflater, Inflater } from "../src/hub/link/deflate.ts";
import { PROTOCOL_VERSION } from "../src/shared/contracts.ts";

export type Frame = { t: string } & Record<string, unknown>;

export function nodeKey() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const x = publicKey.export({ format: "jwk" }).x as string;
  return {
    pubKey: Buffer.from(x, "base64url").toString("base64"),
    sign: (nonce: string) => sign(null, Buffer.from(nonce), privateKey).toString("base64"),
  };
}

export type FakeNodeOptions = {
  machineId?: string;
  key?: ReturnType<typeof nodeKey>;
  enrollToken?: string;
  capabilities?: string[];
  protocol?: number;
  fingerprint?: string;
  /** The fleetd its hello says it runs; 0.0.0-test by default. */
  nodeVersion?: string;
  /** Answers each `session_call runner_info` as logged in; false leaves them unanswered. */
  runner?: "logged_in" | "logged_out" | false;
};

export class FakeNode {
  readonly ws: WebSocket;
  readonly frames: Frame[] = [];
  readonly key: ReturnType<typeof nodeKey>;
  closed: Promise<{ code: number; reason: string }>;
  private waiters: { match: (f: Frame) => boolean; resolve: (f: Frame) => void }[] = [];
  private deflate = false;
  private deflater = new Deflater();
  private inflater = new Inflater(64 << 20);
  private queue: Promise<void> = Promise.resolve();

  constructor(url: string, readonly options: FakeNodeOptions = {}) {
    this.key = options.key ?? nodeKey();
    this.ws = new WebSocket(url);
    this.ws.binaryType = "arraybuffer";
    this.closed = new Promise((resolve) => this.ws.addEventListener("close", (e) => resolve({ code: e.code, reason: e.reason })));
    this.ws.addEventListener("message", (e) => {
      const data = e.data;
      this.queue = this.queue.then(async () => {
        const text = typeof data === "string" ? data : await this.inflater.inflate(new Uint8Array(data as ArrayBuffer));
        this.got(JSON.parse(text) as Frame, typeof data !== "string");
      });
    });
  }

  get machineId() {
    return this.options.machineId ?? "devbox";
  }

  private got(frame: Frame, binary: boolean) {
    (frame as Record<string, unknown>).binary = binary;
    this.frames.push(frame);
    if (frame.t === "challenge") this.hello(frame.nonce as string);
    if (frame.t === "welcome" && (this.options.capabilities ?? []).includes("link_deflate")) this.deflate = true;
    if (frame.t === "session_call" && (frame.call as { op: string }).op === "runner_info" && this.options.runner !== false) {
      const login = this.options.runner ?? "logged_in";
      this.send({
        t: "session_reply",
        id: frame.id,
        result: { ok: { kind: "runner_info", runner: "claude", supported: "*", versionOk: true, login, ...(login === "logged_in" ? {} : { problem: "claude is logged out" }) } },
      });
    }
    this.waiters = this.waiters.filter((w) => {
      if (!w.match(frame)) return true;
      w.resolve(frame);
      return false;
    });
  }

  private hello(nonce: string) {
    const o = this.options;
    this.sendNow({
      t: "hello",
      machineId: this.machineId,
      name: this.machineId,
      tags: [],
      nodeVersion: o.nodeVersion ?? "0.0.0-test",
      protocol: o.protocol ?? PROTOCOL_VERSION,
      pubKey: this.key.pubKey,
      sig: this.key.sign(nonce),
      ...(o.enrollToken ? { enrollToken: o.enrollToken } : {}),
      boxPubKey: "Ym94",
      capabilities: o.capabilities ?? [],
      ...(o.fingerprint ? { machineFingerprint: o.fingerprint } : {}),
    });
  }

  private sendNow(frame: unknown) {
    this.ws.send(JSON.stringify(frame));
  }

  /** Sends a frame, compressed once the link is when it's long enough. */
  send(frame: unknown) {
    const text = JSON.stringify(frame);
    if (!this.deflate || text.length < 64) {
      this.queue = this.queue.then(() => this.ws.send(text));
      return;
    }
    const out = this.deflater.deflate(text);
    this.queue = this.queue.then(async () => this.ws.send(await out));
  }

  /** The first frame (seen or to come) that `match` takes. */
  next(match: (f: Frame) => boolean, timeoutMs = 3000): Promise<Frame> {
    const seen = this.frames.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no such frame")), timeoutMs);
      this.waiters.push({ match, resolve: (f) => (clearTimeout(timer), resolve(f)) });
    });
  }

  tag(t: string, timeoutMs?: number) {
    return this.next((f) => f.t === t, timeoutMs);
  }

  close() {
    this.ws.close();
  }
}
