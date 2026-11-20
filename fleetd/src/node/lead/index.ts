// Lead-side CLI calls: the `fleetd` CLI and an agent's MCP server write one
// `lead_call` line to `<node home>/node.sock` and read one `lead_result` line back. The node forwards each call over
// whichever link is up under a node-chosen id, so two callers picking the same id cannot cross answers, and relays the
// hub's answer under the caller's id. A call from a session leaves the machine with its secrets masked (../mask.ts).
import { chmodSync, existsSync, lstatSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { mkdirPrivate } from "../config.ts";
import { answerLine, type LeadSocketHooks, MAX_BROWSER_FRAME_BYTES } from "./channel.ts";
import { peerPid } from "./peer.ts";

export {
  answerLine, attribute, HUB_UNREACHABLE, leadChannel, LeadRelay, NODE_OPS,
  type LeadCallFrame, type LeadResultFrame, type LeadSocketHooks, type McpToolError,
} from "./channel.ts";

export const leadSocketPath = (home: string) => join(home, "node.sock");

/** Serves the lead socket (mode 0600, in the node's 0700 home) until the returned function stops it. */
export async function serveLeadSocket(path: string, hooks: LeadSocketHooks): Promise<() => void> {
  mkdirPrivate(dirname(path));
  if (existsSync(path)) {
    if (!lstatSync(path).isSocket()) throw new Error(`${path} exists and is not a socket; move it away and start the node again`);
    const live = await Bun.connect({ unix: path, socket: { data() {} } }).then(
      (s) => (s.end(), true),
      () => false,
    );
    if (live) throw new Error(`another fleetd node is already serving ${path}; stop it first`);
    rmSync(path, { force: true });
  }
  /** One decoder per connection, streaming: a character split across two reads comes out whole. `out`: what of the
   * answer the socket hasn't taken yet. */
  type Conn = { buf: string; done: boolean; pid: number | undefined; decoder: TextDecoder; out?: Uint8Array };
  /** Writes what is left of the answer and, once all of it is out, ends the connection. Bun's sockets don't buffer: a
   * write past what the kernel takes at once returns short, and the rest goes when the socket drains. An answer past
   * the socket's buffer (a screenshot, a long `mac run` output) went cut otherwise, and its caller waited for a line
   * that never ended. */
  const flush = (socket: Bun.Socket<Conn>) => {
    const out = socket.data.out;
    if (!out) return;
    const wrote = socket.write(out);
    if (wrote < 0) {
      socket.data.out = undefined;
      return;
    }
    if (wrote < out.length) {
      socket.data.out = out.subarray(wrote);
      return;
    }
    socket.data.out = undefined;
    socket.end();
  };
  const answerWith = (socket: Bun.Socket<Conn>, frame: unknown) => {
    socket.data.out = new TextEncoder().encode(`${JSON.stringify(frame)}\n`);
    flush(socket);
  };
  const server = Bun.listen<Conn>({
    unix: path,
    socket: {
      open(socket) {
        socket.data = { buf: "", done: false, pid: peerPid((socket as unknown as { fd?: number }).fd), decoder: new TextDecoder() };
      },
      data(socket, chunk) {
        const conn = socket.data;
        if (conn.done) return;
        conn.buf += conn.decoder.decode(chunk, { stream: true });
        const nl = conn.buf.indexOf("\n");
        if (nl < 0) {
          if (conn.buf.length > MAX_BROWSER_FRAME_BYTES) {
            conn.done = true;
            answerWith(socket, { t: "lead_result", id: "invalid", error: { code: "invalid", message: `frame is larger than ${MAX_BROWSER_FRAME_BYTES} bytes` } });
          }
          return;
        }
        conn.done = true;
        respond(socket, conn.buf.slice(0, nl));
      },
      drain: flush,
      // Half-open: a caller that ends its side after writing still gets the answer.
      end(socket) {
        const conn = socket.data;
        conn.buf += conn.decoder.decode();
        if (!conn.done && conn.buf.trim()) {
          conn.done = true;
          respond(socket, conn.buf);
        }
      },
    },
  });
  const respond = (socket: Bun.Socket<Conn>, line: string) => {
    answerLine(line, socket.data.pid, hooks).then(
      (answer) => answerWith(socket, answer),
      () => socket.end(),
    );
  };
  chmodSync(path, 0o600);
  return () => {
    server.stop(true);
    rmSync(path, { force: true });
  };
}
