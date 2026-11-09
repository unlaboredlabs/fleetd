// The session types read the Rust node's frames (crates/fleetd-contracts/src/sessions.rs's own test, and frames from
// the Rust node's tests).
import { expect, test } from "bun:test";
import { isWindowItem, type MachineEventFrame, type SessionCallFrame, type SessionReplyFrame, type ThreadEventFrame } from "../src/shared/sessions.ts";

test("a reply is either an output or an error", () => {
  const ok: SessionReplyFrame = JSON.parse(`{"id":"c1","result":{"ok":{"kind":"sent","runId":"r2","queued":false}}}`);
  const err: SessionReplyFrame = JSON.parse(`{"id":"c1","result":{"err":{"code":"runner_unavailable","message":"claude is not logged in"}}}`);
  expect("ok" in ok.result && ok.result.ok.kind === "sent" && ok.result.ok.runId).toBe("r2");
  expect("err" in err.result && err.result.err.code).toBe("runner_unavailable");
});

test("calls, machine events and thread events carry their tag beside a newtype's fields", () => {
  const call: SessionCallFrame = {
    id: "c2",
    call: { op: "subscribe", caughtUp: true },
  };
  expect(JSON.stringify(call)).toBe(`{"id":"c2","call":{"op":"subscribe","caughtUp":true}}`);
  const machine: MachineEventFrame = JSON.parse(
    `{"seq":3,"at":"2026-10-17T10:00:00.000Z","event":{"type":"project_upserted","projectId":"app","title":"App","workspaceRoot":"/w","updatedAt":"2026-10-17T10:00:00.000Z"}}`,
  );
  expect(machine.event.type === "project_upserted" && machine.event.workspaceRoot).toBe("/w");
  const thread: ThreadEventFrame = JSON.parse(
    `{"sessionId":"s1","at":"2026-10-17T10:00:00.000Z","event":{"type":"item","id":"i1","status":"completed","title":"ls","startedAt":"a","updatedAt":"a","kind":{"type":"command","command":"ls","exitCode":0}}}`,
  );
  expect(thread.event.type === "item" && thread.event.kind.type === "command" && thread.event.kind.command).toBe("ls");
});

test("a window's item entry is the item itself, its kind the item's own (serde writes both kind keys)", () => {
  // What the Rust node's serde writes for `window`: the WindowEntry tag, then the ThreadItem's own `kind`.
  const reply: SessionReplyFrame = JSON.parse(
    `{"id":"c3","result":{"ok":{"kind":"window","entries":[{"kind":"item","id":"i1","status":"completed","title":"ls","startedAt":"a","updatedAt":"a","kind":{"type":"command","command":"ls"}},{"kind":"message","id":"m1","role":"assistant","text":"hi","createdAt":"a"}],"focus":0}}}`,
  );
  if (!("ok" in reply.result) || reply.result.ok.kind !== "window") throw new Error("not a window");
  const [item, message] = reply.result.ok.entries;
  expect(item && isWindowItem(item) && item.kind.type).toBe("command");
  expect(message && !isWindowItem(message) && message.text).toBe("hi");
});
