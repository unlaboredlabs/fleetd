import { describe, expect, it } from "vitest";
import { appUrl, parseServerFrame } from "./protocol";

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

describe("a hub frame, checked", () => {
  it("is read when its kind's fields are as the protocol says, and skipped otherwise", () => {
    expect(parseServerFrame('{"t":"ready","protocol":1,"features":["deflate"]}')).toMatchObject({ t: "ready" });
    expect(parseServerFrame(`{"t":"ready","protocol":1,"version":"${"x".repeat(201)}"}`)).toBeNull();
    expect(parseServerFrame(`{"t":"ready","protocol":1,"features":${JSON.stringify(Array(65).fill("f"))}}`)).toBeNull();
    expect(parseServerFrame('{"t":"snapshot","cursor":-1}')).toBeNull();
    expect(parseServerFrame('{"t":"event","seq":3,"type":"x","data":{}}')).toMatchObject({ seq: 3 });
    expect(parseServerFrame('{"t":"result","id":"c1"}')).toMatchObject({ id: "c1" });
    expect(parseServerFrame('{"t":"error","code":"x","message":"y","reason":"' + "r".repeat(65) + '"}')).toBeNull();
    expect(parseServerFrame('{"t":"live","full":"yes"}')).toBeNull();
    expect(parseServerFrame('{"t":"chat_delta","messageId":"m","offset":1.5,"append":"a"}')).toBeNull();
    expect(parseServerFrame('{"t":"browser_frame","sessionId":"s","seq":0,"jpegB64":"","width":0,"height":1,"control":"agent"}')).toBeNull();
    expect(parseServerFrame('{"t":"screen_thumb","sessionId":"s","jpegB64":"","width":1,"height":1}')).toMatchObject({ t: "screen_thumb" });
    expect(parseServerFrame('{"t":"newer_kind"}')).toBeNull();
    expect(parseServerFrame("[1]")).toBeNull();
  });
});
