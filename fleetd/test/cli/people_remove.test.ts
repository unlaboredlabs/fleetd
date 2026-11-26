// `fleetd people remove` takes the app's way (hub/people/leave.ts): the person's devices are signed out, their Claude
// subscription forgotten, and a question waiting on them in a chat waits on the owner, as person_remove does.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { peopleCommand } from "../../src/cli/people.ts";
import { Hub } from "../../src/hub/api/hub.ts";
import { chat } from "../../src/hub/chat/index.ts";
import { accounts } from "../../src/hub/claude_accounts/tools.ts";
import { people } from "../../src/hub/people/store.ts";
import { HubDb } from "../../src/hub/store/db.ts";
import { start as chatLoops } from "../../src/hub/chat/loops.ts";
import { events, followOthers } from "../../src/hub/store/events.ts";
import { tempHome } from "../helpers.ts";

test("people remove hands what waited on them to the owner and forgets their subscription, as the app does", async () => {
  const tmp = tempHome();
  try {
    const home = join(tmp.dir, "hub");
    const open = () => new Hub({ home, listen: { host: "127.0.0.1", port: 4790 } }, HubDb.open(home), { now: () => Date.now() });
    const before = open();
    const owner = people(before).ensureOwner();
    const dana = people(before).create("Dana Park", "member");
    const r = { machineId: "devbox", projectId: "p1" };
    const question = chat(before).add(r, { author: "lead", text: "Resize them on upload, or lazy-load them?", for: { personId: dana.personId, name: dana.name } }).message;
    accounts(before).putSubscription(dana.personId, { sealedOn: [{ machineId: "devbox", fingerprint: "ab12cd34" }], connectedAt: "2026-11-08T10:00:00.000Z" });
    before.db.conn.close();

    const out = await peopleCommand(["remove", dana.personId], home);
    expect(out).toMatchObject({ code: 0 });

    const after = open();
    const messages = chat(after).page(r, undefined, undefined, 50).messages;
    expect(messages.find((m) => m.messageId === question.messageId)?.for).toEqual({ personId: owner.personId, name: owner.name });
    expect(messages.at(-1)?.text).toBe(`Dana Park was removed from the workspace, so what waited on them waits on ${owner.name} now.`);
    expect(accounts(after).subscription(dana.personId)).toBeUndefined();
    expect(people(after).get(dana.personId)?.removedAt).toBeDefined();
    // Gone already: said, not removed twice.
    expect(await peopleCommand(["remove", dana.personId], home)).toMatchObject({ code: 1 });
    after.db.conn.close();
  } finally {
    tmp.done();
  }
});

test("a running workspace hears of a removal from the terminal at once: its waiting-on-you and its apps", async () => {
  const tmp = tempHome();
  try {
    const home = join(tmp.dir, "hub");
    const running = new Hub({ home, listen: { host: "127.0.0.1", port: 4790 } }, HubDb.open(home), { now: () => Date.now() });
    const owner = people(running).ensureOwner();
    const dana = people(running).create("Dana Park", "member");
    const r = { machineId: "devbox", projectId: "p1" };
    chat(running).add(r, { author: "lead", text: "Resize them on upload, or lazy-load them?", for: { personId: dana.personId, name: dana.name } });
    chatLoops(running);
    followOthers(running);
    // What the running workspace says now, kept in its memory.
    expect(chat(running).state(r, false)).toMatchObject({ needsYou: true, needsYouFor: [dana.personId] });
    const heard: string[] = [];
    events(running).subscribe((e) => heard.push(e.type));

    expect(await peopleCommand(["remove", dana.personId], home)).toMatchObject({ code: 0 });

    // Within its next look (a second), it delivers the terminal's events and reads the chat again.
    const end = Date.now() + 5_000;
    while (!heard.includes("people.changed") && Date.now() < end) await Bun.sleep(50);
    expect(heard).toContain("people.changed");
    expect(heard).toContain("chat.waiting");
    expect(chat(running).state(r, false)).toMatchObject({ needsYou: true, needsYouFor: [owner.personId] });
    running.shutdown.abort();
    running.db.conn.close();
  } finally {
    tmp.done();
  }
});
