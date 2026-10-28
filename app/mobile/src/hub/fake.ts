// A hub on the other end of the client, for tests: records what the client sends and plays the hub's frames.
import type { ConnectionEvents, Transport } from "./client";

export interface FakeLink {
  readonly url: string;
  readonly sent: Array<Record<string, unknown>>;
  closed: boolean;
  open(): void;
  frame(frame: Record<string, unknown>): void;
  close(code: number, reason?: string): void;
}

export interface FakeHub {
  readonly transport: Transport;
  readonly links: FakeLink[];
  /** The newest link. */
  readonly link: FakeLink;
  /** Opens the newest link and answers its auth with `ready`. */
  ready(features?: string[]): FakeLink;
  /** The newest link's frames of type `t`. */
  sentOf(t: string): Array<Record<string, unknown>>;
  /** Answers the newest link's last `call` of `tool`. */
  answer(tool: string, output: unknown): void;
  fail(tool: string, code: string, message: string): void;
}

export const fakeHub = (): FakeHub => {
  const links: FakeLink[] = [];
  const transport: Transport = (url, events: ConnectionEvents) => {
    const link: FakeLink = {
      url,
      sent: [],
      closed: false,
      open: () => events.onOpen(),
      frame: (f) => events.onText(JSON.stringify(f)),
      close: (code, reason = "") => {
        if (link.closed) return;
        link.closed = true;
        events.onClose(code, reason);
      },
    };
    links.push(link);
    return {
      send: (text) => {
        if (!link.closed) link.sent.push(JSON.parse(text) as Record<string, unknown>);
      },
      close: () => link.close(1006, "closed by the app"),
    };
  };
  const newest = (): FakeLink => {
    const link = links.at(-1);
    if (link === undefined) throw new Error("no link");
    return link;
  };
  const lastCall = (tool: string) => {
    const call = newest().sent.filter((m) => m.t === "call" && m.tool === tool).at(-1);
    if (call === undefined) throw new Error(`no ${tool} call`);
    return call;
  };
  return {
    transport,
    links,
    get link() {
      return newest();
    },
    ready: (features) => {
      const link = newest();
      link.open();
      link.frame({ t: "ready", protocol: 1, version: "0.1.0", ...(features === undefined ? {} : { features }) });
      return link;
    },
    sentOf: (t) => newest().sent.filter((m) => m.t === t),
    answer: (tool, output) => newest().frame({ t: "result", id: lastCall(tool).id, output }),
    fail: (tool, code, message) => newest().frame({ t: "error", id: lastCall(tool).id, code, message }),
  };
};
