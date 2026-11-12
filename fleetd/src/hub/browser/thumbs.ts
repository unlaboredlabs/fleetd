// The Screens page's pictures (`screen_thumbs`): while an app shows the page,
// every THUMB_EVERY_SECS the hub takes one frame of each live screen and makes it small. It takes no capture of its
// own: it watches each screen as a person's live view does, and its node answers a watch at once with the screen's
// newest frame, so the watch ends as that frame lands. Each picture is made once, at most THUMB_SIDE a side (Bun's
// native libjpeg-turbo pipeline), and goes to every app showing the page whose key may watch its screen.
import type { BrowserFrame, ProjectRef, ScreenThumb } from "../../shared/contracts.ts";
import { CAP_BROWSER, THUMB_EVERY_SECS, THUMB_SIDE } from "../../shared/screens_wire.ts";
import type { Hub } from "../api/hub.ts";
import type { Caller } from "../api/registry.ts";
import { allows, isoMs } from "../auth/index.ts";
import { live, runsOn } from "./live.ts";
import { link } from "../link/index.ts";
import { appWs } from "./app.ts";
import type { AppConn } from "./app_seam.ts";
import { liveSessions } from "./store.ts";

/** How long a round waits for a screen's frame before it gives that screen up until the next. */
const FRAME_WAIT = 5_000;
/** The pictures' JPEG quality. */
const QUALITY = 70;

/** A picture, with the project its screen is for: who may see it. */
export type Picture = { projectRef: ProjectRef; thumb: ScreenThumb };

export class Thumbs {
  /** App connections showing the page now, each with its listener for new pictures. */
  private readonly viewers = new Set<(p: Picture) => void>();
  private readonly kept = new Map<string, Picture>();
  /** The screens a round waits on, each for its next frame. */
  readonly wanted = new Map<string, (frame: BrowserFrame) => void>();
  private shown: (() => void) | undefined;

  /** An app shows the page: the pictures there are now, and each new one until the returned stop. */
  view(fn: (p: Picture) => void): { now: Picture[]; stop: () => void } {
    this.viewers.add(fn);
    this.shown?.();
    return { now: [...this.kept.values()], stop: () => this.viewers.delete(fn) };
  }

  viewerCount(): number {
    return this.viewers.size;
  }

  /** Resolves once some app shows the page. */
  untilShown(): Promise<void> {
    if (this.viewers.size > 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.shown = () => {
        this.shown = undefined;
        resolve();
      };
    });
  }

  /** A screen's frame as it reaches its watchers: the one a round waits for, if it does. */
  offer(frame: BrowserFrame): void {
    const wants = this.wanted.get(frame.sessionId);
    if (wants) {
      this.wanted.delete(frame.sessionId);
      wants(frame);
    }
  }

  keep(p: Picture): void {
    this.kept.set(p.thumb.sessionId, p);
    for (const fn of this.viewers) fn(p);
  }

  /** Forgets the pictures of screens no longer live. */
  retain(live: Set<string>): void {
    for (const id of this.kept.keys()) if (!live.has(id)) this.kept.delete(id);
  }

  keptOf(id: string): Picture | undefined {
    return this.kept.get(id);
  }
}

/** A frame made small: at most THUMB_SIDE a side, as a JPEG. undefined for one that doesn't decode. */
export async function shrink(frame: BrowserFrame): Promise<{ jpeg: Uint8Array; width: number; height: number } | undefined> {
  try {
    const image = new Bun.Image(Buffer.from(frame.jpegB64, "base64"));
    const jpeg = await image
      .resize(THUMB_SIDE, THUMB_SIDE, { fit: "inside", withoutEnlargement: true })
      .jpeg({ quality: QUALITY })
      .bytes();
    return { jpeg, width: image.width, height: image.height };
  } catch {
    return undefined;
  }
}

/** Whether `caller` may see a screen of `project`'s: it reads the project's machine. */
export const maySee = (caller: Caller, project: ProjectRef) => allows(caller, "read", project.machineId);

/**
 * One round: a short watch of each live screen whose node can send its frames, each ended by its frame or by
 * FRAME_WAIT, and the pictures made from them. Returns how many it made.
 */
export async function round(hub: Hub): Promise<number> {
  const l = live(hub);
  const thumbs = l.thumbs;
  const sessions = liveSessions(hub);
  thumbs.retain(new Set(sessions.map((s) => s.sessionId)));
  const pending = sessions.flatMap((s) => {
    const machine = runsOn(hub, s);
    if (!link(hub).can(machine, CAP_BROWSER)) return [];
    const got = new Promise<BrowserFrame | undefined>((resolve) => {
      const timer = setTimeout(() => {
        thumbs.wanted.delete(s.sessionId);
        resolve(undefined);
      }, FRAME_WAIT);
      thumbs.wanted.set(s.sessionId, (frame) => {
        clearTimeout(timer);
        resolve(frame);
      });
    });
    const watching = l.watch(machine, s.sessionId, () => {});
    return [
      got.then(async (frame) => {
        // The watch ends here, with its frame: the node stops sending.
        watching.end();
        if (!frame) return 0;
        const small = await shrink(frame);
        if (!small) return 0;
        thumbs.keep({
          projectRef: s.projectRef,
          thumb: {
            sessionId: frame.sessionId,
            jpegB64: Buffer.from(small.jpeg).toString("base64"),
            width: small.width,
            height: small.height,
            at: isoMs(hub.clock.now()),
          },
        });
        return 1;
      }),
    ];
  });
  const made = (await Promise.all(pending)).reduce((a: number, b: number) => a + b, 0);
  thumbs.wanted.clear();
  return made;
}

/**
 * One app connection's showing of the page, until the returned stop: the pictures there are, then each new one, of
 * the screens `caller` may see, as `screen_thumb` frames.
 */
export function forward(hub: Hub, thumbs: Thumbs, caller: Caller, conn: AppConn): () => void {
  const seen = new Map<string, boolean>();
  const send = (p: Picture) => {
    const key = `${p.projectRef.machineId}\u0000${p.projectRef.projectId}`;
    let ok = seen.get(key);
    if (ok === undefined) {
      ok = maySee(caller, p.projectRef);
      seen.set(key, ok);
    }
    if (ok) appWs(hub).sendTo(conn, { ...p.thumb, t: "screen_thumb" });
  };
  const { now, stop } = thumbs.view(send);
  for (const p of now) send(p);
  return stop;
}

/** A round every THUMB_EVERY_SECS while an app shows the page, none while none does; until the hub stops. */
export async function run(hub: Hub, thumbs: Thumbs): Promise<void> {
  const stopped = hub.shutdown.signal;
  while (!stopped.aborted) {
    await Promise.race([thumbs.untilShown(), aborted(stopped)]);
    if (stopped.aborted) return;
    try {
      await round(hub);
    } catch (e) {
      console.warn("screens' pictures not taken:", e);
    }
    await sleep(THUMB_EVERY_SECS * 1000, stopped);
  }
}

export const aborted = (signal: AbortSignal) =>
  new Promise<void>((resolve) => (signal.aborted ? resolve() : signal.addEventListener("abort", () => resolve(), { once: true })));

/** Sleeps `ms`, or less when `signal` aborts first. */
export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}
