// The pictures' previews on a fake disk: signing out of a team deletes that team's previews and no other hub's.
import { beforeEach, describe, expect, it, vi } from "vitest";

const disk = new Set<string>();
vi.mock("expo-file-system", () => {
  class File {
    readonly name: string;
    constructor(_dir: unknown, name: string) {
      this.name = name;
    }
    get exists() {
      return disk.has(this.name);
    }
    delete() {
      disk.delete(this.name);
    }
    write = () => {
      disk.add(this.name);
      return Promise.resolve();
    };
    textSync = () => "{}";
  }
  class Directory {
    readonly name: string;
    constructor(_root: string, name: string) {
      this.name = name;
    }
    get exists() {
      return disk.size > 0;
    }
    create() {}
    list() {
      return [...disk].map((name) => new File(this, name));
    }
    delete() {
      disk.clear();
    }
  }
  return { Paths: { cache: "/cache" }, File, Directory };
});

const { diskPreviews, forgetPreviews } = await import("./cacheStore");

const preview = { mime: "image/png", data: "", bytes: 0 } as never;

beforeEach(() => disk.clear());

describe("the pictures' previews", () => {
  it("go for the hubs signed out of, and stay for the hub still kept", () => {
    diskPreviews.save("https://acme.fleetd.dev", "a1", preview);
    diskPreviews.save("https://acme.fleetd.dev", "a2", preview);
    diskPreviews.save("https://side.fleetd.dev", "b1", preview);
    diskPreviews.save("http://devbox:4790", "c1", preview);
    expect(disk.size).toBe(4);
    forgetPreviews(["https://acme.fleetd.dev", "https://side.fleetd.dev"]);
    expect([...disk]).toHaveLength(1);
    expect([...disk][0]).toMatch(/-c1\.json$/u);
  });
});
