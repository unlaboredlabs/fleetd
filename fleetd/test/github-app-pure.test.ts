import { expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { installedLine, jwt, newAppPage, readTest } from "../src/hub/github_app/app_rules.ts";
import { BLOCKED_TOKEN, blockedLine, UNRENEWED_TOKEN } from "../src/hub/github_app/session_rules.ts";

test("the App's JWT is RS256, issued a minute back for nine minutes, and verifies with its key", () => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const token = jwt(pem, 42, 1_000_000);
  const [head, claims, sig] = token.split(".") as [string, string, string];
  expect(JSON.parse(Buffer.from(claims, "base64url").toString())).toEqual({ iat: 999_940, exp: 1_000_540, iss: "42" });
  expect(verify("sha256", Buffer.from(`${head}.${claims}`), createPublicKey(privateKey), Buffer.from(sig, "base64url"))).toBe(true);
  expect(() => jwt("not a key", 1, 0)).toThrow("isn't PEM");
});

test("where the App is made and installed, in the words its Test says", () => {
  expect(newAppPage("https://github.com")).toBe("https://github.com/settings/apps/new");
  expect(newAppPage("https://github.com", "acme")).toBe("https://github.com/organizations/acme/settings/apps/new");
  const app = { name: "fleetd", installations: [{ account: "acme", allRepositories: false, repositoryCount: 1 }] } as never;
  expect(installedLine(app)).toBe('"fleetd" is installed on acme (1 repository), and its tokens work.');
  expect(readTest(app, ["other"], Date.parse("2026-01-01T00:00:00Z"))).toMatchObject({ ok: false, at: "2026-01-01T00:00:00.000Z" });
  expect(installedLine({ name: "fleetd" } as never)).toContain("isn't installed anywhere yet");
});

test("a token taken back from an order's agents, and what its lead hears", () => {
  expect(BLOCKED_TOKEN).not.toBe(UNRENEWED_TOKEN);
  expect(blockedLine("W3", "Sam", { kind: "disconnected" })).toStartWith("W3: Sam's GitHub is no longer connected");
  expect(blockedLine("W3", "Sam", { kind: "not_renewed", why: "rate limited" })).toContain("couldn't renew it (rate limited)");
});
