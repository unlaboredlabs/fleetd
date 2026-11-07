// The real transport: React Native's WebSocket. Text frames, and Binary ones a hub that offers compression sends.
import type { Transport } from "./client";

export const webSocketTransport: Transport = (url, events) => {
  const socket = new WebSocket(url);
  socket.binaryType = "arraybuffer";
  let closed = false;
  const close = (code: number, reason: string) => {
    if (closed) return;
    closed = true;
    events.onClose(code, reason);
  };
  socket.onopen = () => events.onOpen();
  socket.onmessage = (e: MessageEvent) => {
    if (typeof e.data === "string") events.onText(e.data);
    else if (e.data instanceof ArrayBuffer) events.onBinary(e.data);
  };
  // An error is followed by close, which carries the code.
  socket.onclose = (e: CloseEvent) => close(e.code, e.reason);
  return {
    send: (text) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(text);
    },
    close: () => {
      socket.close();
      close(1006, "closed by the app");
    },
  };
};
