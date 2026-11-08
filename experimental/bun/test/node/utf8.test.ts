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
