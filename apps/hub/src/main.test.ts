import { describe, expect, it } from "vitest";
import { parseHubArgs, parseListen } from "./main.ts";

describe("hub start arguments", () => {
  it("defaults to loopback 4790 and accepts host:port, :port, port and [v6]:port", () => {
    expect(parseHubArgs([])).toEqual({ listen: { host: "127.0.0.1", port: 4790 } });
    expect(parseHubArgs(["--home", "/x", "--listen", "0.0.0.0:4791"])).toEqual({ home: "/x", listen: { host: "0.0.0.0", port: 4791 } });
    expect(parseListen(":4792")).toEqual({ host: "127.0.0.1", port: 4792 });
    expect(parseListen("4793")).toEqual({ host: "127.0.0.1", port: 4793 });
    expect(parseListen("[::1]:4794")).toEqual({ host: "::1", port: 4794 });
  });

  it("rejects bad ports and unknown flags", () => {
    for (const bad of ["nope", "host:", "host:0", "host:65536", "host:12ab"]) expect(parseListen(bad)).toBeUndefined();
    expect(parseHubArgs(["--listen", "x:y"])).toEqual({ error: "--listen must be host:port, got 'x:y'" });
    expect(parseHubArgs(["--nope"])).toHaveProperty("error");
  });
});
