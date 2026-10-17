import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { renderJsonSchemas, schemaDir } from "../scripts/schema-json.ts";
import {
  EventsWaitInput,
  HubEvent,
  HubToNode,
  MachineId,
  NodeToHub,
  ProjectOutcome,
  SubscriptionSetInput,
  ThreadLaunchInput,
  ThreadSummary,
  ThreadTailInput,
  TimeZone,
  WakeSchedule,
  WakeSetInput,
  WebhookUrl,
} from "./index.ts";

const accepts = (schema: Schema.Top, value: unknown) => Schema.decodeUnknownResult(schema as Schema.Codec<unknown>)(value)._tag === "Success";
const at = "2026-10-17T10:00:00.000Z";

describe("MachineId", () => {
  it("accepts slugs of 1-32 [a-z0-9-]", () => {
    for (const id of ["forge", "lab-b", "a", "0", "x".repeat(32)]) expect(accepts(MachineId, id)).toBe(true);
  });
  it("rejects anything else", () => {
    for (const id of ["", "Forge", "lab_b", "lab b", "x".repeat(33), 7]) expect(accepts(MachineId, id)).toBe(false);
  });
});

describe("node link", () => {
  const fromNode = [
    {
      t: "hello",
      machineId: "lab-a",
      name: "Lab A",
      tags: ["linux"],
      nodeVersion: "0.0.0",
      protocol: 1,
      t3: { url: "http://127.0.0.1:4711", version: "2fbd4318fc", protocol: 2 },
      pubKey: "cHVi",
      sig: "c2ln",
    },
    {
      t: "hello",
      machineId: "lab-b",
      name: "Lab B",
      tags: [],
      nodeVersion: "0.0.0",
      protocol: 1,
      t3: { url: "http://127.0.0.1:4712", version: "2fbd4318fc", protocol: 2 },
      pubKey: "cHVi",
      sig: "c2ln",
      enrollToken: "tok",
    },
    { t: "hello", machineId: "lab-c", name: "Lab C", tags: [], nodeVersion: "0.0.0", protocol: 1, pubKey: "cHVi", sig: "c2ln" },
    { t: "t3session", bearer: "b", expiresAt: at },
    { t: "t3state", state: "down", reason: "healthz failed 3 times", at },
    { t: "hb", at },
  ];
  const fromHub = [
    { t: "challenge", nonce: "n" },
    { t: "welcome", hubId: "hub", protocol: 1 },
    { t: "hb", at },
  ];

  it("round-trips every frame through JSON", () => {
    for (const [union, frames] of [[NodeToHub, fromNode], [HubToNode, fromHub]] as const) {
      const codec = Schema.fromJsonString(union);
      for (const frame of frames) {
        const decoded = Schema.decodeUnknownSync(codec)(JSON.stringify(frame));
        expect(decoded.t).toBe(frame.t);
        expect(JSON.parse(Schema.encodeSync(codec)(decoded))).toEqual(frame);
      }
    }
  });

  it("rejects frames the other side sends, unknown tags and bad machine ids", () => {
    expect(accepts(NodeToHub, { t: "challenge", nonce: "n" })).toBe(false);
    expect(accepts(HubToNode, fromNode[0])).toBe(false);
    expect(accepts(NodeToHub, { t: "nope" })).toBe(false);
    expect(accepts(NodeToHub, { ...fromNode[0], machineId: "Lab A" })).toBe(false);
  });
});

describe("length limits", () => {
  const thread = {
    machineId: "forge",
    threadId: "t1",
    projectId: "p1",
    title: "t",
    status: "running",
    headline: "h",
    latestMessageTail: "",
    lastProgressAt: at,
    stale: false,
    asOf: at,
  };
  const project = {
    machineId: "forge",
    projectId: "p1",
    title: "p",
    workspaceRoot: "/w",
    threads: { running: 1, waiting: 0, idle: 0, failed: 0 },
    lastActivityAt: at,
  };

  it("caps event summaries at 200 and thread text at 280/4096", () => {
    const event = { seq: 1, at, type: "thread.completed", summary: "x".repeat(200) };
    expect(accepts(HubEvent, event)).toBe(true);
    expect(accepts(HubEvent, { ...event, summary: "x".repeat(201) })).toBe(false);
    expect(accepts(ThreadSummary, { ...thread, headline: "x".repeat(280), latestMessageTail: "x".repeat(4096) })).toBe(true);
    expect(accepts(ThreadSummary, { ...thread, headline: "x".repeat(281) })).toBe(false);
    expect(accepts(ThreadSummary, { ...thread, latestMessageTail: "x".repeat(4097) })).toBe(false);
  });

  it("caps a project outcome at 20 threads", () => {
    const outcome = { project, stale: false, asOf: at };
    expect(accepts(ProjectOutcome, { ...outcome, threads: Array(20).fill(thread) })).toBe(true);
    expect(accepts(ProjectOutcome, { ...outcome, threads: Array(21).fill(thread) })).toBe(false);
  });
});

describe("tool input defaults and bounds", () => {
  const ref = { machineId: "forge", threadId: "t1" };

  it("fills documented defaults", () => {
    expect(Schema.decodeUnknownSync(ThreadTailInput)(ref).n).toBe(10);
    expect(Schema.decodeUnknownSync(EventsWaitInput)({}).timeoutSec).toBe(50);
    const launch = { machineId: "forge", projectId: "p1", prompt: "hi", model: "claude-haiku-5-5", effort: "low", clientRequestId: "r1" };
    expect(Schema.decodeUnknownSync(ThreadLaunchInput)(launch).runtimeMode).toBe("full-access");
  });

  it("rejects values past their maximum", () => {
    expect(accepts(ThreadTailInput, { ...ref, n: 51 })).toBe(false);
    expect(accepts(EventsWaitInput, { timeoutSec: 51 })).toBe(false);
  });
});

describe("wakes", () => {
  const target = { machineId: "forge", threadId: "t1" };

  it("accepts IANA zones and refuses offsets and unknown names", () => {
    for (const tz of ["UTC", "Europe/London", "America/New_York", "Etc/GMT+5"]) expect(accepts(TimeZone, tz), tz).toBe(true);
    for (const tz of ["", "+01:00", "-05:00", "Mars/Olympus", "GMT+25", 3]) expect(accepts(TimeZone, tz), String(tz)).toBe(false);
  });

  it("requires every-schedules of at least 60 s", () => {
    expect(accepts(WakeSchedule, { kind: "every", everySec: 60 })).toBe(true);
    expect(accepts(WakeSchedule, { kind: "every", everySec: 59 })).toBe(false);
    expect(accepts(WakeSchedule, { kind: "every", everySec: 60.5 })).toBe(false);
    expect(accepts(WakeSchedule, { kind: "cron", cron: "0 9 * * 1-5", tz: "Nope/Nowhere" })).toBe(false);
  });

  it("caps the message at 4000 and fills once and catchUp", () => {
    const set = { target, schedule: { kind: "at", at, tz: "UTC" }, message: "x".repeat(4000), clientRequestId: "r1" };
    const decoded = Schema.decodeUnknownSync(WakeSetInput)(set);
    expect([decoded.once, decoded.catchUp]).toEqual([true, "fire_once"]);
    expect(accepts(WakeSetInput, { ...set, message: "x".repeat(4001) })).toBe(false);
    expect(accepts(WakeSetInput, { ...set, message: "" })).toBe(false);
  });
});

describe("subscriptions", () => {
  it("accepts only absolute http(s) URLs", () => {
    for (const url of ["http://127.0.0.1:4790/hook", "https://example.com/x?y=1"]) expect(accepts(WebhookUrl, url), url).toBe(true);
    for (const url of ["file:///etc/passwd", "ftp://example.com", "javascript:alert(1)", "/relative", "example.com", ""]) {
      expect(accepts(WebhookUrl, url), url).toBe(false);
    }
  });

  it("defaults types and machines to everything", () => {
    const decoded = Schema.decodeUnknownSync(SubscriptionSetInput)({ url: "https://example.com", clientRequestId: "r1" });
    expect([decoded.types, decoded.machines]).toEqual(["*", "*"]);
    expect(accepts(SubscriptionSetInput, { url: "https://example.com", types: ["nope"], clientRequestId: "r1" })).toBe(false);
  });
});

describe("JSON Schema export", () => {
  it("matches the committed files (run `pnpm --filter @fleetd/contracts schema:json`)", () => {
    for (const [file, text] of Object.entries(renderJsonSchemas())) {
      expect(readFileSync(`${schemaDir}${file}`, "utf8"), file).toBe(text);
    }
  });
});
