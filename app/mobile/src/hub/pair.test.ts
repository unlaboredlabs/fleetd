import { describe, expect, it } from "vitest";
import { pair, type Fetch } from "./pair";

const answering =
  (status: number, body: unknown, seen: Array<{ url: string; body: unknown; redirect?: RequestRedirect | undefined }> = []): Fetch =>
  async (url, init) => {
    seen.push({ url, body: JSON.parse(String(init.body)), redirect: init.redirect });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };

describe("pair", () => {
  it("trades a code for a key at the typed hub's /pair, over plain HTTP", async () => {
    const seen: Array<{ url: string; body: unknown }> = [];
    const result = await pair(answering(200, { key: "key_1", hubUrl: "http://elsewhere:4790", hubName: "devbox" }, seen), "devbox:4790", "abcd 2345", "Pixel");
    expect(result).toEqual({ ok: true, paired: { hub: "http://devbox:4790", key: "key_1", hubName: "devbox" } });
    expect(seen).toEqual([{ url: "http://devbox:4790/pair", body: { code: "ABCD-2345", deviceName: "Pixel" }, redirect: "error" }]);
  });

  it("refuses an answer from where a redirect went: the code is for the typed hub only", async () => {
    const followed: Fetch = async () => {
      const response = new Response(JSON.stringify({ key: "key_1", hubUrl: "http://evil:4790", hubName: "evil" }), { status: 200 });
      Object.defineProperty(response, "url", { value: "http://evil:4790/pair" });
      return response;
    };
    const result = await pair(followed, "http://devbox:4790", "ABCD2345", "Pixel");
    expect(result).toMatchObject({ ok: false, failure: { message: "http://devbox:4790 redirected the pairing to another address." } });
  });

  it("refuses a code that can't be one before asking the hub", async () => {
    const result = await pair(answering(200, {}), "devbox:4790", "nope", "Pixel");
    expect(result).toMatchObject({ ok: false, failure: { message: expect.stringContaining("8 letters and digits") } });
  });

  it("passes on the hub's own words", async () => {
    const result = await pair(answering(429, { code: "pair_rate_limited", message: "Too many tries.", fix: "Wait a minute." }), "http://devbox:4790", "ABCD2345", "Pixel");
    expect(result).toEqual({ ok: false, failure: { code: "pair_rate_limited", message: "Too many tries.", fix: "Wait a minute." } });
  });

  it("says plainly when the code expired or was used", async () => {
    const expired = await pair(answering(401, { code: "pair_code_expired", message: "pairing code expired", fix: "Run `fleetd pair`." }), "http://devbox:4790", "ABCD2345", "Pixel");
    expect(expired).toMatchObject({ ok: false, failure: { code: "pair_code_expired", message: "This pairing code has expired: a code works for 15 minutes." } });
    const used = await pair(answering(401, { code: "pair_code_invalid", message: "unknown or already used pairing code" }), "http://devbox:4790", "ABCD2345", "Pixel");
    expect(used).toMatchObject({ ok: false, failure: { code: "pair_code_invalid", message: "This pairing code was already used, or isn't one this hub made." } });
  });

  it("says when nothing answers", async () => {
    const down: Fetch = () => Promise.reject(new TypeError("Network request failed"));
    const result = await pair(down, "http://devbox:4790", "ABCD2345", "Pixel");
    expect(result).toMatchObject({ ok: false, failure: { message: "Can't reach http://devbox:4790." } });
  });

  it("refuses an answer that isn't a hub's", async () => {
    const result = await pair(answering(200, { hello: "world" }), "http://devbox:4790", "ABCD2345", "Pixel");
    expect(result).toMatchObject({ ok: false, failure: { message: "http://devbox:4790 answered, but not like a fleetd hub." } });
  });
});
