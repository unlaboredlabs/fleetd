import { afterEach, describe, expect, it } from "vitest";
import type { HubFrame } from "../../../shared/hub";
import { AT, live, snapshot } from "../../src/data/fixtures.test-util";
import { applyFrame, initialState } from "../../src/data/store";
import { chatRoute, statusToggleTarget, themeCommands } from "./defaults";
import { currentProjectItem, projectItems } from "./projects";
import { dispatchable } from "./keymap";
import { boost, frecency, match, noteUse, rank, score } from "./rank";
import { buildRows } from "./Palette";
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

  const used = (entries: Record<string, number>) => new Map(Object.entries(entries));

  it("with nothing typed, suggests the most used first, then groups, and hides search-only items", () => {
    const ranked = rank("", items, used({ "status.toggle": 1, "project:devbox/fleetd": 3, gone: 9 }));
    expect(ranked.suggested.map((i) => i.id)).toEqual(["project:devbox/fleetd", "status.toggle"]);
    expect(ranked.matches.map((i) => i.id)).toEqual(["project:devbox/storefront", "settings.open"]);
  });

  it("finds by keyword, ranks the exact name first and ignores scattered letters", () => {
    expect(rank("w14", items).matches.map((i) => i.id)).toEqual(["project:devbox/storefront"]);
    const fleetd = rank("fleetd", items).matches.map((i) => i.id);
    expect(fleetd[0]).toBe("project:devbox/fleetd");
    expect(fleetd).toContain("go:settings.prompts");
    expect(fleetd).not.toContain("settings.open");
    expect(rank("dn", items).matches).toEqual([]);
  });

  it("finds a word in a detail, but not letters scattered through it", () => {
    const list = [item("j", "Research judge", "prompts", { detail: "Decides whether a research claim's check passed." }), item("s", "Status", "go-to", { detail: "Every project: working, waiting on you" })];
    expect(rank("dark", list).matches).toEqual([]);
    expect(rank("waiting", list).matches.map((i) => i.id)).toEqual(["s"]);
  });

  it("lets what you use most rise among close matches, never over a clearly better one", () => {
    const list = [item("a", "Board", "go-to"), item("b", "Board", "go-to"), item("c", "Settings", "settings", { keywords: ["preferences"] })];
    expect(rank("board", list, used({ b: 1 })).matches.map((i) => i.id)).toEqual(["b", "a"]);
    expect(rank("prefs", list).matches.map((i) => i.id)).toEqual(["c"]);
    const close = [item("x", "storefront", "projects"), item("y", "Status", "go-to")];
    // Equal matches: projects come first, until Status is the one you use.
    expect(rank("st", close).matches[0]?.id).toBe("x");
    expect(rank("st", close, used({ y: 2 })).matches[0]?.id).toBe("y");
    // Heavy use of a scattered match doesn't beat a name that starts with the query.
    const far = [item("p", "Prompts for fleetd", "prompts"), item("f", "fleetd", "projects")];
    expect(rank("fleetd", far, used({ p: 1000 })).matches[0]?.id).toBe("f");
    expect(boost(1000)).toBe(8);
  });

  it("shows each group once, in the order of its best match", () => {
    const mixed = [
      item("p1", "Status report", "prompts"),
      item("s1", "Status", "go-to"),
      item("p2", "Stash", "prompts"),
      item("x1", "Settings · status bar", "settings"),
    ];
    const rows = buildRows("st", mixed, new Map());
    const labels = rows.flatMap((r) => (r.label === undefined ? [] : [r.label]));
    expect(labels).toEqual([...new Set(labels)]);
    expect(rows[0]?.item.id).toBe("s1");
    expect(rows.map((r) => r.item.group)).toEqual(["go-to", "prompts", "prompts", "settings"]);
  });
});

describe("frecency", () => {
  const DAY = 86_400_000;
  it("counts runs, and counts old runs for less", () => {
    expect(frecency({ count: 4, last: 0 }, DAY / 2)).toBe(4);
    expect(frecency({ count: 4, last: 0 }, 3 * DAY)).toBeLessThan(4);
    expect(frecency({ count: 4, last: 0 }, 60 * DAY)).toBeLessThan(frecency({ count: 4, last: 0 }, 10 * DAY));
  });

  it("records runs and forgets the least used past fifty", () => {
    let uses = noteUse({}, "a", 0);
    uses = noteUse(uses, "a", 1);
    expect(uses["a"]).toEqual({ count: 2, last: 1 });
    for (let i = 0; i < 60; i += 1) uses = noteUse(uses, `x${String(i)}`, 2);
    expect(Object.keys(uses)).toHaveLength(50);
    expect(uses["a"]?.count).toBe(2);
  });
});

describe("match highlighting", () => {
  it("marks the word the query names, not the first letter that happens to match", () => {
    expect(match("fleetd", "Prompts for fleetd")?.at).toEqual([12, 13, 14, 15, 16, 17]);
    expect(match("max agents", "Max agents")?.at).toEqual([0, 1, 2, 4, 5, 6, 7, 8, 9]);
    expect(match("xyz", "Max agents")).toBeUndefined();
  });
});

describe("settings by their names", () => {
  it("offers a theme switch for \"dark\", hidden while it is already dark", () => {
    const set: string[] = [];
    const light = themeCommands("light", (m) => set.push(m));
    const found = rank("dark", light.filter((c) => c.enabled?.() ?? true)).matches;
    expect(found[0]?.title).toBe("Switch to dark theme");
    found[0]?.run();
    expect(set).toEqual(["dark"]);
    expect(themeCommands("dark", () => undefined).find((c) => c.id === "theme:dark")?.enabled?.()).toBe(false);
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
    offs.push(registerCommands([item("sidebar.toggle", "Toggle sidebar", "actions", { enabled: () => enabled })]));
    const press = { key: "b", code: "KeyB", metaKey: true, ctrlKey: false, shiftKey: false, altKey: false, repeat: false, isComposing: false };
    expect(dispatchable(press, "darwin")).toBeUndefined();
    expect(snapshotItems().some((c) => c.id === "sidebar.toggle")).toBe(false);
    enabled = true;
    expect(dispatchable(press, "darwin")).toBe("sidebar.toggle");
    expect(dispatchable({ ...press, repeat: true }, "darwin")).toBeUndefined();
    expect(commandFor("sidebar.toggle")?.title).toBe("Toggle sidebar");
  });

  it("merges source items after commands, skipping ids already present", () => {
    offs.push(registerCommands([item("project:devbox/a", "From a command", "projects")]));
    offs.push(registerSource({ id: "projects", items: () => [item("project:devbox/a", "Duplicate", "projects"), item("project:devbox/b", "storefront", "projects")] }));
    expect(snapshotItems().map((c) => c.title)).toEqual(["From a command", "storefront"]);
  });
});

describe("useCommands closures", () => {
  it("runs the command with the key's id after the list reorders or shrinks", () => {
    const ran: string[] = [];
    const attach = item("composer.attach", "Attach a file", "actions", { run: () => ran.push("attach") });
    const prev = item("project.previous", "Previous", "projects", { run: () => ran.push("previous") });
    const next = item("project.next", "Next", "projects", { run: () => ran.push("next") });
    const latest: { current: readonly Command[] } = { current: [attach, prev, next] };
    const off = registerCommands(bindLatest(latest));
    // The composer goes away: "attach" leaves the list without a re-registration.
    latest.current = [prev, next];
    runCommand("project.previous");
    runCommand("project.next");
    expect(runCommand("composer.attach")).toBe(false);
    expect(commandFor("composer.attach")).toBeUndefined();
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

  it("holds back only the palette's own Ctrl+N/P (off macOS) and ⌘K; other shortcuts still run", () => {
    offs.push(
      registerCommands([
        item("palette.toggle", "Palette", "actions"),
        item("project.open.1", "Project 1", "projects"),
        item("shortcuts.show", "Shortcuts", "actions"),
      ]),
    );
    expect(dispatchable(ctrl("n", "KeyN"), "linux", true)).toBeUndefined();
    // ⌘K is the palette's own while it is open: it lists the selected item's actions, or closes.
    expect(dispatchable(ctrl("k", "KeyK"), "linux", true)).toBeUndefined();
    expect(dispatchable(ctrl("k", "KeyK"), "linux", false)).toBe("palette.toggle");
    expect(dispatchable(ctrl("1", "Digit1"), "linux", true)).toBe("project.open.1");
    // The footer's "All shortcuts" key works from inside the palette.
    expect(dispatchable(ctrl("/", "Slash"), "linux", true)).toBe("shortcuts.show");
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
    expect(rank("stfr", items).matches.map((i) => i.title)).toEqual(["storefront"]);
    expect(rank("", items).matches.map((i) => i.group)).toEqual(["projects", "go-to"]);
  });

  it("offers the project's other pages as actions, scoped to it", () => {
    const opened: string[] = [];
    const [project] = projectItems(state([live(), snapshot(1)]), (hash) => opened.push(hash));
    expect(project?.actions?.map((a) => a.title)).toEqual(["Instructions for this project", "Prompts for this project", "Max agents"]);
    for (const action of project?.actions ?? []) action.run();
    expect(opened).toEqual(["#/settings/instructions?for=devbox/storefront", "#/settings/prompts?for=devbox/storefront", "#/settings/agents"]);
  });

  it("knows the project on screen, so the palette opens on it", () => {
    expect(currentProjectItem("#/project/devbox/storefront")).toBe("project:devbox/storefront");
    expect(currentProjectItem("#/project/dev%20box/a%2Fb?message=m1")).toBe("project:dev box/a/b");
    expect(currentProjectItem("#/status")).toBeUndefined();
  });

  it("lists nothing until the hub's snapshot arrives", () => {
    expect(projectItems(initialState(), () => undefined)).toEqual([]);
  });

  it("escapes ids in the chat route", () => {
    expect(chatRoute("dev box", "a/b")).toBe("#/project/dev%20box/a%2Fb");
  });
});
