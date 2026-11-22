// A live screen's H.264 (a frame's `h264B64`, contracts' BrowserFrame), decoded with WebCodecs onto a canvas that
// lies over the screen's last JPEG: the hub sends a JPEG first, then a keyframe and the frames made from it. Each
// decoded picture is drawn as it comes, outside React's render; the canvas shows once it has one newer than the JPEG.
// A decoder that fails asks for the screen again (a new watch: a JPEG, then a keyframe).
import { useCallback, useEffect, useRef, useState } from "react";
import type { BrowserFrame } from "../../../shared/contracts";

/** High profile, level 4: the node's encoders make Main or High (Annex B, so no description); its decoder takes both. */
export const CODEC = "avc1.640028";

const bytes = (b64: string): Uint8Array => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Where an H.264 frame goes: into the decoder as a chunk, or nowhere while the decoder waits for a keyframe. */
export function chunkOf(frame: BrowserFrame, keyed: boolean): EncodedVideoChunkInit | undefined {
  if (frame.h264B64 === undefined || (!frame.key && !keyed)) return undefined;
  return { type: frame.key ? "key" : "delta", timestamp: frame.seq * 1000, data: bytes(frame.h264B64) };
}

/**
 * Decodes `frame`'s H.264 onto the canvas `canvas` attaches: whether it shows (it drew a picture newer than `under`,
 * the seq of the JPEG beneath). `again` watches the screen anew, for a decoder that failed.
 */
export function useVideo(frame: BrowserFrame | undefined, sessionId: string, under: number | undefined, again: () => void) {
  const element = useRef<HTMLCanvasElement | null>(null);
  const decoder = useRef<VideoDecoder | null>(null);
  const keyed = useRef(false);
  // The newest picture drawn, by its frame's seq, for the session it was drawn for.
  const [drawn, setDrawn] = useState<{ sessionId: string; seq: number } | undefined>(undefined);
  const canvas = useCallback((el: HTMLCanvasElement | null) => {
    element.current = el;
  }, []);
  useEffect(
    () => () => {
      if (decoder.current?.state !== "closed") decoder.current?.close();
      decoder.current = null;
      keyed.current = false;
    },
    [sessionId],
  );
  useEffect(() => {
    if (frame === undefined || typeof VideoDecoder === "undefined") return;
    const chunk = chunkOf(frame, keyed.current);
    if (chunk === undefined) return;
    let d = decoder.current;
    if (d === null || d.state === "closed") {
      d = new VideoDecoder({
        output: (picture) => {
          const c = element.current;
          if (c !== null) {
            if (c.width !== picture.displayWidth || c.height !== picture.displayHeight) {
              c.width = picture.displayWidth;
              c.height = picture.displayHeight;
            }
            c.getContext("2d")?.drawImage(picture, 0, 0);
            setDrawn({ sessionId, seq: picture.timestamp / 1000 });
          }
          picture.close();
        },
        error: () => {
          keyed.current = false;
          decoder.current = null;
          again();
        },
      });
      d.configure({ codec: CODEC, optimizeForLatency: true });
      decoder.current = d;
    }
    if (frame.key === true) keyed.current = true;
    try {
      d.decode(new EncodedVideoChunk(chunk));
    } catch {
      // A chunk the decoder refuses outright: start again at a keyframe.
      keyed.current = false;
      again();
    }
  }, [frame, sessionId, again]);
  const on = drawn !== undefined && drawn.sessionId === sessionId && drawn.seq > (under ?? 0);
  return { canvas, on };
}
