import { expect, test } from "bun:test";
import { DecodeError, decodeInput } from "../src/hub/api/decode.ts";
import { Registry } from "../src/hub/api/registry.ts";
import { TOOLS } from "../src/hub/api/tool_roles.ts";
import { HubDb } from "../src/hub/store/db.ts";
import { Hub } from "../src/hub/api/hub.ts";

const detail = (tool: string, input: unknown) => {
  try {
    decodeInput(tool, input);
  } catch (error) {
    if (error instanceof DecodeError) return error.message;
    throw error;
  }
  return "decoded";
};

test("every tool's input schema compiles and decodes or refuses {} in serde's words", () => {
  for (const name of Object.keys(TOOLS)) {
    const out = detail(name, {});
    expect(out === "decoded" || /^(missing field|invalid type|expected|unknown variant|data did not match)/.test(out)).toBe(true);
  }
});

test("defaults fill in, bounds and patterns refuse, unnamed fields drop", () => {
  expect(decodeInput("events_wait", {})).toEqual({ timeoutSec: 50 });
  expect(decodeInput("events_wait", { cursor: 4, extra: true, machineId: null })).toEqual({ cursor: 4, timeoutSec: 50 });
  expect(detail("events_wait", { timeoutSec: 51 })).toBe("expected an integer between 0 and 50");
  expect(detail("events_wait", { timeoutSec: 1.5 })).toBe("invalid type: floating point `1.5`, expected i64");
  expect(detail("events_wait", { machineId: "Dev Box" })).toBe('expected a string matching ^[a-z0-9-]{1,32}$, got "Dev Box"');
  expect(detail("events_wait", { types: ["machine.online", 3] })).toBe("invalid type: integer `3`, expected a string");
  expect(detail("events_list", {})).toBe("missing field `projectRef`");
  expect(detail("events_list", { projectRef: { machineId: "devbox" } })).toBe("missing field `projectId`");
  expect(detail("events_list", { projectRef: "devbox" })).toBe('invalid type: string "devbox", expected struct ProjectRef');
  expect(decodeInput("events_list", { projectRef: { machineId: "devbox", projectId: "p1" } })).toEqual({
    projectRef: { machineId: "devbox", projectId: "p1" },
    limit: 50,
  });
  const ref = { machineId: "devbox", projectId: "p1" };
  expect(detail("sidebar_order_set", { order: [ref, ref] })).toBe("expected unique items");
});

test("an internally tagged input picks its variant by tag", () => {
  expect(detail("time_spans", { scope: { kind: "nope" } })).toMatch(/^unknown variant `nope`, expected one of /);
  expect(detail("time_spans", { scope: {} })).toBe("missing field `kind`");
});

test("Registry.call answers invalid before the role check, and the handler gets the decoded input", async () => {
  const tools = new Registry();
  let got: unknown;
  tools.add("events_wait", (_hub, _caller, input) => {
    got = input;
    return { events: [], cursor: 0, more: false, next: "" } as never;
  });
  const hub = new Hub({ home: "/nonexistent", listen: { host: "127.0.0.1", port: 0 } }, HubDb.memory(), { now: () => 0 });
  const nobody = { keyId: "k", name: "n", prefix: "fld_aaaaaa", grants: [], createdAt: "2026-11-08T00:00:00.000Z" };
  expect(await tools.call(hub, nobody, "events_wait", { timeoutSec: -1 })).toEqual({
    error: { kind: "invalid", message: "expected an integer between 0 and 50" },
  });
  const reader = { ...nobody, grants: [{ role: "read" as const, machines: "*" as const }] };
  await tools.call(hub, reader, "events_wait", undefined);
  expect(got).toEqual({ timeoutSec: 50 });
});

test("a tagged variant that refs a struct keeps its tag, and an unknown tag is refused (wake_set)", () => {
  const schedule = (s: unknown) => {
    const input = { target: { machineId: "devbox", threadId: "t1" }, schedule: s, message: "wake", clientRequestId: "r1" };
    try {
      return (decodeInput("wake_set", input) as { schedule: unknown }).schedule;
    } catch (error) {
      if (error instanceof DecodeError) return error.message;
      throw error;
    }
  };
  expect(schedule({ kind: "every", everySec: 120 })).toEqual({ kind: "every", everySec: 120 });
  expect(schedule({ kind: "every", everySec: 30 })).toBe(`expected an integer between 60 and ${Number.MAX_SAFE_INTEGER}`);
  expect(schedule({ kind: "every" })).toBe("missing field `everySec`");
  expect(schedule({ kind: "bogus", everySec: 120 })).toBe("unknown variant `bogus`, expected one of `at`, `every`, `cron`");
  expect(schedule({ everySec: 120 })).toBe("missing field `kind`");
});

test("null on a defaulted field is refused, as only an Option takes null", () => {
  expect(detail("events_wait", { timeoutSec: null })).toBe("invalid type: null, expected i64");
});
