// A chat's file opened on this computer: main reads it from the hub, writes it under a name of its type in a folder of
// its own, and opens that; a hub that can't give it, or an app that won't open it, says why. A picture's download
// button saves the hub's own bytes to the Downloads folder, never over a file there, and a write that fails says why;
// Copy image puts it on the clipboard as a PNG.
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { afterAll, afterEach, expect, it, vi } from "vitest";

const opened: string[] = [];
let openFails = "";
const shown: string[] = [];
/** What was put on the clipboard: each item's types and bytes. */
const copied: Array<Record<string, Buffer>> = [];
/** The pictures main decodes, by their bytes as text; any other is one it can't. */
const DECODES: Record<string, string> = { "jpeg bytes": "png of the jpeg" };
vi.mock("electron", () => ({
  app: { getPath: () => "/nowhere" },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showSaveDialog: vi.fn() },
  shell: {
    openPath: (path: string) => {
      opened.push(path);
      return Promise.resolve(openFails);
    },
    showItemInFolder: (path: string) => void shown.push(path),
  },
  ClipboardItem: class {
    constructor(readonly items: Record<string, Blob>) {}
  },
  clipboard: {
    write: async (items: ReadonlyArray<{ items: Record<string, Blob> }>) => {
      for (const item of items) {
        const entries = await Promise.all(Object.entries(item.items).map(async ([type, blob]) => [type, Buffer.from(await blob.arrayBuffer())] as const));
        copied.push(Object.fromEntries(entries));
      }
    },
  },
  nativeImage: {
    createFromBuffer: (bytes: Buffer) => {
      const png = DECODES[bytes.toString()];
      return { isEmpty: () => png === undefined, toPNG: () => Buffer.from(png ?? "") };
    },
  },
}));

const { copyImage, downloadFile, openFile, showDownloaded } = await import("./files");
const { READ_PIECE_BYTES } = await import("../shared/transfer");

const request = { projectRef: { machineId: "devbox", projectId: "ivy" }, attachmentId: "F7" };
const dir = mkdtempSync(join(tmpdir(), "fleetd-files-test-"));

afterEach(() => {
  opened.length = 0;
  shown.length = 0;
  copied.length = 0;
  openFails = "";
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

it("writes the file under a name of its type and opens it", async () => {
  const asked: unknown[] = [];
  const call = (tool: string, input: unknown) => {
    asked.push([tool, input]);
    return Promise.resolve({ ok: true as const, output: { name: "run.command", mime: "text/plain", dataB64: Buffer.from("echo hi").toString("base64") } });
  };
  expect(await openFile(call, request, dir)).toEqual({ ok: true });
  // From its start, in pieces: a hub that sends no offset sent it whole.
  expect(asked).toEqual([["attachment_get", { ...request, offset: 0, length: READ_PIECE_BYTES }]]);
  expect(opened).toHaveLength(1);
  const path = opened[0] ?? "";
  expect(basename(path)).toBe("run.command.txt");
  expect(dirname(dirname(path))).toBe(join(dir, "fleetd-files"));
  expect(readFileSync(path, "utf8")).toBe("echo hi");
});

it("says why when the hub can't give it or nothing opens it", async () => {
  const refused = () => Promise.resolve({ ok: false as const, error: { code: "not_found", message: "No attachment F7 in this project." } });
  expect(await openFile(refused, request, dir)).toEqual({ ok: false, message: "The file couldn't be read: No attachment F7 in this project." });
  openFails = "No application knows how to open it";
  const pdf = () => Promise.resolve({ ok: true as const, output: { name: "plan.pdf", mime: "application/pdf", dataB64: "JVBERi0=" } });
  expect(await openFile(pdf, request, dir)).toEqual({ ok: false, message: "plan.pdf didn't open: No application knows how to open it" });
});

it("opens a script as text, never as itself", async () => {
  const py = () => Promise.resolve({ ok: true as const, output: { name: "tool.py", mime: "text/plain", dataB64: Buffer.from("print(1)").toString("base64") } });
  expect(await openFile(py, request, dir)).toEqual({ ok: true });
  expect(basename(opened[0] ?? "")).toBe("tool.py.txt");
});

const hubFile = (name: string, mime: string, bytes: Buffer) => () => Promise.resolve({ ok: true as const, output: { name, mime, bytes: bytes.length, dataB64: bytes.toString("base64") } });

it("downloads the hub's own bytes to the folder under the picture's name", async () => {
  const downloads = join(dir, "downloads-own");
  // Bytes no image has: what is written is what the hub sent, never a picture made again from it.
  const bytes = randomBytes(5000);
  const asked: unknown[] = [];
  const call = (tool: string, input: unknown) => {
    asked.push([tool, input]);
    return hubFile("pebble.png", "image/png", bytes)();
  };
  const out = await downloadFile(call, request, downloads);
  expect(out).toEqual({ ok: true, path: join(downloads, "pebble.png"), name: "pebble.png" });
  expect(readFileSync(join(downloads, "pebble.png")).equals(bytes)).toBe(true);
  // The file itself, from its start: no preview's side.
  expect(asked).toEqual([["attachment_get", { ...request, offset: 0, length: READ_PIECE_BYTES }]]);
});

it("joins a picture the hub sends in pieces into the same bytes", async () => {
  const downloads = join(dir, "downloads-pieces");
  const bytes = randomBytes(READ_PIECE_BYTES * 2 + 77);
  const call = (_tool: string, input: unknown) => {
    const { offset, length } = input as { offset: number; length: number };
    return Promise.resolve({ ok: true as const, output: { name: "shot.png", mime: "image/png", bytes: bytes.length, offset, dataB64: bytes.subarray(offset, offset + length).toString("base64") } });
  };
  expect(await downloadFile(call, request, downloads)).toMatchObject({ ok: true, name: "shot.png" });
  expect(readFileSync(join(downloads, "shot.png")).equals(bytes)).toBe(true);
});

it("adds a number when the name is taken, and never writes over a file", async () => {
  const downloads = join(dir, "downloads-taken");
  mkdirSync(downloads);
  writeFileSync(join(downloads, "pebble.png"), "mine");
  const call = hubFile("pebble.png", "image/png", Buffer.from("first"));
  expect(await downloadFile(call, request, downloads)).toEqual({ ok: true, path: join(downloads, "pebble (1).png"), name: "pebble (1).png" });
  expect(await downloadFile(hubFile("pebble.png", "image/png", Buffer.from("second")), request, downloads)).toMatchObject({ ok: true, name: "pebble (2).png" });
  expect(readdirSync(downloads).sort()).toEqual(["pebble (1).png", "pebble (2).png", "pebble.png"]);
  expect(readFileSync(join(downloads, "pebble.png"), "utf8")).toBe("mine");
  expect(readFileSync(join(downloads, "pebble (1).png"), "utf8")).toBe("first");
  expect(readFileSync(join(downloads, "pebble (2).png"), "utf8")).toBe("second");
});

it("says why when the write fails, and leaves nothing behind", async () => {
  const downloads = join(dir, "downloads-fails");
  // A name longer than a folder takes: the folder is there, and the write itself fails.
  const long = `${"a".repeat(300)}.png`;
  const out = await downloadFile(hubFile(long, "image/png", Buffer.from("x")), request, downloads);
  expect(out.ok ? "" : out.message).toMatch(/^The file couldn't be saved: .*ENAMETOOLONG/u);
  expect(readdirSync(downloads)).toEqual([]);
  // No folder to write in (a file stands where it would be): said too.
  writeFileSync(join(dir, "not-a-folder"), "");
  const nowhere = await downloadFile(hubFile("pebble.png", "image/png", Buffer.from("x")), request, join(dir, "not-a-folder", "downloads"));
  expect(nowhere.ok ? "" : nowhere.message).toMatch(/^The file couldn't be saved: .*(ENOTDIR|EEXIST)/u);
  // And a hub that can't give it.
  const refused = () => Promise.resolve({ ok: false as const, error: { code: "not_found", message: "No attachment F7 in this project." } });
  expect(await downloadFile(refused, request, downloads)).toEqual({ ok: false, message: "The file couldn't be read: No attachment F7 in this project." });
});

it("shows only a file it saved in its folder", async () => {
  const downloads = join(dir, "downloads-shown");
  const out = await downloadFile(hubFile("pebble.png", "image/png", Buffer.from("x")), request, downloads);
  if (!out.ok) throw new Error(out.message);
  expect(showDownloaded(out.path)).toEqual({ ok: true });
  expect(shown).toEqual([out.path]);
  expect(showDownloaded("/etc/passwd")).toEqual({ ok: false, message: "fleetd didn't save that file." });
  expect(shown).toEqual([out.path]);
});

it("copies a picture as a PNG: a PNG as it is, a JPEG decoded, and says so for one it can't decode", async () => {
  expect(await copyImage(hubFile("pebble.png", "image/png", Buffer.from("png bytes")), request)).toEqual({ ok: true });
  expect(await copyImage(hubFile("photo.jpg", "image/jpeg", Buffer.from("jpeg bytes")), request)).toEqual({ ok: true });
  expect(copied.map((c) => Object.fromEntries(Object.entries(c).map(([type, bytes]) => [type, bytes.toString()])))).toEqual([{ "image/png": "png bytes" }, { "image/png": "png of the jpeg" }]);
  expect(await copyImage(hubFile("loop.webp", "image/webp", Buffer.from("webp bytes")), request)).toEqual({ ok: false, message: "This kind of image (image/webp) can't be copied. Save it instead." });
  expect(copied).toHaveLength(2);
});
