import { expect, test } from "bun:test";
import { accountFromKey, accountKey, checkSeals, isRefusal, launchAccount, Setup } from "../src/hub/claude_accounts/setup.ts";
import { resolve } from "../src/hub/vault/fill.ts";
import { isScope, type ItemRow, quietLine, sinkEnvName } from "../src/hub/vault/item.ts";

const row = (itemId: string, label: string, meta: object = {}) => ({ itemId, label, meta }) as ItemRow;

test("an item's quiet line never shows a value, and only the four scopes are scopes", () => {
  expect(quietLine("card", { brand: "visa", last4: "4242" } as never)).toBe("Visa ••4242");
  expect(quietLine("login", { sites: ["shop.example"] } as never)).toBe("shop.example");
  expect(quietLine("env", { secret: true } as never, "API_KEY")).toBe("API_KEY · secret");
  expect(["person", "project", "order", "hub", "team"].map(isScope)).toEqual([true, true, true, true, false]);
  expect(sinkEnvName({ kind: "env", path: ".env", secretKey: "TOKEN" } as never)).toBe("sink:env:TOKEN:.env");
});

test("a fill names its item by id, by a unique label, or by the 1Password reference it was imported from", () => {
  const rows = [row("V1", "Shop"), row("V2", "Mail"), row("V3", "mail"), row("V4", "Bank", { source: { kind: "1password", ref: "op://Work/Bank" } })];
  expect(resolve(rows, "V2", undefined).itemId).toBe("V2");
  expect(resolve(rows, "shop", undefined).itemId).toBe("V1");
  expect(resolve(rows, undefined, "op://Work/Bank/password").itemId).toBe("V4");
  expect(() => resolve(rows, "Mail", undefined)).toThrow("Several items are called Mail.");
  expect(() => resolve(rows, "Nope", undefined)).toThrow("No vault item Nope");
  expect(() => resolve(rows, undefined, "op://Work/Other")).toThrow("isn't in fleetd's vault yet");
});

test("a launch runs on an account the machine holds, the machine's login when none is set up, else a refusal", () => {
  expect(accountKey({ kind: "hub" })).toBe("hub");
  expect(accountFromKey("p_abcdefgh")).toEqual({ kind: "person", personId: "p_abcdefgh" });
  expect(accountFromKey("someone")).toBeUndefined();
  const none = new Setup(undefined, { membersUseHubApi: true }, new Map(), new Map(), undefined, new Map());
  expect(launchAccount(none, { hub: true }, "m1", () => "runs")).toBeUndefined();
  const api = { sealedOn: [{ machineId: "m1" }] } as never;
  const setup = new Setup(api, { membersUseHubApi: false }, new Map(), new Map(), "p_owner000", new Map([["p_member00", "member"]]));
  expect(launchAccount(setup, { hub: true }, "m1", () => "runs")).toEqual({ kind: "hub" });
  expect(isRefusal(launchAccount(setup, { hub: true }, "m1", () => "too_old"))).toBe(true);
  const member = launchAccount(setup, { person: "p_member00" }, "m1", () => "runs");
  expect(isRefusal(member) && member.message).toBe("Connect your Claude to start this order.");
});

test("a secret's seals are sealed boxes, one per machine", () => {
  const sealed = Buffer.alloc(60).toString("base64");
  expect(checkSeals([{ machineId: "m1", sealed }])).toEqual([{ machineId: "m1", sealed }]);
  expect(() => checkSeals([{ machineId: "m1", sealed }, { machineId: "m1", sealed }])).toThrow("m1 is sealed to twice.");
  expect(() => checkSeals([{ machineId: "m1", sealed: "x" }])).toThrow("each seal is");
  expect(() => checkSeals("no")).toThrow("sealed is a list");
});
