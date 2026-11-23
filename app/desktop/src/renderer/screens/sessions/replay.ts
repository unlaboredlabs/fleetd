// A recording's MP4 played by the screen player (player.ts) into a canvas of its own: the replay's half of the one
// player the live view shares (video.ts draws into a Surface too). A WebM (a browser's recording) or an app without
// WebCodecs plays in a <video> as before: `replay` is undefined for it.
import { useEffect, useMemo, useRef, useState } from "react";
import { readMp4, type Track } from "./mp4";
import { Replay, Surface } from "./player";

/** How often the replay's time reaches React while it plays: the scrubber moves smoothly, the steps list keeps up. */
const TIME_EVERY_MS = 100;

export type ReplayState = {
  /** The canvas the recording draws into, and its picture's size. */
  readonly surface: Surface;
  readonly replay: Replay;
  /** The first picture's size, before any is drawn: the frame's shape from the start. */
  readonly size: { readonly width: number; readonly height: number };
};

/**
 * The replay of `video` (an MP4 this player reads), its time to `onTime` as it plays, `onEnd` at its end. Undefined
 * while it reads, and for a video it doesn't play (`fallback` is then true: a <video> plays it). One whose frames this
 * app can't decode falls back the same way, `failed` saying so in plain words.
 */
export function useReplay(video: Blob | undefined, onTime: (ms: number) => void, onEnd: () => void): { state?: ReplayState; fallback: boolean; failed?: string } {
  // What was read, for the video it was read from: another video reads as not read yet.
  const [read, setRead] = useState<{ video: Blob | undefined; got: { file: Uint8Array; track: Track } | null } | undefined>(undefined);
  const plays = video !== undefined && video.type === "video/mp4" && typeof VideoDecoder !== "undefined";
  useEffect(() => {
    if (!plays) return undefined;
    let live = true;
    void video.arrayBuffer().then(
      (bytes) => {
        if (!live) return;
        const file = new Uint8Array(bytes);
        const track = readMp4(file);
        setRead({ video, got: track === undefined || track.samples.length === 0 ? null : { file, track } });
      },
      () => live && setRead({ video, got: null }),
    );
    return () => {
      live = false;
    };
  }, [video, plays]);
  const got = !plays ? null : read?.video === video ? read.got : undefined;
  const hooks = useRef({ onTime, onEnd });
  useEffect(() => {
    hooks.current = { onTime, onEnd };
  });
  const surface = useMemo(() => new Surface(document.createElement("canvas")), []);
  const [state, setState] = useState<(ReplayState & { got: unknown }) | undefined>(undefined);
  // The video whose frames didn't decode here.
  const [broken, setBroken] = useState<{ got: unknown } | undefined>(undefined);
  useEffect(() => {
    if (!got) return undefined;
    let last = 0;
    const replay = new Replay(got.file, got.track, surface, {
      onTime: (ms) => {
        const now = performance.now();
        if (now - last < TIME_EVERY_MS && replay.playing()) return;
        last = now;
        hooks.current.onTime(ms);
      },
      onEnd: () => hooks.current.onEnd(),
      onError: () => {
        replay.close();
        // Stopped: the basic player that takes over starts paused.
        hooks.current.onEnd();
        setBroken({ got });
      },
    });
    // Its first picture at once, as a paused player shows it.
    replay.seek(0);
    setState({ got, surface, replay, size: { width: got.track.width, height: got.track.height } });
    return () => replay.close();
  }, [got, surface]);
  if (got && broken?.got === got) return { fallback: true, failed: "This app couldn’t decode its frames, so it plays in the basic player." };
  const current = state?.got === got ? state : undefined;
  return { ...(current === undefined ? {} : { state: current }), fallback: got === null };
}

/** The size of the picture `surface` holds now, as each picture lands (`first` until one has). */
export function useSurfaceSize(surface: Surface | undefined, first?: { width: number; height: number }): { width: number; height: number } | undefined {
  const [size, setSize] = useState<{ width: number; height: number } | undefined>(undefined);
  useEffect(() => {
    if (surface === undefined) return undefined;
    return surface.onPicture(() => setSize((was) => (was?.width === surface.width && was.height === surface.height ? was : { width: surface.width, height: surface.height })));
  }, [surface]);
  return size ?? first;
}
