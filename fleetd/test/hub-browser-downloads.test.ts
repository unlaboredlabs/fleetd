// A screen's downloads: the node lists them with the session, the hub keeps them across reports, and a person puts one
// in the bot's chat (browser_download_send), read from the screen's machine and posted as the lead's file card.
import { afterEach, expect, test } from "bun:test";
import { start as startBrowser } from "../src/hub/browser/loops.ts";
import { get } from "../src/hub/browser/store.ts";
import { chat } from "../src/hub/chat/index.ts";
import { executors, type HubToNodeSession } from "../src/hub/executor/index.ts";
import { addMachine, addProject, agent, caller, testHub } from "./screens_helpers.ts";

const S1 = "B11111111111111111111111111111111";
const PDF = new TextEncoder().encode("%PDF-1.7 a dummy PDF file, long enough for a few pieces");
let t: ReturnType<typeof testHub>;
afterEach(() => t?.done());

const report = (state: string, extra: Record<string, unknown> = {}) => ({
  op: "browser_session",
  sessionId: S1,
  threadId: "t1",
  purpose: "Read the Web browser article",
  state,
  control: "agent",
  startedAt: "2026-11-26T12:00:00.000Z",
  ...extra,
});
const dummy = { name: "dummy.pdf", bytes: PDF.length, at: "2026-11-26T12:01:00.000Z" };

/** The screen's machine: it answers `read_download` from `files` (16 bytes a piece), the reads in `reads`. */
function fakeNode(files: Record<string, Uint8Array | string>) {
  const reads: string[] = [];
  const ex = executors(t.hub);
  ex.attach("devbox", {
    linkId: 1,
    send(frame: HubToNodeSession) {
      const call = frame.call;
      let result: unknown = { ok: { kind: "done" } };
      if (call.op === "read_download") {
        reads.push(`${call.sessionId}:${call.name}:${call.offset ?? 0}`);
        const f = files[call.name];
        if (f === undefined || typeof f === "string") result = { err: { code: "invalid", message: f ?? `${call.name} is no download of screen ${call.sessionId}` } };
        else {
          const at = call.offset ?? 0;
          result = { ok: { kind: "image", name: call.name, mime: "application/pdf", bytes: f.length, dataB64: Buffer.from(f.subarray(at, at + 16)).toString("base64") } };
        }
      }
      queueMicrotask(() => ex.handleFrame("devbox", { t: "session_reply", id: frame.id, result } as never));
    },
  });
  return reads;
}

function setup() {
  t = testHub();
  startBrowser(t.hub);
  addMachine(t.hub, "devbox");
  addProject(t.hub, "devbox", "p1");
  t.link.link("devbox", ["browser", "session_end"]);
  return t;
}

/** The call's answer: its output, or its error. */
const send = async (who = caller("operate", { kind: "human" }), name = "dummy.pdf") =>
  (await t.tools.call(t.hub, who, "browser_download_send", { sessionId: S1, name })) as { output?: unknown; error?: unknown };

test("a session's downloads are kept across the node's reports, the ones it leaves out too", async () => {
  setup();
  const who = agent("devbox", "p1");
  await t.calls.call(who, report("live", { downloads: [dummy] }));
  expect(get(t.hub, S1)?.downloads).toEqual([dummy]);
  // The end's report names none (a node that took the session over): the list stays; a new one joins it.
  const later = { name: "report.csv", bytes: 9, at: "2026-11-26T12:02:00.000Z" };
  await t.calls.call(who, report("uploading", { endedAt: "2026-11-26T12:03:00.000Z", downloads: [later] }));
  expect(get(t.hub, S1)?.downloads).toEqual([dummy, later]);
  await t.calls.call(who, report("lost", { endedAt: "2026-11-26T12:03:00.000Z", note: "no upload" }));
  expect(get(t.hub, S1)?.downloads).toEqual([dummy, later]);
});

test("a person puts a download in the chat: read from the screen's machine in pieces, posted as the lead's file card", async () => {
  setup();
  await t.calls.call(agent("devbox", "p1"), report("live", { downloads: [dummy] }));
  const reads = fakeNode({ "dummy.pdf": PDF });
  const out = await send();
  expect(out.error).toBeUndefined();
  const { attachmentId, messageId } = out.output as { attachmentId: string; messageId: string };
  expect(attachmentId).toMatch(/^F\d+$/u);
  expect(reads).toEqual([`${S1}:dummy.pdf:0`, `${S1}:dummy.pdf:16`, `${S1}:dummy.pdf:32`, `${S1}:dummy.pdf:48`]);
  const message = chat(t.hub).page({ machineId: "devbox", projectId: "p1" }, undefined, undefined, 50).messages.find((m) => m.messageId === messageId);
  expect(message?.author).toBe("lead");
  expect(message?.text).toContain("Downloaded on the screen “Read the Web browser article”");
  expect(message?.parts?.find((p) => p.block)?.block).toMatchObject({ kind: "file", attachmentId, name: "dummy.pdf", mime: "application/pdf", bytes: PDF.length });
});

test("only a listed download, by a person who may operate the machine; a file its machine no longer has says so", async () => {
  setup();
  await t.calls.call(agent("devbox", "p1"), report("live", { downloads: [dummy, { name: "gone.pdf", bytes: 3, at: dummy.at }] }));
  fakeNode({ "dummy.pdf": PDF, "gone.pdf": "gone.pdf is not readable here: no such file" });
  expect((await send(caller("operate", { kind: "human" }), "other.pdf")).error).toMatchObject({ error: { code: "not_found" } });
  expect((await send(caller("read", { kind: "human" }))).error).toMatchObject({ error: { code: "forbidden" } });
  expect((await send(caller("operate"))).error).toMatchObject({ error: { code: "forbidden" } });
  expect((await send(caller("operate", { kind: "human", machines: ["elsewhere"] }))).error).toMatchObject({ error: { code: "not_found" } });
  const gone = await send(caller("operate", { kind: "human" }), "gone.pdf");
  expect(gone.error).toMatchObject({ error: { code: "invalid", message: "gone.pdf is not readable here: no such file" } });
});
