import { afterEach, describe, expect, it } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { AT, live, snapshot } from "../../src/data/fixtures.test-util";
import { applyFrame, initialState } from "../../src/data/store";
import { chatRoute, statusToggleTarget } from "./defaults";
import { projectItems } from "./projects";
import { dispatchable } from "./keymap";
import { pushRecent, rank, score } from "./rank";
import { bindLatest, commandFor, registerCommands, registerSource, runCommand, snapshotItems, type Command } from "./registry";

const item = (id: string, title: string, group: Command["group"], extra: Partial<Command> = {}): Command => ({
  id,
  title,
  group,
  run: () => undefined,
  ...extra,
});

describe("rank", () => {
  it("matches subsequences and prefers word starts and runs", () => {
    expect(score("frt", "fleet-infra")).toBeUndefined();
    expect(score("fi", "fleet-infra")).toBeDefined();
    expect(score("fle", "fleetd")).toBeGreaterThan(score("fle", "field-lead-e") ?? Infinity);
    expect(score("dn", "desktop-notify")).toBeGreaterThan(score("dn", "addon") ?? Infinity);
    expect(score("FLEET", "fleetd")).toBe(score("fleet", "fleetd"));
  });

  const items = [
    item("settings.open", "Settings", "settings"),
    item("go:settings.prompts", "Prompts for fleetd", "settings", { searchOnly: true }),
    item("project:devbox/fleetd", "fleetd", "projects"),
    item("project:devbox/storefront", "storefront", "projects", { keywords: ["shop-w14"] }),
    item("status.toggle", "Status", "go-to"),
  ];

  it("with nothing typed, lists recents first, then groups, and hides search-only items", () => {
    const ranked = rank("", items, ["project:devbox/fleetd", "gone"]);
    expect(ranked.recent.map((i) => i.id)).toEqual(["project:devbox/fleetd"]);
    expect(ranked.matches.map((i) => i.id)).toEqual(["project:devbox/storefront", "status.toggle", "settings.open"]);
  });

  it("finds by keyword, ranks the exact name first and ignores scattered letters", () => {
    expect(rank("w14", items, []).matches.map((i) => i.id)).toEqual(["project:devbox/storefront"]);
    const fleetd = rank("fleetd", items, []).matches.map((i) => i.id);
    expect(fleetd[0]).toBe("project:devbox/fleetd");
    expect(fleetd).toContain("go:settings.prompts");
    expect(fleetd).not.toContain("settings.open");
    expect(rank("dn", items, []).matches).toEqual([]);
  });

  it("searches keywords, and breaks ties by what was run lately", () => {
    const list = [item("a", "Board", "go-to"), item("b", "Board", "go-to"), item("c", "Settings", "settings", { keywords: ["preferences"] })];
    expect(rank("board", list, ["b"]).matches.map((i) => i.id)).toEqual(["b", "a"]);
    expect(rank("prefs", list, []).matches.map((i) => i.id)).toEqual(["c"]);
  });

  it("keeps five recents, newest first, without repeats", () => {
    expect(pushRecent(["a", "b", "c", "d", "e"], "c")).toEqual(["c", "a", "b", "d", "e"]);
    expect(pushRecent(["a", "b", "c", "d", "e"], "f")).toEqual(["f", "a", "b", "c", "d"]);
  });
});

describe("registry", () => {
  const offs: (() => void)[] = [];
  afterEach(() => {
    for (const off of offs.splice(0)) off();
  });

  it("never lets a default shadow a screen's command, whichever registers first", () => {
    const ran: string[] = [];
    // React runs the shell's effects after its children's, so the screen registers first at launch.
    offs.push(registerCommands([item("status.toggle", "Status", "go-to", { run: () => ran.push("screen") })]));
    const offDefault = registerCommands([item("status.toggle", "Status", "go-to", { run: () => ran.push("default") })], "default");
    runCommand("status.toggle");
    // A screen that mounts later still wins over the default, and the default returns once screens are gone.
    const offLater = registerCommands([item("status.toggle", "Status", "go-to", { run: () => ran.push("later") })]);
    runCommand("status.toggle");
    offLater();
    for (const off of offs.splice(0)) off();
    runCommand("status.toggle");
    offDefault();
    expect(ran).toEqual(["screen", "later", "default"]);
    expect(runCommand("status.toggle")).toBe(false);
  });

  it("never lets the palette's built-ins shadow a screen module's default, whichever registers first", () => {
    const ran: string[] = [];
    // time/commands.ts registers at module load; PaletteHost's built-ins come later, when it mounts.
    offs.push(registerCommands([item("go:time", "Time for W14", "go-to", { run: () => ran.push("time") })], "default"));
    offs.push(registerCommands([item("go:time", "Time", "go-to", { run: () => ran.push("builtin") })], "builtin"));
    runCommand("go:time");
    for (const off of offs.splice(0, 1)) off();
    runCommand("go:time");
    expect(ran).toEqual(["time", "builtin"]);
    // And the other way round: the built-ins first (a screen module loaded late).
    ran.length = 0;
    const offBuiltin = registerCommands([item("go:time", "Time", "go-to", { run: () => ran.push("builtin") })], "builtin");
    const offTime = registerCommands([item("go:time", "Time for W14", "go-to", { run: () => ran.push("time") })], "default");
    runCommand("go:time");
    offTime();
    runCommand("go:time");
    offBuiltin();
    expect(ran).toEqual(["time", "builtin"]);
  });

  it("lets the latest registration of an id win until it unmounts", () => {
    const ran: string[] = [];
    offs.push(registerCommands([item("board.open", "Board", "go-to", { run: () => ran.push("default") })]));
    const offScreen = registerCommands([item("board.open", "Board", "go-to", { run: () => ran.push("screen") })]);
    runCommand("board.open");
    offScreen();
    runCommand("board.open");
    expect(ran).toEqual(["screen", "default"]);
  });

  it("drops disabled commands from the palette and lets their keys fall through", () => {
    let enabled = false;
    offs.push(registerCommands([item("order.stop", "Stop order", "orders", { enabled: () => enabled })]));
    const press = { key: ">", code: "Period", metaKey: true, ctrlKey: false, shiftKey: true, altKey: false, repeat: false, isComposing: false };
    expect(dispatchable(press, "darwin")).toBeUndefined();
    expect(snapshotItems().some((c) => c.id === "order.stop")).toBe(false);
    enabled = true;
    expect(dispatchable(press, "darwin")).toBe("order.stop");
    expect(dispatchable({ ...press, repeat: true }, "darwin")).toBeUndefined();
    expect(commandFor("order.stop")?.title).toBe("Stop order");
  });

  it("merges source items after commands, skipping ids already present", () => {
    offs.push(registerCommands([item("order:W1", "From a command", "orders")]));
    offs.push(registerSource({ id: "orders", items: () => [item("order:W1", "Duplicate", "orders"), item("order:W2", "W2 Fix login", "orders")] }));
    expect(snapshotItems().map((c) => c.title)).toEqual(["From a command", "W2 Fix login"]);
  });
});

describe("useCommands closures", () => {
  it("runs the command with the key's id after the list reorders or shrinks", () => {
    const ran: string[] = [];
    const stop = item("order.stop", "Stop", "orders", { run: () => ran.push("stop") });
    const prev = item("order.previous", "Previous", "orders", { run: () => ran.push("previous") });
    const next = item("order.next", "Next", "orders", { run: () => ran.push("next") });
    const latest: { current: readonly Command[] } = { current: [stop, prev, next] };
    const off = registerCommands(bindLatest(latest));
    // The order stops running: "stop" leaves the list without a re-registration.
    latest.current = [prev, next];
    runCommand("order.previous");
    runCommand("order.next");
    expect(runCommand("order.stop")).toBe(false);
    expect(commandFor("order.stop")).toBeUndefined();
    off();
    expect(ran).toEqual(["previous", "next"]);
  });
});

describe("keys while the palette is open", () => {
  const offs: (() => void)[] = [];
  afterEach(() => {
    for (const off of offs.splice(0)) off();
  });
  const ctrl = (k: string, code: string) => ({ key: k, code, metaKey: false, ctrlKey: true, shiftKey: false, altKey: false, repeat: false, isComposing: false });

  it("holds back only the palette's own Ctrl+N/P off macOS; other shortcuts still run", () => {
    offs.push(
      registerCommands([
        item("order.new", "New order", "actions"),
        item("palette.toggle", "Palette", "actions"),
        item("board.open", "Board", "go-to"),
        item("shortcuts.show", "Shortcuts", "actions"),
      ]),
    );
    expect(dispatchable(ctrl("n", "KeyN"), "linux", false)).toBe("order.new");
    expect(dispatchable(ctrl("n", "KeyN"), "linux", true)).toBeUndefined();
    expect(dispatchable(ctrl("k", "KeyK"), "linux", true)).toBe("palette.toggle");
    expect(dispatchable(ctrl("0", "Digit0"), "linux", true)).toBe("board.open");
    // The footer's "All shortcuts" key works from inside the palette.
    expect(dispatchable(ctrl("/", "Slash"), "linux", true)).toBe("shortcuts.show");
    // On macOS Ctrl isn't Mod, so ⌘N keeps meaning New order with the palette open.
    expect(dispatchable({ ...ctrl("n", "KeyN"), ctrlKey: false, metaKey: true }, "darwin", true)).toBe("order.new");
  });

  it("finds a letter shortcut on a layout without Latin letters", () => {
    offs.push(registerCommands([item("palette.toggle", "Palette", "actions")]));
    expect(dispatchable(ctrl("л", "KeyK"), "linux")).toBe("palette.toggle");
  });
});

describe("default navigation", () => {
  it("toggles Status: open it from anywhere, go back from it", () => {
    expect(statusToggleTarget("#/project/devbox/storefront")).toBe("#/status");
    expect(statusToggleTarget("")).toBe("#/status");
    expect(statusToggleTarget("#/status")).toBe("back");
    expect(statusToggleTarget("#/statusx")).toBe("#/status");
  });
});

describe("projects", () => {
  const state = (frames: readonly HubFrame[]) => frames.reduce((s, f) => applyFrame(s, f, Date.parse(AT))[0], initialState());

  it("lists every project, opening its lead chat, named by machine, never by id", () => {
    const opened: string[] = [];
    const items = projectItems(state([live(), snapshot(1)]), (hash) => opened.push(hash));
    expect(items.map((i) => [i.id, i.title, i.detail, i.group])).toEqual([["project:devbox/storefront", "storefront", "Chat with the lead · on devbox", "projects"]]);
    items[0]?.run();
    expect(opened).toEqual(["#/project/devbox/storefront"]);
  });

  it("is found fuzzily and listed before the go-tos when nothing is typed", () => {
    const items = [...projectItems(state([live(), snapshot(1)]), () => undefined), item("status.toggle", "Status", "go-to")];
    expect(rank("stfr", items, []).matches.map((i) => i.title)).toEqual(["storefront"]);
    expect(rank("", items, []).matches.map((i) => i.group)).toEqual(["projects", "go-to"]);
  });

  it("lists nothing until the hub's snapshot arrives", () => {
    expect(projectItems(initialState(), () => undefined)).toEqual([]);
  });

  it("escapes ids in the chat route", () => {
    expect(chatRoute("dev box", "a/b")).toBe("#/project/dev%20box/a%2Fb");
  });
});
