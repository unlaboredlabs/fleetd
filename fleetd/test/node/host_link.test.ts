import { expect, test } from "bun:test";
import { HostLink, PROTOCOL, type HostHandlers, type Registration } from "../../src/node/runner/host_link.ts";

// The link to a session host over any stream (fleetd/box/host_link): what a service with no node reads of it.
const registration: Registration = { protocol: PROTOCOL, hostPid: 0, pid: 0, marker: "m" };

async function opened(lost?: (r: Registration) => void) {
  let h!: HostHandlers;
  const wrote: string[] = [];
  const link = await HostLink.open({
    registration,
    dial: async (handlers) => {
      h = handlers;
      return { write: (data) => (wrote.push(new TextDecoder().decode(data)), data.length), end: () => h.close() };
    },
    ...(lost ? { lost } : {}),
  });
  const say = (...lines: unknown[]) => h.data(undefined, new TextEncoder().encode(lines.map((l) => `${JSON.stringify(l)}\n`).join("")));
  return { link, say, close: () => h.close(), wrote };
}

test("each event comes with the seq the host gave it, a seq already seen on the link only once", async () => {
  const { link, say, close } = await opened();
  say({ seq: 1, event: { Init: {} } }, { seq: 2, event: { AssistantText: { text: "hi" } } }, { seq: 1, event: { Init: {} } });
  expect(await link.nextWithSeq()).toEqual({ seq: 1, event: { Init: {} } });
  expect(await link.next()).toEqual({ AssistantText: { text: "hi" } });
  const waiting = link.nextWithSeq();
  say({ seq: 3, event: "Idle" });
  expect(await waiting).toEqual({ seq: 3, event: "Idle" });
  close();
  expect(await link.nextWithSeq()).toBeUndefined();
});

test("a link that drops before its session exited hands the host to `lost`; one that saw the exit doesn't", async () => {
  const lost: Registration[] = [];
  const a = await opened((r) => lost.push(r));
  a.close();
  expect(lost).toEqual([registration]);
  const b = await opened((r) => lost.push(r));
  b.say({ seq: 1, event: { Exited: { code: 0 } } });
  b.close();
  expect(lost).toHaveLength(1);
});

test("a host of another protocol, or one that didn't start claude, is refused before any dial", async () => {
  let dialled = 0;
  const dial = async () => (dialled++, { write: () => 0, end() {} });
  await expect(HostLink.open({ registration: { ...registration, protocol: PROTOCOL + 1 }, dial })).rejects.toThrow(`this node ${PROTOCOL}`);
  await expect(HostLink.open({ registration: { ...registration, refused: { message: "no claude", missing: true } }, dial })).rejects.toThrow("no claude");
  expect(dialled).toBe(0);
});
