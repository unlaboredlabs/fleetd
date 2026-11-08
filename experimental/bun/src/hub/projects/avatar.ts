// A project's or Navi's picture (crates/fleetd/src/hub/projects/avatar.rs): what its chat shows in place of its
// letters. The app uploads the picture as it was picked (attachment_put) and names the square to keep; the hub
// decodes it (png, jpeg or webp), turns it as its EXIF says, crops it, shrinks it to at most AVATAR_PX a side and keeps
// that alone, re-encoded as JPEG: none of the original's metadata is kept, and the upload is forgotten at once. The
// summary names it by `avatar`, its sha256's first 16 hex, so an app fetches its bytes once per picture.
import type { Database } from "bun:sqlite";
import { deflateSync, inflateSync } from "node:zlib";
import type { AvatarCrop, ProjectAvatarSetInput, ProjectRef, ProjectSummary } from "../../shared/contracts.ts";
import { ToolError } from "../../shared/errors.ts";
import { requireRole } from "../api/grants.ts";
import type { Hub } from "../api/hub.ts";
import { unknownProject } from "../api/refusals.ts";
import type { Caller } from "../api/registry.ts";
import { take } from "../intake/attachments.ts";
import { events } from "../store/events.ts";
import { store } from "../store/hub_store.ts";
import { isoMs } from "../store/time.ts";

/** The project's picture's id, for its summary. */
export function of(db: Database, r: ProjectRef): string | undefined {
  return (
    db
      .query<{ avatar: string }, [string, string]>("SELECT avatar FROM project_avatars WHERE machine_id = ? AND project_id = ?")
      .get(r.machineId, r.projectId)?.avatar ?? undefined
  );
}

/** `project_avatar_get`: the kept picture's JPEG. */
export function get(db: Database, r: ProjectRef): { avatar: string; mime: "image/jpeg"; dataB64: string } {
  const kept = db
    .query<{ avatar: string; jpeg: Uint8Array }, [string, string]>(
      "SELECT avatar, jpeg FROM project_avatars WHERE machine_id = ?1 AND project_id = ?2",
    )
    .get(r.machineId, r.projectId);
  if (!kept) {
    throw new ToolError("not_found", `${r.projectId} on ${r.machineId} has no picture.`, "Its letters show; project_avatar_set gives it one.");
  }
  return { avatar: kept.avatar, mime: "image/jpeg", dataB64: Buffer.from(kept.jpeg).toString("base64") };
}

/** A kept picture's side at most, in pixels (contracts `AVATAR_PX`). */
export const AVATAR_PX = 512;
/** The kept JPEG's most bytes: a busier picture is encoded again at a lower quality until it fits. */
export const AVATAR_MAX_BYTES = 160 * 1024;
/** A picture wider or taller than this is refused before it is decoded. */
const SOURCE_MAX_PX = 12_000;
/** The most pixels decoding one picture may take: Rust's 512 MB allocation limit, at 4 bytes a pixel. */
const SOURCE_MAX_PIXELS = (512 * 1024 * 1024) / 4;
const QUALITIES = [86, 76, 64, 50];

const unusable = (why: string) =>
  new ToolError("invalid", `That picture can't be used: ${why}.`, "Pick a photo or a png, jpeg or webp image.");

/** The square `crop` names, inside a `w` × `h` picture: moved, then shrunk, to fit. Absent: the largest in the middle. */
export function square(w: number, h: number, crop: AvatarCrop | undefined): [number, number, number] {
  const short = Math.min(w, h);
  if (!crop) return [Math.floor((w - short) / 2), Math.floor((h - short) / 2), short];
  const px = (n: number) => (n < 0 ? Number.MAX_SAFE_INTEGER : n);
  const size = Math.min(Math.max(px(crop.size), 1), short);
  return [Math.min(px(crop.x), w - size), Math.min(px(crop.y), h - size), size];
}

/** An 8-bit, non-interlaced PNG's pixels, as Bun.Image writes one: grey, grey+alpha, RGB or RGBA. */
function pngPixels(png: Uint8Array): { width: number; height: number; channels: number; pixels: Uint8Array } {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let at = 8;
  let width = 0;
  let height = 0;
  let colour = 0;
  const idat: Uint8Array[] = [];
  while (at + 8 <= png.length) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...png.subarray(at + 4, at + 8));
    const data = png.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = view.getUint32(at + 8);
      height = view.getUint32(at + 12);
      if (data[8] !== 8 || data[12] !== 0) throw unusable("it doesn't decode");
      colour = data[9] ?? 0;
    } else if (type === "IDAT") idat.push(data);
    at += 12 + length;
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colour];
  if (channels === undefined) throw unusable("it doesn't decode");
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const pixels = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const row = pixels.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : undefined;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? row[i - channels]! : 0;
      const up = prev ? prev[i]! : 0;
      const c = prev && i >= channels ? prev[i - channels]! : 0;
      let v = line[i]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += up;
      else if (filter === 3) v += (a + up) >> 1;
      else if (filter === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? up : c;
      }
      row[i] = v & 0xff;
    }
  }
  return { width, height, channels, pixels };
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** An RGB PNG of `pixels`, for Bun.Image to resize and encode. */
function rgbPng(width: number, height: number, rgb: Uint8Array): Uint8Array {
  const raw = new Uint8Array(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) raw.set(rgb.subarray(y * width * 3, (y + 1) * width * 3), y * (width * 3 + 1) + 1);
  const chunk = (type: string, data: Uint8Array) => {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
    return out;
  };
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 1 })), chunk("IEND", new Uint8Array())]);
}

/**
 * The picture as the hub keeps it (avatar.rs `render`): decoded, turned upright, cropped, at most AVATAR_PX a side,
 * on white where it was transparent, and a JPEG of at most AVATAR_MAX_BYTES with no metadata.
 */
export async function render(bytes: Uint8Array, crop: AvatarCrop | undefined): Promise<Uint8Array> {
  const open = () => new Bun.Image(bytes, { maxPixels: SOURCE_MAX_PIXELS, autoOrient: true });
  let meta: { width: number; height: number; format: string };
  try {
    meta = await open().metadata();
  } catch (error) {
    throw unusable((error as Error).message || "it doesn't decode");
  }
  if (meta.format !== "png" && meta.format !== "jpeg" && meta.format !== "webp") throw unusable("it isn't a png, jpeg or webp image");
  if (meta.width > SOURCE_MAX_PX || meta.height > SOURCE_MAX_PX) throw unusable(`it is over ${SOURCE_MAX_PX} pixels a side`);
  let decoded: ReturnType<typeof pngPixels>;
  try {
    decoded = pngPixels(await open().png({ compressionLevel: 0 }).bytes());
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw unusable((error as Error).message || "it doesn't decode");
  }
  const { width: w, height: h, channels, pixels } = decoded;
  if (w === 0 || h === 0) throw unusable("it is empty");
  const [x, y, size] = square(w, h, crop);
  // Cropped, and laid on white where it was clear: a JPEG has no transparency.
  const rgb = new Uint8Array(size * size * 3);
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const from = ((y + row) * w + (x + col)) * channels;
      const to = (row * size + col) * 3;
      const grey = channels <= 2;
      const alpha = channels === 2 ? pixels[from + 1]! : channels === 4 ? pixels[from + 3]! : 255;
      for (let k = 0; k < 3; k++) {
        const c = pixels[from + (grey ? 0 : k)]!;
        rgb[to + k] = Math.floor((c * alpha + 255 * (255 - alpha)) / 255);
      }
    }
  }
  const kept = () => {
    const image = new Bun.Image(rgbPng(size, size, rgb));
    return size > AVATAR_PX ? image.resize(AVATAR_PX, AVATAR_PX, { fit: "fill", filter: "lanczos3" }) : image;
  };
  for (const quality of QUALITIES) {
    const out = await kept().jpeg({ quality }).bytes();
    if (out.length <= AVATAR_MAX_BYTES) return out;
  }
  throw unusable("it doesn't shrink small enough");
}

/**
 * `project_avatar_set` (avatar.rs `set`): the uploaded picture rendered and kept, its upload forgotten at once; no
 * attachment removes the picture. Either way a `project.settings` event sends every open app back for a snapshot.
 */
export async function set(hub: Hub, caller: Caller, input: ProjectAvatarSetInput): Promise<{ project: ProjectSummary }> {
  const r = { machineId: input.machineId, projectId: input.projectId };
  requireRole(caller, "operate", r.machineId);
  if (!store(hub).projectGet(r)) throw unknownProject(r);
  let kept: string | undefined;
  if (input.attachmentId !== undefined) {
    const { bytes } = await take(hub, caller, input.attachmentId);
    const jpeg = await render(bytes, input.crop);
    kept = new Bun.CryptoHasher("sha256").update(jpeg).digest("hex").slice(0, 16);
    hub.db.conn
      .query(
        `INSERT INTO project_avatars (machine_id, project_id, avatar, jpeg, set_ms) VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT (machine_id, project_id) DO UPDATE SET avatar = excluded.avatar, jpeg = excluded.jpeg,
                       set_ms = excluded.set_ms`,
      )
      .run(r.machineId, r.projectId, kept, jpeg, hub.clock.now());
  } else {
    hub.db.conn.query("DELETE FROM project_avatars WHERE machine_id = ?1 AND project_id = ?2").run(r.machineId, r.projectId);
  }
  const project = store(hub).projectGet(r);
  if (!project) throw unknownProject(r);
  events(hub).append({
    at: isoMs(hub.clock.now()),
    type: "project.settings",
    machineId: r.machineId,
    projectId: r.projectId,
    summary: kept !== undefined ? `${project.title} has a new picture` : `${project.title}'s picture removed`,
    data: { avatar: kept ?? null },
  });
  return { project };
}
