// A chat's file shared from the phone, on a fake disk: it goes to a folder of its own, so a file named like one the
// app keeps in its cache (hub.json, an avatar) never takes that file's place.
import { beforeEach, expect, it, vi } from "vitest";

const written: string[] = [];
const shared: string[] = [];
const join = (parts: readonly unknown[]): string => parts.map((p) => (typeof p === "string" ? p : (p as { uri: string }).uri)).join("/");
vi.mock("expo-file-system", () => ({
  Paths: { cache: { uri: "file:///cache" } },
  Directory: class {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    create = () => undefined;
  },
  File: class {
    readonly uri: string;
    constructor(...parts: unknown[]) {
      this.uri = join(parts);
    }
    write = async () => void written.push(this.uri);
  },
}));
vi.mock("expo-crypto", () => ({ getRandomBytes: (n: number) => new Uint8Array(n).fill(0xab) }));
vi.mock("react-native", () => ({ Share: { share: async ({ url }: { url: string }) => void shared.push(url) } }));
const previewed: string[] = [];
/** What Quick Look says it shows: a file named here it can't. */
let unshowable = "";
vi.mock("expo", () => ({
  requireOptionalNativeModule: (name: string) =>
    name === "FleetdQuickLook" ? { preview: async (uri: string) => (uri.endsWith(unshowable) && unshowable !== "" ? false : (previewed.push(uri), true)) } : null,
}));

const { openFile, shareFile } = await import("./shareFile");

beforeEach(() => {
  written.length = 0;
  shared.length = 0;
  previewed.length = 0;
  unshowable = "";
});

it("opens a file in iOS's previewer, not the share sheet", async () => {
  await openFile({ name: "temps.csv", mime: "text/csv", dataB64: "YSxi" } as never);
  expect(previewed).toEqual(["file:///cache/shared/abababababababab/temps.csv"]);
  expect(shared).toEqual([]);
});

it("shares a file the previewer can't show", async () => {
  unshowable = "all.zip";
  await openFile({ name: "all.zip", mime: "application/zip", dataB64: "" } as never);
  expect(previewed).toEqual([]);
  expect(shared).toEqual(["file:///cache/shared/abababababababab/all.zip"]);
});

it("shares a file from a folder of its own, never beside the app's cache", async () => {
  await shareFile({ name: "hub.json", mime: "text/plain", dataB64: "e30=" } as never);
  expect(written).toEqual(["file:///cache/shared/abababababababab/hub.json"]);
  expect(shared).toEqual(written);
});

it("keeps the name in that folder: no path in it, nor a name that is one", async () => {
  await shareFile({ name: "../avatar-x.jpg", mime: "image/jpeg", dataB64: "" } as never);
  await shareFile({ name: "..", mime: "text/plain", dataB64: "" } as never);
  expect(written).toEqual(["file:///cache/shared/abababababababab/..-avatar-x.jpg", "file:///cache/shared/abababababababab/file"]);
});
