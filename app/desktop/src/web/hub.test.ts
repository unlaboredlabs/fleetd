// The browser's WebSocket as the hub client's transport, with the socket faked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { HubClient, PING_EVERY_MS, QUIET_PING_MS, QUIET_PONG_MS } from "../main/hub/client";
import type { ConnectionEvents } from "../main/hub/link";
import type { HubFrame } from "../shared/hub";
import { browserTransport } from "./hub";

class FakeSocket {
  static readonly OPEN = 1;
  static made: FakeSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  readonly sent: string[] = [];
  closed: number | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: { code: number; reason: string }) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.made.push(this);
  }
  send(text: string) {
    this.sent.push(text);
  }
  close(code = 1000) {
    this.closed = code;
  }
  open() {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
}

const events = () => {
  const heard: string[] = [];
  const e: ConnectionEvents = {
    onOpen: () => heard.push("open"),
    onText: (text) => heard.push(`text:${text}`),
    onHeard: () => heard.push("heard"),
    onClose: (code, reason) => heard.push(`close:${String(code)}:${reason}`),
  };
  return { e, heard };
};

const transport = browserTransport(FakeSocket as unknown as typeof WebSocket);

describe("browserTransport", () => {
  it("asks for the client's features in the query, without deflate, and sends no key", () => {
    FakeSocket.made = [];
    transport("wss://app.fleetd.dev/t/t1/app", events().e, { authorization: "Bearer k", "x-fleetd-features": "deflate" });
    transport("wss://app.fleetd.dev/t/t1/app", events().e, { "x-fleetd-features": "deflate,presence" });
    expect(FakeSocket.made.map((s) => s.url)).toEqual(["wss://app.fleetd.dev/t/t1/app", "wss://app.fleetd.dev/t/t1/app?features=presence"]);
  });

  it("pings with a frame the cloud answers, since a browser can't send a WebSocket ping", () => {
    FakeSocket.made = [];
    const { e, heard } = events();
    const link = transport("wss://app.fleetd.dev/t/t1/app", e);
    const socket = FakeSocket.made[0];
    link.ping();
    expect(socket?.sent).toEqual([]);
    socket?.open();
    link.ping();
    expect(socket?.sent).toEqual(['{"t":"ping"}']);
    socket?.onmessage?.({ data: '{"t":"pong"}' });
    expect(heard).toEqual(["open", "heard", 'text:{"t":"pong"}']);
  });

  it("drops the link on a Binary frame, and reports one close only", () => {
    FakeSocket.made = [];
    const { e, heard } = events();
    transport("wss://app.fleetd.dev/t/t1/app", e);
    const socket = FakeSocket.made[0];
    socket?.open();
    socket?.onmessage?.({ data: new ArrayBuffer(4) });
    socket?.onclose?.({ code: 1003, reason: "" });
    expect(socket?.closed).toBe(1003);
    expect(heard.filter((h) => h.startsWith("close"))).toEqual(["close:1006:the hub sent a frame this page can't read"]);
  });

  it("closes at once when the client drops it, as the desktop's terminate does", () => {
    FakeSocket.made = [];
    const { e, heard } = events();
    const link = transport("wss://app.fleetd.dev/t/t1/app", e);
    link.close();
    FakeSocket.made[0]?.onclose?.({ code: 1000, reason: "" });
    expect(heard).toEqual(["close:1006:closed by the app"]);
  });
});

describe("the hub client over the browser's WebSocket", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A web client on a fake socket, opened and `ready`: what it shows, and the socket's frames from the hub. */
  const live = () => {
    vi.useFakeTimers();
    FakeSocket.made = [];
    const frames: HubFrame[] = [];
    const client = new HubClient({ hub: "https://t1.fleetd.dev", key: "", transport: transport, emit: (f) => frames.push(f), random: () => 0.5 });
    client.start();
    const socket = FakeSocket.made[0];
    if (socket === undefined) throw new Error("no socket made");
    const hub = (frame: Record<string, unknown>) => socket.onmessage?.({ data: JSON.stringify(frame) });
    socket.open();
    hub({ t: "ready", protocol: 1 });
    return { client, socket, hub, frames };
  };

  it("keeps a link whose first snapshot takes longer than the quiet ping's wait to cross a slow link", () => {
    const { client, socket, hub, frames } = live();
    // A big hub at 256 kbit/s: the snapshot is seconds on its way, the page hears nothing of it until it has all come,
    // and the quiet ping's frame waits behind it.
    vi.advanceTimersByTime(QUIET_PING_MS + QUIET_PONG_MS + 1000);
    expect(socket.sent).toContain('{"t":"ping"}');
    expect(client.state.phase).toBe("live");
    expect(socket.closed).toBeNull();
    hub({ t: "snapshot", cursor: 41, machines: [] });
    hub({ t: "pong" });
    expect(frames.filter((f) => f.t === "snapshot")).toHaveLength(1);
    expect(client.state.phase).toBe("live");
    expect(FakeSocket.made).toHaveLength(1);
  });

  it("still gives a link up within seconds when it goes quiet with nothing due, and a call's answer is waited for", () => {
    const { client, socket, hub } = live();
    hub({ t: "snapshot", cursor: 41, machines: [] });
    // A call's answer due: the steady ping judges the link, not the quiet ping.
    const answer = client.call({ tool: "chat_history", input: {} });
    vi.advanceTimersByTime(QUIET_PING_MS + QUIET_PONG_MS + 1000);
    expect(client.state.phase).toBe("live");
    const asked = JSON.parse(socket.sent.find((t) => t.includes("chat_history")) ?? "{}") as { id: string };
    hub({ t: "result", id: asked.id, output: {} });
    void answer;
    // Nothing due, and the link goes dead after traffic: found in the quiet ping's seconds, before the steady ping.
    hub({ t: "event", seq: 42, type: "task.started" });
    vi.advanceTimersByTime(QUIET_PING_MS + QUIET_PONG_MS);
    expect(QUIET_PING_MS + QUIET_PONG_MS).toBeLessThan(PING_EVERY_MS);
    expect(client.state.phase).toBe("retrying");
  });
});
