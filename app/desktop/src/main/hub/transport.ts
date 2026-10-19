/** What a connection reports. `onClose` comes exactly once, also after a failed connect (code 1006). */
export interface ConnectionEvents {
  onOpen(): void;
  onText(text: string): void;
  onClose(code: number, reason: string): void;
}

export interface Connection {
  send(text: string): void;
  close(): void;
}

/** Opens one connection to a hub's /app socket URL. The real one is a WebSocket; fixtures replay files. */
export type Transport = (url: string, events: ConnectionEvents) => Connection;

export const webSocketTransport: Transport = (url, events) => {
  const socket = new WebSocket(url);
  let closed = false;
  const close = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    events.onClose(code, reason);
  };
  socket.addEventListener("open", () => events.onOpen());
  socket.addEventListener("message", (event) => {
    const data: unknown = event.data;
    if (typeof data === "string") events.onText(data);
  });
  // An error is always followed by close; the close carries the code.
  socket.addEventListener("close", (event) => close(event.code, event.reason));
  return {
    send: (text) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    },
    close: () => {
      if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) socket.close(1000);
      close(1000, "closed by the app");
    },
  };
};
