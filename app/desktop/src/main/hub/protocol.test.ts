import { describe, expect, it } from "vitest";
import { appUrl, backoff, parseServerFrame } from "./protocol";

describe("backoff", () => {
  it("doubles from half a second to a 30 s cap", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 7, 20].map(backoff)).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000]);
  });
});

describe("appUrl", () => {
  const url = (input: string) => {
    const r = appUrl(input);
    return r.ok ? r.url : `error: ${r.message}`;
  };

  it("takes the http and ws forms the GPUI app took", () => {
    expect(url("http://127.0.0.1:4790")).toBe("ws://127.0.0.1:4790/app");
    expect(url(" ws://hub:4790/app/ ")).toBe("ws://hub:4790/app");
    expect(url("100.1.2.3:4790")).toBe("ws://100.1.2.3:4790/app");
    expect(url("http://hub")).toBe("ws://hub/app");
    expect(url("https://hub.your-tailnet.ts.net")).toBe("wss://hub.your-tailnet.ts.net/app");
    expect(url("wss://[::1]:4790/app")).toBe("wss://[::1]:4790/app");
  });

  it("refuses other schemes and hostless URLs", () => {
    expect(url("ftp://hub")).toMatch(/^error: Use an http/u);
    expect(url("http://")).toMatch(/^error:/u);
  });
});

describe("parseServerFrame", () => {
  it("reads every frame the hub sends", () => {
    expect(parseServerFrame('{"t":"ready","protocol":1}')).toEqual({ t: "ready", protocol: 1 });
    expect(parseServerFrame('{"t":"event","seq":4,"type":"task.started","summary":"x"}')).toMatchObject({ seq: 4, summary: "x" });
    expect(parseServerFrame('{"t":"error","id":"c1","code":"forbidden","message":"No."}')).toMatchObject({ id: "c1", code: "forbidden" });
  });

  it("skips what this build can't read: not JSON, a newer hub's frame, a malformed one", () => {
    expect(parseServerFrame("not json")).toBeNull();
    expect(parseServerFrame('{"t":"hello-from-the-future"}')).toBeNull();
    expect(parseServerFrame('{"t":"snapshot"}')).toBeNull();
    expect(parseServerFrame('{"t":"event","seq":-1,"type":"x"}')).toBeNull();
  });
});
