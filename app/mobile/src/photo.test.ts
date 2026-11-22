// A photo made fit to send: shrunk to PHOTO_SIDE on its long side, re-encoded (which drops its EXIF and GPS), and the
// picker's own on a build without the module or when it fails.
import { describe, expect, it } from "vitest";
import { fitPhoto, PHOTO_QUALITY, PHOTO_SIDE, resizeFor, type Manipulator } from "./photo";

const fake = (fails = false) => {
  const done: Array<{ uri: string; resize?: unknown; saved?: unknown }> = [];
  const m: Manipulator = {
    manipulate: (uri) => {
      const run: { uri: string; resize?: unknown; saved?: unknown } = { uri };
      done.push(run);
      return {
        resize: (size) => (run.resize = size),
        renderAsync: async () => {
          if (fails) throw new Error("no memory");
          return {
            saveAsync: async (options) => {
              run.saved = options;
              return { uri: "file:///cache/fit.jpg" };
            },
          };
        },
      };
    },
  };
  return { m, done };
};

describe("resizeFor", () => {
  it("brings the long side to PHOTO_SIDE, either way up, and leaves a small or unknown one", () => {
    expect(resizeFor(4032, 3024)).toEqual({ width: PHOTO_SIDE });
    expect(resizeFor(3024, 4032)).toEqual({ height: PHOTO_SIDE });
    expect(resizeFor(PHOTO_SIDE, 1000)).toBeUndefined();
    expect(resizeFor(undefined, 3024)).toBeUndefined();
    expect(resizeFor(0, 0)).toBeUndefined();
  });
});

describe("fitPhoto", () => {
  it("shrinks a large photo and writes it again as JPEG", async () => {
    const { m, done } = fake();
    expect(await fitPhoto({ uri: "file:///p.jpg", width: 5712, height: 4284 }, m)).toBe("file:///cache/fit.jpg");
    expect(done).toEqual([{ uri: "file:///p.jpg", resize: { width: PHOTO_SIDE }, saved: { compress: PHOTO_QUALITY, format: "jpeg" } }]);
  });

  it("writes a small one again too, so its EXIF and GPS never go up", async () => {
    const { m, done } = fake();
    expect(await fitPhoto({ uri: "file:///s.jpg", width: 1200, height: 900 }, m)).toBe("file:///cache/fit.jpg");
    expect(done[0]?.resize).toBeUndefined();
    expect(done[0]?.saved).toEqual({ compress: PHOTO_QUALITY, format: "jpeg" });
  });

  it("sends the picker's own on a build without the module, or when it fails", async () => {
    expect(await fitPhoto({ uri: "file:///p.jpg", width: 4032, height: 3024 }, null)).toBe("file:///p.jpg");
    expect(await fitPhoto({ uri: "file:///p.jpg", width: 4032, height: 3024 }, fake(true).m)).toBe("file:///p.jpg");
  });
});
