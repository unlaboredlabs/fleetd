// A character split across two socket reads comes out whole: a host line and a lead call, each written in two pieces
// cut inside an em dash (three bytes in UTF-8), arrive as the text that was sent.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { LeadRelay, serveLeadSocket } from "../../src/node/lead/index.ts";
import { Masker } from "../../src/node/mask.ts";
import { HostLink } from "../../src/node/runner/host.ts";
import type { NodeFrame } from "../../src/node/wire.ts";
import { tempHome } from "../helpers.ts";

/** `text`'s bytes, cut one byte into its first em dash. */
function splitInDash(text: string): [Uint8Array, Uint8Array] {
  const bytes = new TextEncoder().encode(text);
  const at = bytes.indexOf(0xe2) + 1;
  return [bytes.subarray(0, at), bytes.subarray(at)];
}

test("a host line cut inside a character reaches the session service whole", async () => {
  const home = tempHome();
  try {
    const line = `${JSON.stringify({ seq: 1, event: { AssistantText: { message_id: "m1", text: "a—b “quoted” 漢字 🙂" } } })}\n`;
    const [first, second] = splitInDash(line);
    const server = Bun.listen({
      unix: join(home.dir, "sock"),
      socket: {
        async open(s) {
          s.write(first);
          s.flush();
          await Bun.sleep(50);
          s.write(second);
        },
        data() {},
      },
    });
    writeFileSync(join(home.dir, "host.json"), JSON.stringify({ protocol: 1, hostPid: process.pid, pid: process.pid, marker: "" }));
    const link = await HostLink.connect(home.dir);
    const event = (await link.next()) as { AssistantText: { text: string } };
    expect(event.AssistantText.text).toBe("a—b “quoted” 漢字 🙂");
    link.detached = true;
    server.stop(true);
  } finally {
    home.done();
  }
});

test("a lead call written in two pieces cut inside a character reaches the hub whole", async () => {
  const home = tempHome();
  try {
    const relay = new LeadRelay();
    const sent: NodeFrame[] = [];
    relay.attach((f) => {
      sent.push(f);
      queueMicrotask(() => relay.resolve({ id: String(f.id), result: { ok: true } }));
    }, []);
    const path = join(home.dir, "node.sock");
    const stop = await serveLeadSocket(path, { relay, identify: () => ({ kind: "outside" }), maskFor: () => new Masker() });
    const frame = `${JSON.stringify({ t: "lead_call", id: "x1", cwd: "/w", call: { op: "ask_lead", question: "a—b" } })}\n`;
    const [first, second] = splitInDash(frame);
    await new Promise<void>((resolve) => {
      void Bun.connect({
        unix: path,
        socket: {
          async open(s) {
            s.write(first);
            s.flush();
            await Bun.sleep(50);
            s.write(second);
          },
          data() {},
          close: () => resolve(),
        },
      });
    });
    expect(sent[0]).toMatchObject({ call: { op: "ask_lead", question: "a—b" } });
    stop();
  } finally {
    home.done();
  }
});

test("an answer past the socket's buffer reaches its caller whole", async () => {
  const home = tempHome();
  try {
    // A screenshot's or a long `mac run` output's size: far past a Unix socket's send buffer, which Bun's sockets
    // don't buffer beyond.
    const big = "x".repeat(2 << 20);
    const relay = new LeadRelay();
    relay.attach((f) => queueMicrotask(() => relay.resolve({ id: String(f.id), result: { big } })), []);
    const path = join(home.dir, "node.sock");
    const stop = await serveLeadSocket(path, { relay, identify: () => ({ kind: "outside" }), maskFor: () => new Masker() });
    const chunks: Uint8Array[] = [];
    await new Promise<void>((resolve) => {
      void Bun.connect({
        unix: path,
        socket: {
          open(s) {
            s.write(`${JSON.stringify({ t: "lead_call", id: "x1", cwd: "/w", call: { op: "fleetd_status" } })}\n`);
          },
          // Read slowly, so the node's writes fill the socket and wait for it to drain.
          async data(_s, chunk) {
            chunks.push(new Uint8Array(chunk));
            await Bun.sleep(1);
          },
          close: () => resolve(),
        },
      });
    });
    const text = new TextDecoder().decode(Buffer.concat(chunks));
    expect(text.endsWith("\n")).toBe(true);
    expect(JSON.parse(text).result.big.length).toBe(big.length);
    stop();
  } finally {
    home.done();
  }
});

test("a command past the host socket's buffer reaches the session host whole", async () => {
  const home = tempHome();
  try {
    let got = "";
    let done!: () => void;
    const whole = new Promise<void>((r) => (done = r));
    const server = Bun.listen({
      unix: join(home.dir, "sock"),
      socket: {
        // Read slowly, so the node's writes fill the socket and wait for it to drain.
        async data(_s, chunk) {
          got += new TextDecoder().decode(chunk);
          await Bun.sleep(1);
          if (got.includes("\n")) done();
        },
      },
    });
    writeFileSync(join(home.dir, "host.json"), JSON.stringify({ protocol: 1, hostPid: process.pid, pid: process.pid, marker: "" }));
    const link = await HostLink.connect(home.dir);
    // A message with a pasted image's size.
    const text = "y".repeat(2 << 20);
    expect(link.send({ UserMessage: { text } } as never)).toBe(true);
    await Promise.race([whole, Bun.sleep(10_000)]);
    const line = got.slice(0, got.indexOf("\n"));
    expect(JSON.parse(line).command.UserMessage.text.length).toBe(text.length);
    link.detached = true;
    server.stop(true);
  } finally {
    home.done();
  }
});
