// `bun scripts/screen-lab.ts --hub <url> --code <enrolment code> --fallback <dir> [--frames <dir>]`, run by
// `scripts/phone-lab.sh mac`:
// a stand-in for the agents' Mac on a throwaway hub, so the phone app (and the desktop app) can open an iOS simulator
// screen there and be judged on a real iOS simulator. It links as a node with the Mac's capabilities, through the
// node's own link code (src/node/link), and plays the Mac's part of a person's iPhone: it opens the hub's sealed
// `sim_start` and `sim_end` with its own box key and answers them, reports the session live, streams pictures to
// whoever watches, follows Take over and Hand back, and answers the device's controls (rotate, fold, appearance, text
// size, screenshot, the rest) by switching to the picture of that pose. No simulator runs: the pictures are real
// simulator screenshots, files named for their pose in `--frames` (closed, half-open, open, laptop for an iPhone Duo;
// iphone, iphone-left and iphone-right for an iPhone; .jpg), else `--fallback`'s (the desktop app's fixtures, which
// phone-lab gives it). Never point it at a
// real hub: it would offer that hub's people a Mac that isn't there.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { NodeBoxKey, NodeIdentity } from "../src/node/identity.ts";
import { runNode, type LinkContext } from "../src/node/link/index.ts";
import { sealAnswer, splitRaw, type Done, type Envelope } from "../src/node/mac_tool/protocol.ts";
import { CAP_SESSION_HOST, CAP_SESSION_SEAL } from "../src/shared/screens_wire.ts";
import { VERSION } from "../src/shared/version.ts";

// --watch: its screens stay their agent's (a person's takeover is not taken), for trying what a person sees while an
// agent drives: Take Over, a phone's device turned by a drag. --cycle <ms>: an iPhone Duo goes through its postures
// (closed, half-open, open, laptop) by itself, one each <ms>, as an agent folding it would, for recording what a
// watcher sees at each change. Each press a person sends is logged with where it fell on the picture.
const { values } = parseArgs({
  options: {
    hub: { type: "string" },
    code: { type: "string" },
    frames: { type: "string" },
    fallback: { type: "string" },
    machine: { type: "string" },
    watch: { type: "boolean" },
    cycle: { type: "string" },
  },
});
if (values.hub === undefined || values.code === undefined || values.fallback === undefined) {
  throw new Error("usage: bun scripts/screen-lab.ts --hub <url> --code <enrolment code> --fallback <dir> [--frames <dir>]");
}
const FIXTURES = values.fallback;
/** Each pose's picture: from --frames when it has one, else the fallback's (the desktop fixtures' simulator screenshots). */
const FALLBACK: Record<string, string> = { closed: "duoFolded.jpg", "half-open": "duoOpen.jpg", open: "duoOpen.jpg", laptop: "duoOpen.jpg", iphone: "iphone17.jpg", "iphone-left": "iphone17Left.jpg", "iphone-right": "iphone17Left.jpg" };
const picture = (pose: string): { jpegB64: string; width: number; height: number } => {
  const own = values.frames === undefined ? undefined : join(values.frames, `${pose}.jpg`);
  const file = own !== undefined && existsSync(own) ? own : join(FIXTURES, FALLBACK[pose] ?? "iphone17.jpg");
  const bytes = readFileSync(file);
  const [width, height] = jpegSize(bytes);
  return { jpegB64: bytes.toString("base64"), width, height };
};

/** A JPEG's width and height, from its first start-of-frame marker. */
function jpegSize(b: Buffer): [number, number] {
  for (let i = 2; i < b.length - 9; ) {
    if (b[i] !== 0xff) break;
    const marker = b[i + 1]!;
    const len = b.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  throw new Error("not a JPEG with a frame header");
}

const RUNTIME = { id: "com.apple.CoreSimulator.SimRuntime.iOS-27-2", name: "iOS 27.2" };
const MODELS = [
  { id: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro", name: "iPhone 17 Pro", family: "iphone", runtimes: [RUNTIME] },
  { id: "com.apple.CoreSimulator.SimDeviceType.iPhone-Duo", name: "iPhone Duo", family: "foldable", runtimes: [RUNTIME] },
];
const IOS = ["rotate_left", "rotate_right", "shake", "home", "lock", "appearance", "text_size", "screenshot", "location"];
const FOLDS = ["closed", "half-open", "open", "laptop"];
const TURNS = ["portrait", "landscape_left", "portrait_upside_down", "landscape_right"];

/** One simulator screen this stand-in lends. */
type Screen = {
  sessionId: string;
  hostKey: string;
  thread: string;
  model: string;
  control: "agent" | "human";
  orientation: string;
  fold?: string;
  appearance: string;
  textSize: string;
  startedAt: string;
  seq: number;
  watched?: ReturnType<typeof setInterval>;
};
const screens = new Map<string, Screen>();
let link: LinkContext | undefined;
let calls = 0;

const duo = (s: Screen) => s.model === "iPhone Duo";
const device = (s: Screen) => ({
  model: s.model,
  controls: duo(s) ? [...IOS, "fold"] : IOS,
  orientation: s.orientation,
  appearance: s.appearance,
  textSize: s.textSize,
  ...(duo(s) ? { fold: s.fold, folds: FOLDS } : {}),
});
/** The picture of a screen's pose now. */
const poseOf = (s: Screen) =>
  duo(s) ? (s.fold ?? "closed") : s.orientation === "landscape_left" ? "iphone-left" : s.orientation === "landscape_right" ? "iphone-right" : "iphone";

/** The session as the Mac reports it, through the screen's host key. */
const report = (s: Screen, state = "live") =>
  link?.send({
    t: "lead_call",
    id: `lc-lab-${++calls}`,
    cwd: "/",
    threadId: s.hostKey,
    call: { op: "browser_session", sessionId: s.sessionId, kind: "ios", threadId: s.thread, purpose: `${s.model} · lab`, state, control: s.control, startedAt: s.startedAt, files: [], device: device(s) },
  } as never);

/** The pose's picture now, to whoever watches. */
const frame = (s: Screen) => {
  const p = picture(poseOf(s));
  link?.send({ t: "browser_frame", sessionId: s.sessionId, seq: ++s.seq, control: s.control, ...p } as never);
};

const answerStep = (env: Envelope, f: { screen?: { hostKey: string; sessionId: string } }): Done | { error: string } => {
  const step = env.step;
  if (step.step === "sim_start" && f.screen !== undefined) {
    const model = MODELS.find((m) => m.id === step.device)?.name ?? "iPhone 17 Pro";
    const s: Screen = {
      sessionId: f.screen.sessionId,
      hostKey: f.screen.hostKey,
      thread: env.thread,
      model,
      control: "agent",
      orientation: "portrait",
      appearance: "light",
      textSize: "large",
      startedAt: new Date().toISOString(),
      seq: 0,
      ...(model === "iPhone Duo" ? { fold: "closed" } : {}),
    };
    screens.set(s.sessionId, s);
    setTimeout(() => report(s), 200);
    const every = Number(values.cycle ?? 0);
    if (every > 0 && s.fold !== undefined) {
      let at = 0;
      const timer = setInterval(() => {
        if (!screens.has(s.sessionId)) return clearInterval(timer);
        at = (at + 1) % FOLDS.length;
        control(s, "fold", FOLDS[at]);
        report(s);
        console.log(`screen-lab: ${s.sessionId} folded ${s.fold ?? ""}`);
      }, every);
    }
    console.log(`screen-lab: lent ${model} as ${s.sessionId}`);
    return { step: "sim_start", udid: s.sessionId, device: `${model} on ${RUNTIME.name}` };
  }
  if (step.step === "sim_end") {
    for (const s of screens.values()) {
      if (s.thread !== env.thread) continue;
      clearInterval(s.watched);
      screens.delete(s.sessionId);
      report(s, "ended");
    }
    return { step: "sim_end", ended: true } as Done;
  }
  return { error: `the lab's Mac runs no ${step.step}` };
};

const control = (s: Screen, c: string, value?: string): Record<string, unknown> => {
  const at = Math.max(0, TURNS.indexOf(s.orientation));
  if (c === "rotate_left") s.orientation = TURNS[(at + 1) % 4]!;
  else if (c === "rotate_right") s.orientation = TURNS[(at + 3) % 4]!;
  else if (c === "appearance") s.appearance = value ?? (s.appearance === "dark" ? "light" : "dark");
  else if (c === "text_size" && value !== undefined) s.textSize = value;
  else if (c === "fold" && value !== undefined && duo(s)) {
    s.orientation = value === "laptop" ? "landscape_left" : s.fold === "laptop" ? "portrait" : s.orientation;
    s.fold = value;
  }
  frame(s);
  if (c !== "screenshot") return {};
  const p = picture(poseOf(s));
  // A JPEG under the PNG name: the lab has no PNG of each pose, and the apps show either.
  return { screenshot: { pngB64: p.jpegB64, width: p.width, height: p.height } };
};

const box = new NodeBoxKey(randomBytes(32));
const fatal = await runNode({
  settings: { hub: values.hub, machineId: values.machine ?? "lab-mac", name: "Lab Mac", nodeVersion: VERSION },
  identity: new NodeIdentity(randomBytes(32)),
  boxPubKey: box.publicKey(),
  enrollToken: values.code,
  onEnrolled: (id) => console.log(`screen-lab: enrolled as ${id}`),
  // A Mac that hosts people's screens: the hub then offers it for a person's New Screen › iPhone, as the real one.
  capabilities: () => ["agents_mac", "mac_tool", "screen_control", "browser", CAP_SESSION_HOST, CAP_SESSION_SEAL],
  heartbeat: async () => ({
    load: {
      cpus: 8,
      load1: 0,
      memTotalBytes: 16 * 2 ** 30,
      hosts: [
        { host: "mac", ready: true, detail: "the phone lab's stand-in" },
        { host: "ios", ready: true, detail: "2 models", sims: { models: MODELS, live: screens.size, max: 2 } },
      ],
    },
    busy: { threads: 0, screens: screens.size, uploads: 0, hosted: 0 },
  }),
  attach: (ctx) => {
    link = ctx;
    console.log("screen-lab: linked");
    for (const s of screens.values()) report(s);
    return () => {
      link = undefined;
    };
  },
  handle: (f) => {
    const frame0 = f as unknown as Record<string, unknown> & { t: string; id?: string; sessionId?: string };
    const s = frame0.sessionId === undefined ? undefined : screens.get(frame0.sessionId);
    switch (frame0.t) {
      case "mac_call": {
        const opened = box.open(Buffer.from(String(frame0.sealed), "base64"));
        if (opened === null) return;
        const [env] = splitRaw<Envelope>(opened);
        const done = answerStep(env, frame0 as { screen?: { hostKey: string; sessionId: string } });
        const answer = "error" in done ? { error: { code: "invalid" as const, message: done.error } } : { done };
        link?.send({ t: "mac_result", id: frame0.id, sealed: sealAnswer(Buffer.from(env.answerKey, "base64"), answer) } as never);
        return;
      }
      case "browser_watch": {
        if (s === undefined) return;
        clearInterval(s.watched);
        s.watched = undefined;
        if (frame0.on === true) {
          frame(s);
          // A live screen sends again now and then, as the Mac's does while nothing moves.
          s.watched = setInterval(() => frame(s), 2_000);
        }
        return;
      }
      case "browser_input": {
        const input = frame0.input as { kind?: string; action?: string; x?: number; y?: number } | undefined;
        if (s !== undefined && input?.kind === "mouse" && input.action === "pressed") {
          const p = picture(poseOf(s));
          console.log(`screen-lab: ${s.sessionId} pressed at ${String(input.x)},${String(input.y)} of ${String(p.width)}x${String(p.height)} (${poseOf(s)})`);
        }
        return;
      }
      case "browser_control": {
        if (s === undefined) return;
        s.control = frame0.control === "human" && values.watch !== true ? "human" : "agent";
        report(s);
        return;
      }
      case "screen_control": {
        if (s === undefined) {
          link?.send({ t: "screen_control_result", id: frame0.id, error: { code: "not_found", message: "no such screen here" } } as never);
          return;
        }
        const extra = control(s, String(frame0.control), typeof frame0.value === "string" ? frame0.value : undefined);
        link?.send({ t: "screen_control_result", id: frame0.id, device: device(s), ...extra } as never);
        // The device as it stands now, which the hub keeps, as the Mac reports it after each control.
        report(s);
        return;
      }
      case "session_host":
        // A browser or desktop screen placed here: the lab's Mac lends only iOS simulators.
        link?.send({ t: "session_host_result", id: frame0.id, frame: { id: frame0.id, error: { code: "invalid", message: "the phone lab's Mac lends only iOS simulators" } } } as never);
        return;
      default:
        return;
    }
  },
});
if (fatal !== undefined) {
  console.error(`screen-lab: ${fatal.message}`);
  process.exit(1);
}
