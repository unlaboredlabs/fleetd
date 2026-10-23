// The desktop app offline, against a real hub (`npm run lab -- desktop-offline`; needs `pnpm build:test` in
// app/desktop). The renderer is driven through its DOM over the DevTools protocol, as a person would use it:
// 1. a project chat open with one message, and the app's disk cache written;
// 2. the hub stops: the chat stays on screen marked "Offline, as of", the banner has Retry now, and a message typed
//    now is queued;
// 3. the app quits and relaunches with the hub still down: the chat and the queued message come back from the cache;
// 4. the hub starts: the app resyncs, and the queued message reaches the hub exactly once;
// 5. a hub restart with the chat open never leaves it blank.
// One medium turn: the lead answering the queued message (the first message is a secret request, which costs none).
import fs from "node:fs";
import path from "node:path";
import { launch } from "./desktopShell.ts";
import { type Body, cli, LAB, type Lab, leadIn, MODEL, nodeSock, scrubbedEnv, seedRepo, slotPort } from "./harness.ts";

const MACHINE = "lab-a";
const REPO = path.join(LAB, "repo-offline");
/** Slot-0 DevTools port; differs mod 20 from the other lab ports and from desktopShell's. */
const DEVTOOLS = 4786;
const ASK = "Need the staging token for the offline check";
const QUEUED = "Lab run: reply with one short line. Run no commands and start no agents.";

export async function desktopOffline(lab: Lab) {
  const { check, ok, until } = lab;
  fs.mkdirSync(lab.dir, { recursive: true });
  await lab.waitLive(MACHINE);

  // A project of its own, its lead on medium.
  fs.rmSync(REPO, { recursive: true, force: true });
  fs.mkdirSync(path.join(REPO, ".fleetd"), { recursive: true });
  fs.writeFileSync(path.join(REPO, ".fleetd/policy.yaml"), `defaults:\n  model: ${MODEL}\n  effort: medium\n`);
  seedRepo(REPO, "offline");
  const projectId = await lab.addProject(MACHINE, REPO, "repo-offline");
  const ref = { machineId: MACHINE, projectId };
  const out = leadIn(REPO, { ...scrubbedEnv(), FLEETD_NODE_SOCK: nodeSock(MACHINE) })("request_secret", {
    key: "staging.token",
    sink: `env:${MACHINE}:${path.join(lab.dir, ".env")}`,
    text: ASK,
  });
  check(out.code === 0, `request_secret: ${out.text}`);

  // The app pairs a person's key; chat_send is theirs.
  const key = /fld_[a-z2-7]{20,}/u.exec(cli("hub", "key", "create", "--home", lab.hubHome, "--human", "--name", "lab-offline"))?.[0];
  check(key, "hub key create --human printed a key");
  const hub = { url: lab.hubUrl, key: key! };
  const port = slotPort(DEVTOOLS);
  const cacheFile = path.join(lab.dir, "app", "chromium", "hub-cache.json");
  const route = `#/project/${MACHINE}/${projectId}`;

  let app = await launch(lab, "app", port, hub);
  const text = (selector: string) => app.eval<string | null>(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
  const openChat = async () => {
    await app.eval(`(location.hash = ${JSON.stringify(route)}, true)`);
    await until("the chat shows the request", 30_000, async () => ((await text('[data-screen="chat"]'))?.includes(ASK) ? true : undefined));
  };
  // What the chat area showed, every 100 ms: a blank or loading chat after it first showed is the bug.
  const sample = () =>
    app.eval(`(window.__samples = [], setInterval(() => window.__samples.push(document.querySelector('[data-screen^="chat"]')?.getAttribute("data-screen") ?? "none"), 100), true)`);
  const blanks = async () => (await app.eval<Array<string>>("window.__samples")).filter((s) => s !== "chat");

  // 1.
  await openChat();
  await until("the disk cache written", 30_000, async () => (fs.existsSync(cacheFile) && fs.readFileSync(cacheFile, "utf8").includes(ASK) ? true : undefined));
  ok(`1. chat open on ${route}; the disk cache holds it (${fs.statSync(cacheFile).size} bytes)`);

  // 2.
  await sample();
  await lab.stopHub();
  const banner = await until("the offline banner", 60_000, async () => {
    const t = await text('[data-banner="reconnecting"]');
    return t?.startsWith("Offline, as of") === true ? t : undefined;
  });
  check(banner.includes("Retry now"), `the banner has Retry now: ${banner}`);
  const header = (await text('header')) ?? "";
  check(header.includes("Offline, as of"), `the chat header says offline: ${header}`);
  check((await text('[data-screen="chat"]'))?.includes(ASK) === true, "the chat stays on screen");
  await app.eval(`(() => {
    const box = document.querySelector('textarea[aria-label="Message the lead"]');
    box.focus();
    document.execCommand("insertText", false, ${JSON.stringify(QUEUED)});
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  })()`);
  await until("the message queued", 10_000, async () => ((await app.eval<number>(`document.querySelectorAll('[data-receipt="queued"]').length`)) === 1 ? true : undefined));
  await app.eval(`[...document.querySelectorAll('[data-banner="reconnecting"] button')].find((b) => b.textContent === "Retry now")?.click()`);
  await until("Retry now dialled and failed again", 30_000, async () => ((await text('[data-banner="reconnecting"]'))?.includes("Trying again") ? true : undefined));
  check((await blanks()).length === 0, `the chat never went blank while offline: ${JSON.stringify(await blanks())}`);
  ok(`2. hub stopped: "${banner.split(".")[0]}", the chat kept, one message queued, Retry now dialled at once`);

  // 3.
  await until("the queued message in the disk cache", 10_000, async () => (fs.readFileSync(cacheFile, "utf8").includes(QUEUED) ? true : undefined));
  await app.close();
  app = await launch(lab, "app", port, hub, false);
  await openChat();
  check((await app.eval<number>(`document.querySelectorAll('[data-receipt="queued"]').length`)) === 1, "the queued message came back from the cache");
  await until("the relaunched app's offline mark", 60_000, async () => ((await text('header'))?.includes("Offline, as of") ? true : undefined));
  ok("3. relaunched with no hub: the chat and the queued message came back from the disk cache, marked offline");

  // 4.
  await sample();
  await lab.startHub();
  await until("the queued message sent", 60_000, async () => ((await app.eval<number>(`document.querySelectorAll('[data-receipt="queued"], [data-receipt="pending"]').length`)) === 0 ? true : undefined));
  const history = (await lab.humanCall("chat_history", { projectRef: ref, limit: 50 })).body;
  const mine = (history.messages as Array<Body>).filter((m) => m.author === "human" && m.text === QUEUED);
  check(mine.length === 1 && typeof mine[0]?.clientRequestId === "string", `the hub holds the queued message once: ${JSON.stringify(mine)}`);
  // Connected, the chat stays marked "Last known" until it is read again, never shown as current before that.
  await until("the chat read again", 60_000, async () => {
    const header = await text('header');
    return header !== null && !header.includes("Offline") && !header.includes("Last known") ? true : undefined;
  });
  check((await blanks()).length === 0, `the chat never went blank through the reconnect: ${JSON.stringify(await blanks())}`);
  ok(`4. hub back: read again, the queued message reached it once (clientRequestId ${String(mine[0]?.clientRequestId)})`);

  // 5.
  await sample();
  await lab.startHub();
  await until("the chat live again after the restart", 60_000, async () =>
    (await app.eval<string | undefined>(`window.__frames.findLast((f) => f.t === "state")?.state.phase`)) === "live" && (await text('[data-banner="reconnecting"]')) === null ? true : undefined,
  );
  check((await text('[data-screen="chat"]'))?.includes(QUEUED) === true, "the chat still shows the conversation");
  check((await blanks()).length === 0, `the chat never went blank through the restart: ${JSON.stringify(await blanks())}`);
  const again = ((await lab.humanCall("chat_history", { projectRef: ref, limit: 50 })).body.messages as Array<Body>).filter((m) => m.author === "human" && m.text === QUEUED);
  check(again.length === 1, `still one copy after another reconnect: ${again.length}`);
  ok("5. hub restarted with the chat open: never blank, nothing sent twice");
  await app.close();
}
