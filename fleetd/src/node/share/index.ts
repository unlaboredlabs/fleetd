// A share link's streams on this machine: the workspace's `preview_dial` names a port of a link someone shared, and
// the node connects it, on its own loopback, to a stream it dials back to the workspace (`/preview/<token>`), raw
// bytes both ways until either end closes. Only the workspace decides what is shared (its links); a port the node
// itself holds for fleetd (the workspace's own, when it runs here) is refused whatever the frame says.
import net from "node:net";
import type { Node } from "../api.ts";
import { onHub } from "../browser/node.ts";

/** How much the dial-back may hold unsent before the port's socket is paused. */
const HIGH_WATER = 8 << 20;

/** The workspace's `/preview/<token>`, from its URL. */
export function dialUrl(hub: string, token: string, refused = false): string {
  const url = new URL(hub);
  url.protocol = refused ? url.protocol : url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `/preview/${token}`;
  url.search = refused ? "?refused=1" : "";
  url.hash = "";
  return url.href;
}

/** Whether `port` is the workspace's own on this machine's loopback. */
export function fleetdsOwn(hub: string, port: number): boolean {
  try {
    const u = new URL(hub);
    const own = Number(u.port || (u.protocol === "https:" ? 443 : 80));
    return own === port && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}

/** A TCP connection to `port` on loopback: 127.0.0.1, then ::1 (a dev server bound to `localhost` may take only one). */
function connectLocal(port: number): Promise<net.Socket | undefined> {
  const one = (host: string) =>
    new Promise<net.Socket | undefined>((resolve) => {
      const s = net.connect({ port, host });
      s.once("connect", () => resolve(s));
      s.once("error", () => resolve(undefined));
    });
  return one("127.0.0.1").then((s) => s ?? one("::1"));
}

/** One stream: the port's socket and the workspace's dial-back, piped until either ends. */
export async function dial(hub: string, token: string, port: number): Promise<void> {
  const socket = Number.isInteger(port) && port >= 1 && port <= 65535 && !fleetdsOwn(hub, port) ? await connectLocal(port) : undefined;
  if (!socket) {
    await fetch(dialUrl(hub, token, true)).catch(() => {});
    return;
  }
  const ws = new WebSocket(dialUrl(hub, token));
  ws.binaryType = "nodebuffer";
  let resume: Timer | undefined;
  const end = () => {
    clearInterval(resume);
    socket.destroy();
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
  };
  socket.pause();
  ws.onopen = () => socket.resume();
  ws.onmessage = (e) => socket.write(e.data as Buffer);
  ws.onclose = end;
  ws.onerror = end;
  socket.on("data", (chunk) => {
    ws.send(chunk);
    if (ws.bufferedAmount > HIGH_WATER && !resume) {
      socket.pause();
      resume = setInterval(() => {
        if (ws.bufferedAmount <= HIGH_WATER / 2) {
          clearInterval(resume);
          resume = undefined;
          socket.resume();
        }
      }, 20);
    }
  });
  socket.on("end", end);
  socket.on("close", end);
  socket.on("error", end);
}

export function start(node: Node): void {
  onHub(node, "preview_dial", (f) => {
    if (typeof f.token !== "string" || !/^[0-9a-f]{64}$/.test(f.token)) return;
    void dial(String(node.config.hub ?? ""), f.token, Number(f.port)).catch((e) => console.info(`share link stream not opened: ${(e as Error).message}`));
  });
}
