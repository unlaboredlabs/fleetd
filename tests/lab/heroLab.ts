// `node heroLab.ts <run dir> <host>`: a throwaway fleet for the phone app on the landing page's hero (W847, site/README.md),
// phoneLab.ts's lab with the hero's bots and chats instead: eight bots, each in its own colour and body, storefront's
// chat about saved carts the newest. The factory lab's hub, node and offline claude stand-in (factory/kit.ts), the hub
// listening on `host` (the tailnet's address, which the agents' Mac reaches). It writes <run dir>/lab.json once seeded
// and keeps the fleet up until SIGTERM, then stops every process it started by PID. No real claude runs: every lead is
// the stand-in, which answers the seeded replies (replies.json) in order.
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { callToolWith, check, descendants, fleetdCommand, ok } from "./harness.ts";
import { MACHINE, withFactory } from "./factory/kit.ts";

const [runDir, host] = process.argv.slice(2);
if (runDir === undefined || host === undefined) throw new Error("usage: node heroLab.ts <run dir> <host>");

type Rgb = readonly [number, number, number];

/** Each project's chat: the person's messages, each with the lead's reply; its bot's colour and body (W847: the landing
 * page's hero shows these bots, so each wears its own). Seeded in order, so the last is newest, at the top of Chats. */
const PROJECTS: ReadonlyArray<{ readonly title: string; readonly color: string; readonly shape: string; readonly picture?: readonly [Rgb, Rgb]; readonly chat: ReadonlyArray<readonly [string, string]> }> = [
  {
    title: "inventory",
    color: "amber",
    shape: "toast",
    chat: [
      [
        "Low-stock alerts fire twice for the same SKU. Can you find out why?",
        "Found it: `Stock.take` sends an alert on every call below the threshold, not only the first time stock crosses it.\n\nThe fix:\n- remember which SKUs already alerted\n- forget that once stock is topped up\n\nShall I give it to a writer?",
      ],
      ["Yes, go ahead.", "On it. A writer has the order; I'll tell you when its PR is up."],
    ],
  },
  { title: "garden-sensors", color: "red", shape: "ghost", chat: [["Read the soil probe every ten minutes.", "Done: the probe reads every ten minutes now, and #9 is merged."]] },
  { title: "docs", color: "green", shape: "kitty", chat: [["Proofread the getting started page.", "Done: two typos and a broken link to the CLI reference. PR #14 is up."]] },
  { title: "payments", color: "pink", shape: "pebble", chat: [["Rotate the Stripe webhook secret before Friday.", "Noted. I'll ask you for the new secret when it's time; nothing to do yet."]] },
  { title: "checkout", color: "teal", shape: "ghost", chat: [["Show the store's VAT number on receipts.", "Done: #84 merged an hour ago."]] },
  { title: "billing", color: "blue", shape: "pebble", chat: [["Let customers share an invoice as a card.", "The share card is built. Two checks left, then the PR is up."]] },
  { title: "Ada", color: "purple", shape: "bunny", chat: [["Draft the release notes for 2.4.", "Drafted. One line names a customer, so it waits for your approval."]] },
  {
    title: "storefront",
    color: "orange",
    shape: "kitty",
    chat: [
      [
        "Let shoppers save their cart and pick it up on the web or the iPhone app.",
        "On it, in three parts, each with its own writer: carts saved per shopper, the web cart, and the iPhone app's cart. Each PR gets a reviewer, and the web and iPhone parts are tested on a screen first.",
      ],
      ["How's the saved cart coming along?", "#231 merged: carts are saved per shopper. The web and iPhone parts are in review, each tested on a screen first."],
      ["Land them once they're green.", "Will do. The train lands them together, and I'll tell you when they're live."],
    ],
  },
];

/** A square PNG, a diagonal blend of two colours: a project picture with no file to ship. */
const picture = ([from, to]: readonly [Rgb, Rgb], size = 256) => {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const t = (x + y) / (2 * size - 2);
      for (let c = 0; c < 3; c++) raw[y * (size * 3 + 1) + 1 + x * 3 + c] = Math.round(from[c]! + (to[c]! - from[c]!) * t);
    }
  }
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const out = Buffer.alloc(8 + data.length + 4);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(zlib.crc32(body), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
};

await withFactory(
  path.join(runDir, "fleet"),
  async (f) => {
    fs.writeFileSync(path.join(f.dir, "replies.json"), JSON.stringify(PROJECTS.flatMap((p) => p.chat)));
    // The person: a human admin key, as a paired phone's, so the chats are theirs.
    const env = { HOME: path.join(f.dir, "hub-user"), PATH: process.env.PATH ?? "", LANG: "C.UTF-8", USER: process.env.USER ?? "lab", FLEETD_HOME: f.dir };
    const keyFile = path.join(f.dir, "person.key");
    execFileSync(...fleetdCommand(["hub", "key", "create", "--human", "--name", "lab person", "--role", "admin", "--machines", "*", "--out", keyFile]), { env, stdio: "ignore" });
    const client = new Client({ name: "fleetd-phone-lab", version: "0" });
    const headers = { authorization: `Bearer ${fs.readFileSync(keyFile, "utf8").trim()}` };
    await client.connect(new StreamableHTTPClientTransport(new URL(`${f.hubUrl}/mcp`), { requestInit: { headers } }) as Transport);
    const person = callToolWith(() => client);
    const must = async (name: string, args: Record<string, unknown>) => {
      const out = await person(name, args);
      check(!out.isError, `${name}: ${JSON.stringify(out.body)}`);
      return out.body;
    };
    /** Waits for the end of the lead's turn that started after `cursor`. */
    const turnEnds = (what: string, threadId: string, cursor: number) =>
      f.waitEvent(what, 120_000, { cursor, types: ["thread.completed", "thread.failed", "thread.interrupted"], match: (e) => e.threadId === threadId });

    try {
      const machineHome = path.dirname(f.project.root);
      for (const p of PROJECTS) {
        let projectId = f.ref.projectId;
        if (p.title !== "inventory") {
          const root = path.join(machineHome, p.title);
          fs.mkdirSync(root, { recursive: true });
          fs.writeFileSync(path.join(root, "README.md"), `# ${p.title}\n`);
          const git = (...args: Array<string>) => execFileSync("git", ["-c", "user.name=lab human", "-c", "user.email=human@lab.invalid", ...args], { cwd: root, stdio: "ignore" });
          git("init", "-q", "-b", "main");
          git("add", ".");
          git("commit", "-q", "-m", "start");
          projectId = (await must("project_add", { machineId: MACHINE, path: root, title: p.title })).projectId as string;
        }
        const ref = { machineId: MACHINE, projectId };
        await must("project_settings_set", { ...ref, avatarColor: p.color, avatarShape: p.shape });
        if (p.picture !== undefined) {
          const { attachmentId } = await must("attachment_put", { name: `${p.title}.png`, mime: "image/png", dataB64: picture(p.picture).toString("base64") });
          await must("project_avatar_set", { ...ref, attachmentId });
        }
        let cursor = await f.cursor();
        const threadId = (await must("lead_start", ref)).threadId as string;
        await turnEnds(`${p.title}'s lead starts`, threadId, cursor);
        for (const [text] of p.chat) {
          cursor = await f.cursor();
          await must("chat_send", { projectRef: ref, text, clientRequestId: randomUUID() });
          await turnEnds(`${p.title}'s lead answers "${text}"`, threadId, cursor);
        }
        ok(`seeded ${p.title} (${projectId})`);
      }
      const hub = descendants(process.pid).find((p) => p.cmdline.includes("hub") && p.cmdline.includes("start"));
      const lab = { hubUrl: f.hubUrl, fleetdHome: f.dir, hubPid: hub?.pid, nodePid: f.nodePid(), pid: process.pid };
      fs.writeFileSync(path.join(runDir, "lab.json"), `${JSON.stringify(lab, null, 2)}\n`);
      ok(`phone lab up on ${f.hubUrl}`);
      await new Promise((resolve) => {
        for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const) process.once(signal, resolve);
      });
    } finally {
      await client.close().catch(() => undefined);
    }
  },
  { host },
);
