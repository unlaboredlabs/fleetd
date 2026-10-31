// @vitest-environment happy-dom
// A Navi's Telegram: the guided steps open @BotFather with the exact messages to send it, the pasted token goes to main
// to seal to the Navi's machine and is tested at once (the bot's name), Pair opens the bot's one-time link and waits for
// the Start, and once paired the bridge's status, Pause, Unpair and Remove.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TelegramBridge, TelegramGetOutput } from "../../../shared/contracts";
import type { HubFrame } from "../../../shared/hub";
import type { TelegramRequest } from "../../../shared/ipc";
import { createDataLayer, type HubApi } from "../../src/data/queries";
import { DataProvider } from "../../src/data/react";
import { UiProvider } from "../../ui";
import { TelegramSetting } from "./Telegram";
import { BOTFATHER, statusWords, stepOf, suggestedUsername } from "./telegramModel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
vi.hoisted(() => {
  (globalThis as { fleetd?: unknown }).fleetd = { platform: "linux" };
});

const AT = "2026-10-31T10:00:00.000Z";
const BOX = "Az+6kf/abi0V7SO+sn4h++sIgyPoNDAneLBDFaJf3TA=";
const TOKEN = "123456789:AAHdevboxBotTokenFromBotFather0123456";
const navi = { machineId: "devbox", projectId: "ada" };
const saved: TelegramBridge = { fingerprint: "7e1e9a00", savedAt: AT };
const bot = { id: 7001, username: "ada_fleetd_bot", name: "Ada" };
const status = { state: "connected", since: AT };

let host: HTMLDivElement;
let root: Root;
let calls: Array<{ tool: string; input: unknown }>;
let sealed: TelegramRequest[];
let opened: string[];
let current: TelegramGetOutput;
let refusing: boolean;

beforeEach(() => {
  calls = [];
  sealed = [];
  opened = [];
  refusing = false;
  vi.stubGlobal("fleetd", {
    platform: "linux",
    fixture: null,
    openExternal: (url: string) => (opened.push(url), Promise.resolve({ ok: true })),
    secret: {
      telegram: (_hub: string, request: TelegramRequest) => {
        sealed.push(request);
        current = { bridge: saved };
        return Promise.resolve({ ok: true, output: { bridge: saved } });
      },
    },
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((r) => setTimeout(r, 0)));

const render = async (output: TelegramGetOutput) => {
  current = output;
  let listener: (frame: HubFrame) => void = () => undefined;
  const hub: HubApi = {
    call: (tool, input) => {
      calls.push({ tool, input });
      if (tool === "telegram_get") return Promise.resolve({ ok: true, output: current });
      if (tool === "telegram_test" && refusing) return Promise.resolve({ ok: true, output: { error: "Telegram refused the token: it is wrong or was revoked." } });
      if (tool === "telegram_test") {
        current = { bridge: { ...saved, bot } };
        return Promise.resolve({ ok: true, output: { bot } });
      }
      if (tool === "telegram_pair") return Promise.resolve({ ok: true, output: { link: "https://t.me/ada_fleetd_bot?start=Pa1rC0de", expiresAt: AT } });
      if (tool === "telegram_pause") {
        current = { bridge: { ...saved, bot, paired: current.bridge?.paired, paused: true, status: { state: "paused", since: AT } } } as TelegramGetOutput;
        return Promise.resolve({ ok: true, output: current });
      }
      if (tool === "telegram_remove") current = {};
      return Promise.resolve({ ok: true, output: { ok: true } });
    },
    subscribe: (l) => ((listener = l), () => undefined),
    resync: () => Promise.resolve(),
    focus: () => Promise.resolve(),
    chat: () => Promise.resolve(),
  };
  await act(async () => {
    root.render(
      <UiProvider>
        <DataProvider layer={createDataLayer(hub)}>
          <TelegramSetting projectRef={navi} />
        </DataProvider>
      </UiProvider>,
    );
    await Promise.resolve();
  });
  await act(async () => {
    listener({ t: "state", state: { phase: "live", hub: "devbox:4790", protocol: 1 } });
    listener({
      t: "snapshot",
      snapshot: {
        cursor: 1,
        attention: [],
        projects: [{ machineId: "devbox", projectId: "ada", title: "Ada", kind: "assistant", workspaceRoot: "/home/devbox/navi/ada", updatedAt: AT }],
        machines: [{ machineId: "devbox", name: "devbox", nodeVersion: "1", status: "online", lastSeenAt: AT, tags: [], boxPubKey: BOX }],
      },
    } as unknown as HubFrame);
    await new Promise((r) => setTimeout(r, 0));
  });
  for (let i = 0; i < 3; i++) await settle();
};

const button = (text: string, within: ParentNode = document) => {
  const b = [...within.querySelectorAll("button")].find((x) => x.textContent.trim() === text);
  if (b === undefined) throw new Error(`no button ${text}`);
  return b;
};
const click = async (el: HTMLElement) => {
  await act(async () => {
    el.click();
    await Promise.resolve();
  });
  for (let i = 0; i < 3; i++) await settle();
};
const type = async (label: string, value: string) => {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label='${label}']`);
  if (input === null) throw new Error(`no input ${label}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await Promise.resolve();
  });
};
const sent = (tool: string) => calls.filter((c) => c.tool === tool).map((c) => c.input);

it("walks a person from @BotFather to a sealed, tested token and a one-tap pairing", async () => {
  await render({});
  // Step 1: @BotFather, with the exact messages to send it.
  await click(button("Open @BotFather"));
  expect(opened).toEqual([BOTFATHER]);
  expect(host.textContent).toContain("/newbot");
  expect(host.textContent).toContain("ada_fleetd_bot");
  // Step 2: the token goes to main to seal to the Navi's machine, then Test at once.
  await type("Bot token", TOKEN);
  await click(button("Save and test"));
  expect(sealed).toEqual([{ navi, token: TOKEN, box: { machineId: "devbox", boxPubKey: BOX } }]);
  expect(sent("telegram_test")).toEqual([{ navi }]);
  for (let i = 0; i < 2; i++) await settle();
  expect(host.querySelector("[data-step='3'] [data-telegram-bot='ada_fleetd_bot']")?.textContent).toBe("Ada@ada_fleetd_bot");
  expect(host.textContent).not.toContain(TOKEN);
  expect([...host.querySelectorAll("input")].map((i) => i.value)).not.toContain(TOKEN);
  // Step 4: Pair opens the bot's one-time link, and the page waits for the Start.
  await click(button("Pair with Telegram"));
  expect(sent("telegram_pair")).toEqual([{ navi }]);
  expect(opened).toContain("https://t.me/ada_fleetd_bot?start=Pa1rC0de");
  expect(host.querySelector("[role='status']")?.textContent).toContain("Waiting for your Start in Telegram");
});

it("lets a token Telegram refuses be replaced or removed before pairing", async () => {
  refusing = true;
  await render({ bridge: saved });
  await click(button("Test"));
  expect(host.querySelector("[role='alert']")?.textContent).toContain("refused the token");
  // Not a dead end: a field to paste another, and Cancel back.
  expect(host.querySelector("input[aria-label='Bot token']")).toBeNull();
  await click(button("Replace token", host));
  expect(host.querySelector("input[aria-label='Bot token']")).not.toBeNull();
  await click(button("Cancel", host));
  expect(host.querySelector("input[aria-label='Bot token']")).toBeNull();
  await click(button("Replace token", host));
  refusing = false;
  await type("Bot token", TOKEN);
  await click(button("Save and test"));
  expect(sealed).toEqual([{ navi, token: TOKEN, box: { machineId: "devbox", boxPubKey: BOX } }]);
  for (let i = 0; i < 2; i++) await settle();
  expect(host.querySelector("[data-step='3'] [data-telegram-bot='ada_fleetd_bot']")).not.toBeNull();
  // Or removed outright.
  await click(button("Remove", host));
  const dialog = document.querySelector("[role='dialog']");
  if (dialog === null) throw new Error("no dialog");
  await click(button("Remove", dialog));
  expect(sent("telegram_remove")).toEqual([{ navi }]);
});

it("goes back from Replace token to the paired view with Cancel", async () => {
  await render({ bridge: { ...saved, bot, paired: { userId: 42, name: "Sam Rivera", username: "samrivera", pairedAt: AT }, status } });
  await click(button("Replace token", host));
  expect(host.querySelector("input[aria-label='Bot token']")).not.toBeNull();
  await click(button("Cancel", host));
  expect(host.textContent).toContain("Answers Sam Rivera");
});

it("shows who it answers and how it stands, and pauses and removes it", async () => {
  await render({ bridge: { ...saved, bot, paired: { userId: 42, name: "Sam Rivera", username: "samrivera", pairedAt: AT }, status } });
  expect(host.textContent).toContain("Answers Sam Rivera (@samrivera) only.");
  expect(host.querySelector("[data-telegram-status]")?.textContent).toBe("Connected");
  await click(button("Pause"));
  expect(sent("telegram_pause")).toEqual([{ navi, paused: true }]);
  for (let i = 0; i < 2; i++) await settle();
  expect(host.querySelector("[data-telegram-status]")?.textContent).toBe("Paused");
  expect(button("Resume")).toBeDefined();
  await click(button("Remove", host));
  const dialog = document.querySelector("[role='dialog']");
  if (dialog === null) throw new Error("no dialog");
  expect(dialog.textContent).toContain("devbox forgets the bot's token");
  await click(button("Remove", dialog));
  expect(sent("telegram_remove")).toEqual([{ navi }]);
  for (let i = 0; i < 2; i++) await settle();
  expect(host.textContent).toContain("Open @BotFather");
});

it("names the step, the username to ask for, and what is wrong in words", () => {
  expect(stepOf(undefined)).toBe(1);
  expect(stepOf(saved)).toBe(3);
  expect(stepOf({ ...saved, bot })).toBe(4);
  expect(suggestedUsername("Ada")).toBe("ada_fleetd_bot");
  expect(suggestedUsername("Zoë's Helper!")).toBe("zoe_s_helper_fleetd_bot");
  expect(suggestedUsername("42")).toBe("navi_fleetd_bot");
  const retrying = statusWords({ ...saved, status: { state: "retrying", since: AT, error: "Telegram asked to slow down for 30 s.", retryAt: AT } }, "devbox");
  expect(retrying.tone).toBe("warning");
  expect(retrying.line).toContain("Telegram asked to slow down for 30 s. Trying again at");
  const stopped = statusWords({ ...saved, status: { state: "stopped", since: AT, error: "Telegram refused the token: it is wrong or was revoked." } }, "devbox");
  expect(stopped).toMatchObject({ tone: "danger", word: "Stopped" });
  expect(statusWords({ ...saved, offline: true }, "devbox").line).toBe("devbox is offline: nothing goes through until it's back.");
});
