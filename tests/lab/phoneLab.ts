// `node phoneLab.ts <run dir> <host>`, run by scripts/phone-lab.sh up: a throwaway fleet for the phone app to pair with,
// the factory lab's hub, node and offline claude stand-in (factory/kit.ts) with the hub listening on `host` (the
// tailnet's address, which the agents' Mac reaches), seeded with what the app shows: four projects (two with a
// picture), chats with the person's messages and the lead's replies, and one order waiting on an approval. It writes
// <run dir>/lab.json once seeded and keeps the fleet up until SIGTERM (`phone-lab.sh down`), then stops every process
// it started by PID. No real claude runs: every lead is the stand-in, which answers new messages `lab-ok`.
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
if (runDir === undefined || host === undefined) throw new Error("usage: node phoneLab.ts <run dir> <host>");

type Rgb = readonly [number, number, number];

/** Each project's chat: the person's messages, each with the lead's reply; `picture`, the two colours of its avatar. */
const PROJECTS: ReadonlyArray<{ readonly title: string; readonly picture?: readonly [Rgb, Rgb]; readonly chat: ReadonlyArray<readonly [string, string]> }> = [
  {
    title: "inventory",
    chat: [
      [
        "Low-stock alerts fire twice for the same SKU. Can you find out why?",
        "Found it: `Stock.take` sends an alert on every call below the threshold, not only the first time stock crosses it.\n\nThe fix:\n- remember which SKUs already alerted\n- forget that once stock is topped up\n\nShall I give it to a writer?",
      ],
      ["Yes, go ahead.", "On it. A writer has the order; I'll tell you when its PR is up."],
    ],
  },
  {
    title: "storefront",
    picture: [
      [236, 174, 132],
      [196, 98, 84],
    ],
    chat: [
      [
        "How did checkout conversion do this week?",
        "Up 3.2% on last week. Most of it came from the one-page checkout that landed on Tuesday; mobile Safari is still the weakest at 41%.",
      ],
    ],
  },
  {
    title: "payments",
    picture: [
      [128, 178, 160],
      [52, 102, 110],
    ],
    chat: [["Rotate the Stripe webhook secret before Friday.", "Noted. I'll ask you for the new secret when it's time; nothing to do yet."]],
  },
  {
    title: "docs",
    chat: [["Proofread the getting started page.", "Done: two typos and a broken link to the CLI reference. PR #14 is up."]],
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
      // An order of inventory's waiting on the person: the lead's gated command, Approve or Deny in its chat.
      const workstreamId = f.workstream("Ship the low-stock alert fix.");
      const gated = f.lead("gated_run", {
        workstreamId,
        argv: ["fly", "deploy", "--app", "inventory-prod"],
        class: "irreversible",
        reason: "Ship the low-stock alert fix to production.",
      });
      check(gated.code === 0, `gated_run: ${gated.text}`);
      ok(`approval ${gated.result?.requestId} waits in inventory's chat`);

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
