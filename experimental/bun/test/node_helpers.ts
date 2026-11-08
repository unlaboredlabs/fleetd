// A node for the screens' tests: the node core's real `Node` (src/node/api.ts) on a fresh home under $TMPDIR, its
// lead relay and link stood in by the test, which answers its lead calls and delivers the hub's frames.
import { Node } from "../src/node/api.ts";
import type { LeadRelay } from "../src/node/lead/index.ts";
import type { LinkContext } from "../src/node/link/index.ts";
import { tempHome } from "./helpers.ts";

export type TestNode = {
  node: Node;
  /** The hub's side of the node's link and lead calls. */
  link: {
    sent: Record<string, unknown>[];
    calls: { op: string; args: Record<string, unknown> }[];
    /** How a test answers a lead call: its result, or a thrown ToolError. */
    answer: (op: string, args: Record<string, unknown>, threadId?: string) => Promise<Record<string, unknown>>;
    deliver(frame: { t: string } & Record<string, unknown>): void;
  };
  /** agent-mcp's side of the node's socket. */
  local: { call(op: string, call: Record<string, unknown>, thread?: string): Promise<unknown> };
  done(): void;
};

export function testNode(machineId = "devbox", config: Record<string, unknown> = {}): TestNode {
  const home = tempHome();
  const link: TestNode["link"] = {
    sent: [],
    calls: [],
    answer: async () => ({}),
    deliver(frame) {
      node.area("link").handler(frame.t)?.(frame as never, ctx);
    },
  };
  const relay = {
    async call(frame: { id: string; call: { op: string } & Record<string, unknown>; threadId?: string }) {
      const { op, ...args } = frame.call;
      link.calls.push({ op, args });
      try {
        return { id: frame.id, result: { ...(await link.answer(op, args, frame.threadId)), op } };
      } catch (e) {
        const err = e as { toJSON?: () => unknown; message: string };
        return { id: frame.id, error: err.toJSON ? err.toJSON() : { code: "failed", message: err.message } };
      }
    },
  } as unknown as LeadRelay;
  const node = new Node(home.dir, { hub: "http://127.0.0.1:1", machineId, ...config } as never, relay);
  const ctx = { send: (f: Record<string, unknown>) => link.sent.push(f) } as unknown as LinkContext;
  node.area("link").linked(ctx);
  return {
    node,
    link,
    local: {
      async call(op, call, thread) {
        const answer = await node.area("local").answer(thread ?? "", { id: op, cwd: "/", call: { ...call, op } });
        if (answer.error) {
          const e = answer.error as { code: string; message: string };
          throw Object.assign(new Error(e.message), { code: e.code });
        }
        return answer.result;
      },
    },
    done: home.done,
  };
}
