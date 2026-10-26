// The feedback's screenshot: the preview's frame as the person marked it, in its own pixels, with each pin drawn where
// it is as the frame shows it (a numbered square), as a PNG for attachment_put.
import type { Pin } from "./model";

/** Base64 PNG of `jpegB64` with `pins` on it; undefined where the frame doesn't decode or there is no canvas. */
export async function shotWithPins(frame: { readonly jpegB64: string; readonly width: number; readonly height: number }, pins: readonly Pin[]): Promise<string | undefined> {
  try {
    const img = new Image();
    img.src = `data:image/jpeg;base64,${frame.jpegB64}`;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = frame.width;
    canvas.height = frame.height;
    const ctx = canvas.getContext("2d");
    if (ctx === null) return undefined;
    ctx.drawImage(img, 0, 0, frame.width, frame.height);
    const side = Math.max(18, Math.round(frame.width / 48));
    ctx.font = `600 ${String(Math.round(side * 0.6))}px system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    pins.forEach((p, i) => {
      const x = Math.round(p.x * frame.width);
      const y = Math.round(p.y * frame.height);
      ctx.fillStyle = "#fff";
      ctx.fillRect(x - side / 2 - 2, y - side / 2 - 2, side + 4, side + 4);
      ctx.fillStyle = "#16181a";
      ctx.fillRect(x - side / 2, y - side / 2, side, side);
      ctx.fillStyle = "#fff";
      ctx.fillText(String(i + 1), x, y + 1);
    });
    return canvas.toDataURL("image/png").split(",")[1];
  } catch {
    return undefined;
  }
}
