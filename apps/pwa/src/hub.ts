import type { AppClientMessage, AppServerMessage, FleetStatus, HubEvent } from "@fleetd/contracts";
import type { Conn } from "./inbox.ts";

// The hub's /app WebSocket on this origin: pair or auth, snapshot, stream events, and call tools.

/** The hub closes a connection whose key it refused with this code (CLOSE_UNAUTHORIZED in the hub). */
const CLOSE_UNAUTHORIZED = 4401;

export interface HubHandlers {
  readonly conn: (conn: Conn) => void;
  readonly ready: () => void;
  readonly snapshot: (status: FleetStatus) => void;
  readonly event: (event: HubEvent) => void;
  readonly paired: (key: string, keyId: string) => void;
  /** The key or pairing token was refused; the connection stays closed. */
  readonly refused: (message: string) => void;
}

export interface Hub {
  readonly call: <T>(tool: string, input: unknown) => Promise<T>;
  readonly snapshot: () => void;
  readonly events: (cursor: number) => void;
  readonly close: () => void;
}

const errorText = (error: { readonly message: string; readonly fix?: string }) =>
  error.fix === undefined ? error.message : `${error.message} ${error.fix}`;

export const appSocketUrl = () => `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/app`;

export const connectHub = (start: { readonly key: string } | { readonly pairToken: string }, on: HubHandlers): Hub => {
  let key = "key" in start ? start.key : undefined;
  let socket: WebSocket | undefined;
  let closed = false;
  let retryMs = 1000;
  let nextId = 0;
  let lastError = "The hub refused this device's key.";
  const pending = new Map<string, { resolve: (output: never) => void; reject: (error: Error) => void }>();

  const send = (message: AppClientMessage) => {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  };

  const refuse = (message: string) => {
    closed = true;
    socket?.close();
    on.refused(message);
  };

  const onMessage = (message: AppServerMessage) => {
    switch (message.t) {
      case "ready":
        retryMs = 1000;
        on.conn("live");
        return on.ready();
      case "device_paired":
        key = message.key;
        on.paired(message.key, message.keyId);
        return send({ t: "auth", key: message.key });
      case "snapshot":
        return on.snapshot(message);
      case "event":
        return on.event(message);
      case "result": {
        const call = pending.get(message.id);
        pending.delete(message.id);
        return call?.resolve(message.output as never);
      }
      case "error": {
        if (message.id !== undefined) {
          const call = pending.get(message.id);
          pending.delete(message.id);
          return call?.reject(new Error(errorText(message)));
        }
        // Unpaired: the token was refused and the hub keeps the socket open, so stop here.
        if (key === undefined) return refuse(errorText(message));
        // A refused key is followed by a 4401 close; keep the reason for it.
        lastError = errorText(message);
        return;
      }
    }
  };

  const open = () => {
    const ws = new WebSocket(appSocketUrl());
    socket = ws;
    ws.onopen = () => {
      if (key !== undefined) send({ t: "auth", key });
      else if ("pairToken" in start) send({ t: "device_pair", token: start.pairToken });
    };
    ws.onmessage = (event) => {
      if (typeof event.data === "string") onMessage(JSON.parse(event.data) as AppServerMessage);
    };
    ws.onclose = (event) => {
      for (const call of pending.values()) call.reject(new Error("Disconnected from the hub before it answered."));
      pending.clear();
      if (closed) return;
      if (event.code === CLOSE_UNAUTHORIZED) return refuse(lastError);
      on.conn("offline");
      setTimeout(() => closed || open(), retryMs);
      retryMs = Math.min(retryMs * 2, 30_000);
    };
  };
  open();

  return {
    call: <T>(tool: string, input: unknown) =>
      new Promise<T>((resolve, reject) => {
        if (socket?.readyState !== WebSocket.OPEN) return reject(new Error("Not connected to the hub."));
        const id = `c${++nextId}`;
        pending.set(id, { resolve: resolve as (output: never) => void, reject });
        send({ t: "call", id, tool, input });
      }),
    snapshot: () => send({ t: "snapshot" }),
    events: (cursor) => send({ t: "events", cursor }),
    close: () => {
      closed = true;
      socket?.close();
    },
  };
};
