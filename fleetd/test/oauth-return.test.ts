// fleetd's sign-in return page (shared/oauth_return.ts), as the cloud mounts it: it forwards only to a private
// plain-http workspace, always to its /oauth/callback, with the service's query as it came.
import { expect, test } from "bun:test";
import { privateHost, RETURN_PAGE, returnOrigin, returnResponse, returnState } from "../src/shared/oauth_return.ts";

const NONCE = "n0nceN0nceN0nceN0nceN0nceN0nceN0nceN0nce12";

test("only hosts a private network reaches are private", () => {
  for (const ok of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.1", "192.168.1.20", "100.104.249.49", "169.254.1.1", "[::1]", "[fd7a:115c:a1e0::1]", "[fe80::1]", "localhost", "devbox", "devbox.tail1234.ts.net", "nas.local", "box.lan", "hub.internal", "pi.home.arpa"]) {
    expect([ok, privateHost(ok)]).toEqual([ok, true]);
  }
  for (const no of ["8.8.8.8", "172.32.0.1", "100.128.0.1", "[2001:db8::1]", "example.com", "ts.net.example.com", "evil.ts.net.evil.com", "1234", ""]) {
    expect([no, privateHost(no)]).toEqual([no, false]);
  }
});

test("a return state carries the workspace's origin, and nothing but a private plain-http origin", () => {
  const st = returnState(NONCE, "http://devbox.tail1234.ts.net:4790");
  expect(st.startsWith(`${NONCE}.`)).toBe(true);
  expect(returnOrigin(st)).toBe("http://devbox.tail1234.ts.net:4790");
  expect(() => returnState(NONCE, "https://devbox.tail1234.ts.net")).toThrow();
  expect(() => returnState(NONCE, "http://example.com:4790")).toThrow();
  expect(() => returnState(NONCE, "http://user:pw@devbox:4790")).toThrow();
  const forged = (origin: string) => `${NONCE}.${Buffer.from(origin).toString("base64url")}`;
  for (const bad of [
    forged("http://evil.example.com"),
    forged("https://evil.example.com"),
    forged("http://devbox:4790/elsewhere"),
    forged("javascript:alert(1)"),
    // A second spelling of an origin isn't taken.
    forged("http://DEVBOX:4790"),
    `short.${Buffer.from("http://devbox:4790").toString("base64url")}`,
    NONCE,
    `${NONCE}.${"A".repeat(2000)}`,
  ]) {
    expect([bad.slice(0, 60), returnOrigin(bad)]).toEqual([bad.slice(0, 60), undefined]);
  }
});

test("the page forwards the browser, query as it came, to the workspace's own callback", () => {
  const st = returnState(NONCE, "http://100.104.249.49:4790");
  const q = `code=c%2B1&state=${encodeURIComponent(st)}&iss=https%3A%2F%2Fmcp.notion.com`;
  const res = returnResponse(`${RETURN_PAGE}?${q}`);
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe(`http://100.104.249.49:4790/oauth/callback?${q}`);
  expect(res.headers.get("cache-control")).toBe("no-store");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
  // A refusal from the service goes back too: the workspace says what it was.
  expect(returnResponse(`${RETURN_PAGE}?error=access_denied&state=${encodeURIComponent(st)}`).headers.get("location")).toBe(
    `http://100.104.249.49:4790/oauth/callback?error=access_denied&state=${encodeURIComponent(st)}`,
  );
});

test("the page refuses a missing or foreign state, and never shows the code", async () => {
  for (const url of [`${RETURN_PAGE}?code=secret-code`, `${RETURN_PAGE}?code=secret-code&state=${NONCE}.${Buffer.from("http://evil.example.com").toString("base64url")}`]) {
    const res = returnResponse(url);
    expect(res.status).toBe(400);
    expect(res.headers.get("location")).toBeNull();
    const html = await res.text();
    expect(html).toContain("Sign-in failed");
    expect(html).not.toContain("secret-code");
    expect(html).not.toContain("evil");
  }
});
