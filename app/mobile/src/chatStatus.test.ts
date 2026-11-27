// S9: the chat header kept "Working…" while the bot's machine was offline mid-turn.
import { describe, expect, it } from "vitest";
import { chatStatus } from "./chatStatus";

const base = { link: undefined, linkWord: undefined, working: false, machineOffline: false, waitsOnMe: false, quiet: "on devbox" };

describe("the chat header's line", () => {
  it("says the machine is offline, not Working…, while the lead was at work on it; Working… once it is back", () => {
    expect(chatStatus({ ...base, working: true, machineOffline: true })).toEqual({ text: "Machine offline", busy: false });
    expect(chatStatus({ ...base, working: true })).toEqual({ text: "Working…", busy: true });
  });

  it("keeps the link's word first, then waiting on you, else where the bot runs", () => {
    expect(chatStatus({ ...base, working: true, machineOffline: true, link: { busy: true }, linkWord: "Connecting…" })).toEqual({ text: "Connecting…", busy: false });
    expect(chatStatus({ ...base, link: { busy: false } })).toEqual({ text: "Offline", busy: false });
    expect(chatStatus({ ...base, waitsOnMe: true })).toEqual({ text: "Waiting for you", busy: false });
  });

  it("says the machine is offline while the bot is idle too, not where it runs", () => {
    // Seen on the Duo: with its machine down, a chat said "on factory-a" until a message came back with "The lead can't
    // start now: factory-a is offline."
    expect(chatStatus({ ...base, machineOffline: true })).toEqual({ text: "Machine offline", busy: false });
    // An approval still waits on you while its machine is down: the workspace holds it.
    expect(chatStatus({ ...base, machineOffline: true, waitsOnMe: true })).toEqual({ text: "Waiting for you", busy: false });
  });
});
