// A chat's picture read from the hub, kept in the cache folder: its uri is handed out only once the file holds it, and
// a picture the folder won't take shows from its bytes. On a fake disk, with one mounted view's hooks outside React.
import { beforeEach, describe, expect, it, vi } from "vitest";

/** The cache folder: what each file holds once written. */
const disk = new Map<string, string>();
let full = false;
vi.mock("expo-file-system", () => ({
  Paths: { cache: "file:///cache" },
  File: class {
    readonly uri: string;
    constructor(dir: string, name: string) {
      this.uri = `${dir}/${name}`;
    }
    get exists() {
      return disk.has(this.uri);
    }
    // A write on its way never lands here: only one made at once is on the disk.
    write = () => new Promise<void>(() => undefined);
    writeSync = (data: string) => {
      if (full) throw new Error("No space left on device");
      disk.set(this.uri, data);
    };
  },
}));
vi.mock("react-native", () => ({ Animated: {}, Image: {}, StyleSheet: { create: (s: unknown) => s }, Text: {}, View: {} }));
vi.mock("expo-linear-gradient", () => ({ LinearGradient: {} }));
vi.mock("./Being", () => ({ Being: {} }));
vi.mock("../theme", () => ({ useTheme: () => ({}) }));
const picture = vi.fn((_ref: unknown, _avatar: string) => Promise.resolve("AAAA"));
let state: unknown;
vi.mock("react", () => ({
  createContext: () => ({}),
  useContext: () => ({ picture }),
  useRef: (current: unknown) => ({ current }),
  useState: () => [state, (next: unknown) => (state = next)],
  useEffect: (effect: () => void) => void effect(),
}));
const { usePicture } = await import("./Avatar");

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  disk.clear();
  full = false;
  state = undefined;
});

describe("a chat's picture", () => {
  it("is on disk by the time its uri shows", async () => {
    usePicture({ machineId: "devbox", projectId: "shop", avatar: "a1" });
    await flush();
    const shown = state as { avatar: string; uri: string } | undefined;
    expect(shown?.uri).toBe("file:///cache/avatar-a1.jpg");
    expect(disk.get(shown?.uri ?? "")).toBe("AAAA");
  });

  it("shows from its bytes when the cache folder won't take it", async () => {
    full = true;
    usePicture({ machineId: "devbox", projectId: "shop", avatar: "a2" });
    await flush();
    expect(state).toEqual({ avatar: "a2", uri: "data:image/jpeg;base64,AAAA" });
  });
});
