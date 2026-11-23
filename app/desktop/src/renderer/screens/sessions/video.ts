// A live screen's H.264 (a frame's `h264B64`, contracts' BrowserFrame), decoded with WebCodecs onto the screen
// player's canvas (player.ts's Surface, the one a replay draws into too), which lies over the screen's last JPEG: the
// hub sends a JPEG first, then a keyframe and the frames made from it. Every H.264 frame is decoded, in order, from the
// store's list of those since the last keyframe (the picture takes only the newest; renders batch frames). Each decoded
// picture is drawn as it comes, outside React's render; the canvas shows once it has one newer than the JPEG. JPEGs
// are drawn into the canvas too, so it always holds the newest picture whichever way it came: a device frame that takes
// the surface (a 3D one's texture) never needs the <img>. A frame let go unread watches anew (a JPEG, then a keyframe);
// a decoder that fails watches without H.264, JPEG from then on.
import { useEffect, useMemo, useRef, useState } from "react";
import type { BrowserFrame } from "../../../shared/contracts";
import { H264_CODEC, H264_CONFIG } from "../../../shared/h264";
import { useData } from "../../src/data/react";
import { Surface } from "./player";

export const CODEC = H264_CODEC;

const bytes = (b64: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Where an H.264 frame goes: into the decoder as a chunk, or nowhere while the decoder waits for a keyframe. */
export function chunkOf(frame: BrowserFrame, keyed: boolean): EncodedVideoChunkInit | undefined {
  if (frame.h264B64 === undefined || (!frame.key && !keyed)) return undefined;
  return { type: frame.key ? "key" : "delta", timestamp: frame.seq * 1000, data: bytes(frame.h264B64) };
}

/**
 * The frames of `frames` past `after` (the newest decoded), in order, and whether one was let go before the decoder had
 * it (`dropped`: the newest seq the store let go): a loss, unless the first new one is a keyframe.
 */
export function unread(frames: readonly BrowserFrame[], dropped: number, after: number): { fresh: BrowserFrame[]; lost: boolean } {
  const fresh = frames.filter((f) => f.seq > after);
  return { fresh, lost: dropped > after && fresh[0]?.key !== true };
}

/**
 * Decodes the watched session's H.264 onto `surface`'s canvas: whether it shows (it drew a picture newer than `under`,
 * the seq of the JPEG beneath, `picture`). `again` watches the screen anew; `jpeg` watches it without H.264.
 */
export function useVideo(
  sessionId: string,
  on: boolean,
  under: number | undefined,
  again: () => void,
  jpeg: () => void,
  picture?: { readonly seq: number; readonly jpegB64?: string | undefined },
) {
  const video = useData((st) => (on && st.browserVideo?.sessionId === sessionId ? st.browserVideo : undefined));
  const surface = useMemo(() => new Surface(document.createElement("canvas")), []);
  const decoder = useRef<VideoDecoder | null>(null);
  const keyed = useRef(false);
  const decoded = useRef(-1);
  // The newest picture drawn, by its frame's seq, for the session it was drawn for.
  const [drawn, setDrawn] = useState<{ sessionId: string; seq: number } | undefined>(undefined);
  // The newest picture's seq on the canvas, H.264's or a JPEG's: an older one that decodes late isn't drawn over it.
  const onCanvas = useRef(-1);
  // A node that linked again (restarted, or the next server that took the screen over) counts its frames from the
  // start: its stream is decoded afresh, as another session's is.
  const link = video?.link;
  useEffect(
    () => () => {
      if (decoder.current?.state !== "closed") decoder.current?.close();
      decoder.current = null;
      keyed.current = false;
      decoded.current = -1;
      onCanvas.current = -1;
      setDrawn(undefined);
    },
    [sessionId, link],
  );
  // A JPEG newer than the canvas's picture, drawn into it once decoded (off the page's main work): only while the
  // canvas shows (its H.264 drew) or something takes its pictures (a 3D frame), never for a hidden canvas nobody
  // reads. A seq lower than the canvas's is a relinked node counting from the start again.
  const jpegB64 = picture?.jpegB64;
  const jpegSeq = picture?.seq;
  const shows = drawn !== undefined && drawn.sessionId === sessionId && drawn.seq > (under ?? 0);
  const wanted = shows || surface.taken();
  useEffect(() => {
    if (jpegB64 === undefined || jpegSeq === undefined || !wanted || typeof createImageBitmap === "undefined") return undefined;
    if (jpegSeq < onCanvas.current) onCanvas.current = -1;
    if (jpegSeq <= onCanvas.current) return undefined;
    let live = true;
    void createImageBitmap(new Blob([bytes(jpegB64)], { type: "image/jpeg" })).then(
      (bitmap) => {
        if (live && jpegSeq > onCanvas.current) {
          onCanvas.current = jpegSeq;
          surface.draw(bitmap, bitmap.width, bitmap.height);
        }
        bitmap.close();
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [jpegB64, jpegSeq, surface, wanted]);
  useEffect(() => {
    if (video === undefined || typeof VideoDecoder === "undefined") return;
    const { fresh, lost } = unread(video.frames, video.dropped, decoded.current);
    const newest = fresh.at(-1);
    if (newest === undefined) return;
    decoded.current = newest.seq;
    if (lost) {
      keyed.current = false;
      again();
    }
    let d = decoder.current;
    if (d === null || d.state === "closed") {
      d = new VideoDecoder({
        output: (decodedPicture) => {
          const seq = decodedPicture.timestamp / 1000;
          if (seq > onCanvas.current) {
            onCanvas.current = seq;
            surface.draw(decodedPicture, decodedPicture.displayWidth, decodedPicture.displayHeight);
            setDrawn({ sessionId, seq });
          }
          decodedPicture.close();
        },
        // This app can't decode what comes: JPEG from now on.
        error: () => {
          keyed.current = false;
          decoder.current = null;
          jpeg();
        },
      });
      d.configure(H264_CONFIG);
      decoder.current = d;
    }
    for (const frame of fresh) {
      const chunk = chunkOf(frame, keyed.current);
      if (chunk === undefined) continue;
      if (frame.key === true) keyed.current = true;
      try {
        d.decode(new EncodedVideoChunk(chunk));
      } catch {
        // A chunk the decoder refuses outright: start again at a keyframe.
        keyed.current = false;
        again();
        return;
      }
    }
  }, [video, sessionId, again, jpeg, surface]);
  return { surface, on: shows };
}
