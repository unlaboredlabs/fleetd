import { describe, expect, it } from "vitest";
import type { ProjectDiscoverOutput, ProjectInspect } from "./contracts";
import { discovery, newPath, plan, progress, ready, rows, target } from "./discovery";
import { prefillMachine } from "./store";
import { addSource, folderName, githubRepo, linkUrl, machineIdFromHost, otherHost, tilde } from "./source";

const names = (id: string) => `${id}-name`;

const out: ProjectDiscoverOutput = {
  machines: [
    {
      machineId: "devbox",
      online: true,
      cloneRoot: "/home/me/src",
      projectsRoot: "/home/me/fleetd/projects",
      repos: [
        { path: "/home/me/src/storefront", name: "storefront", remote: "github.com/acme/storefront", repo: "acme/storefront", projectId: "p1" },
        { path: "/home/me/code/notes", name: "notes" },
      ],
    },
    { machineId: "buildbox", online: false, repos: [], problem: { code: "machine_offline", message: "buildbox is offline.", fix: "Start its node." } },
  ],
  github: {
    ghOn: "hub",
    owners: ["me", "acme"],
    repos: [
      { repo: "acme/storefront", url: "https://github.com/acme/storefront", private: false, checkouts: [{ machineId: "devbox", path: "/home/me/src/storefront", projectId: "p1" }] },
      { repo: "acme/ledger", url: "https://github.com/acme/ledger", private: true, checkouts: [{ machineId: "devbox", path: "/home/me/src/ledger" }] },
      { repo: "acme/site", url: "https://github.com/acme/site", private: false, description: "Marketing site", checkouts: [] },
    ],
  },
  best: "devbox",
};

describe("discovery", () => {
  it("lists checkouts by machine, then GitHub, and marks what is already a project", () => {
    const d = discovery(out, names);
    expect(d.best).toBe("devbox");
    expect(d.ghOn).toBe("the hub");
    expect(d.workers.map((w) => [w.name, w.online])).toEqual([
      ["devbox-name", true],
      ["buildbox-name", false],
    ]);
    expect(d.problems).toEqual([{ message: "buildbox is offline.", fix: "Start its node." }]);
    expect(d.found.map((f) => [f.name, f.detail, f.project !== undefined])).toEqual([
      ["storefront", "acme/storefront", true],
      ["notes", "no remote", false],
      ["acme/storefront", "", true],
      ["acme/ledger", "checked out on devbox-name", false],
      ["acme/site", "Marketing site", false],
    ]);
  });

  it("defaults to the hub's best worker, and never to an offline one", () => {
    const d = discovery(out, names);
    expect(target(d, null)?.machineId).toBe("devbox");
    expect(target(d, "buildbox")?.machineId).toBe("devbox");
    expect(target({ ...d, best: "buildbox" }, null)?.machineId).toBe("devbox");
    expect(target({ ...d, workers: d.workers.map((w) => ({ ...w, online: false })) }, null)).toBeNull();
  });

  it("starts a pasted repo that is already a project on that project, and otherwise on something that adds", () => {
    const d = discovery(out, names);
    const pasted = rows("https://github.com/acme/storefront", d.found);
    expect(pasted.rows[0]).toEqual({ kind: "clone", repo: "acme/storefront" });
    expect(plan(pasted.rows[pasted.selected], d, target(d, null))).toEqual({ kind: "open", project: { machineId: "devbox", projectId: "p1" } });
    const all = rows("", d.found);
    expect(plan(all.rows[all.selected], d, target(d, null))).toEqual({ kind: "folder", machineId: "devbox", path: "/home/me/code/notes", fixed: true });
    const typed = rows("led", d.found);
    expect(plan(typed.rows[typed.selected], d, target(d, null))).toEqual({ kind: "clone", repo: "acme/ledger" });
    expect(plan(rows("~/src/x", d.found).rows[0], d, target(d, null))).toMatchObject({ kind: "folder", path: "~/src/x", fixed: false });
  });
});

describe("a new project", () => {
  it("is ready as a plain folder: no repo facts, and its lead line is no warning", () => {
    const r = ready({ machineId: "devbox", projectId: "p9" }, "Field notes", "devbox", "/home/me/fleetd/projects/field-notes", inspect({ leadNeeds: "a plain folder with no git" }));
    expect(r.facts).toEqual([]);
    expect(r.leadOk).toBe(true);
    expect(r.leadLine).toBe("A plain folder with no git.");
  });

  it("is offered for a typed name, after what it matches, and alone it is the pick", () => {
    const d = discovery(out, names);
    const alone = rows("Field notes", d.found);
    expect(alone.rows).toEqual([{ kind: "new", name: "Field notes" }]);
    expect(plan(alone.rows[alone.selected], d, target(d, null))).toEqual({ kind: "new", name: "Field notes", machineId: "devbox" });
    // A name that filters the list starts on what it found; the new project is last.
    const matched = rows("notes", d.found);
    expect(matched.rows.at(-1)).toEqual({ kind: "new", name: "notes" });
    expect(matched.rows[matched.selected]?.kind).toBe("found");
    // On the machine picked, even one not suggested.
    expect(plan(alone.rows[0], d, target(d, null), "buildbox")).toMatchObject({ machineId: "buildbox" });
  });

  it("is never a URL, a path or a repo, and with nothing typed it waits for a name below what was found", () => {
    const d = discovery(out, names);
    for (const text of ["https://gitlab.com/acme/x", "acme/site", "/home/me/x", "~/x"]) {
      expect(rows(text, d.found).rows.some((r) => r.kind === "new"), text).toBe(false);
    }
    const all = rows("", d.found);
    expect(all.rows[0]).toEqual({ kind: "new", name: "" });
    expect(all.rows[all.selected]?.kind).toBe("found");
    // Nothing found: the empty state says to type a name.
    expect(rows("", []).rows).toEqual([]);
  });

  it("goes to <projectsRoot>/<name as a folder>, named as the hub names it", () => {
    const d = discovery(out, names);
    expect(newPath(target(d, null) ?? undefined, "Field Notes!")).toBe("/home/me/fleetd/projects/field-notes");
    expect(newPath(d.workers[1], "x")).toBeNull();
    expect(folderName("  Home & Family!  ")).toBe("home-family");
    expect(folderName("✨")).toBe("project");
    expect(folderName("x".repeat(90))).toHaveLength(40);
  });
});

const inspect = (v: Partial<ProjectInspect>): ProjectInspect => ({
  ci: { workflows: [], requiredChecks: [] },
  merge: { protected: false, rulesets: [] },
  leadNeeds: "ok",
  notes: [],
  ...v,
});

describe("the ready state", () => {
  it("says what CI and merge rules the lead gets", () => {
    const none = ready({ machineId: "devbox", projectId: "p9" }, "mailer", "devbox", "/p", inspect({
      repo: "acme/mailer",
      defaultBranch: "main",
      merge: { protected: false, rulesets: [], squashAllowed: true },
      leadNeeds: "no CI found: the merge train holds its PRs until the repo has CI",
    }));
    expect(none.leadLine).toBe("No CI found: the merge train holds its PRs until the repo has CI.");
    expect(none.leadOk).toBe(false);
    expect(none.facts).toEqual([
      ["Repo", "acme/mailer"],
      ["Default branch", "main"],
      ["CI", "none found"],
      ["Merge rules", "no branch protection or ruleset, squash allowed"],
    ]);
    const full = ready({ machineId: "devbox", projectId: "p1" }, "storefront", "devbox", "/p", inspect({
      defaultBranch: "trunk",
      ci: { workflows: ["build", "test"], requiredChecks: ["build"] },
      merge: { protected: true, rulesets: ["main"], squashAllowed: true, requiredReviews: 1, strict: true },
      leadNeeds: "CI and rules found.",
    }));
    expect(full.leadOk).toBe(true);
    expect(full.facts[0]).toEqual(["Default branch", "trunk"]);
    expect(full.facts[1]?.[1]).toBe("2 workflows (build, test); requires build");
    expect(full.facts[2]?.[1]).toBe("ruleset main, 1 review required, up to date before merging, squash allowed");
    expect(full.leadLine).toBe("CI and rules found.");
  });

  it("draws the bar at the percent the label says, per phase", () => {
    expect(progress({ addId: "a", path: "/p", phase: "checking_out", percent: 100 }).fraction).toBe(1);
    const receiving = progress({ addId: "a", path: "/p", phase: "receiving", percent: 42 });
    expect([receiving.detail, receiving.fraction]).toEqual(["Receiving objects 42%", 0.42]);
    expect(progress({ addId: "a", path: "/p", phase: "inspecting" })).toEqual({ step: "inspect", detail: "Reading the default branch, CI and merge rules" });
  });
});

describe("what people paste and drop", () => {
  it("reads a repo the way the hub does", () => {
    for (const text of [
      "https://github.com/acme/storefront",
      "https://github.com/acme/storefront.git",
      "https://github.com/acme/storefront/tree/main/src",
      "git@github.com:acme/storefront.git",
      "github.com/acme/storefront",
      "acme/storefront",
      " acme/storefront\n",
    ]) {
      expect(githubRepo(text), text).toBe("acme/storefront");
    }
    for (const text of ["https://gitlab.com/acme/storefront", "storefront", "/home/me/src/storefront", "a/b/c"]) {
      expect(githubRepo(text), text).toBeNull();
    }
  });

  it("tells a path from a URL", () => {
    expect(addSource("~/src/storefront")).toEqual({ kind: "path", path: "~/src/storefront" });
    expect(addSource("./storefront")).toEqual({ kind: "path", path: "./storefront" });
    expect(addSource("https://github.com/acme/storefront")).toEqual({ kind: "github", repo: "acme/storefront" });
    expect(addSource("storefront")).toBeNull();
  });

  it("names other hosts and not GitHub", () => {
    expect(otherHost("https://gitlab.com/acme/storefront")).toContain("gitlab.com");
    expect(otherHost("git@bitbucket.org:acme/x.git")).toContain("bitbucket.org");
    expect(otherHost("https://github.com/acme/storefront")).toBeNull();
    expect(otherHost("storefront")).toBeNull();
  });

  it("finds the GitHub address in link files", () => {
    const webloc = `<?xml version="1.0"?><plist><dict><key>URL</key><string>https://github.com/acme/storefront</string></dict></plist>`;
    expect(linkUrl(webloc)).toBe("https://github.com/acme/storefront");
    expect(linkUrl("[InternetShortcut]\nURL=https://github.com/acme/mailer\n")).toBe("https://github.com/acme/mailer");
    expect(linkUrl("[Desktop Entry]\nType=Link\nURL=https://example.com/acme/x\n")).toBeNull();
  });

  it("shows home folders as ~ and derives machine ids like fleetd init", () => {
    expect(tilde("/home/me/src/x")).toBe("~/src/x");
    expect(tilde("/Users/me/src/x")).toBe("~/src/x");
    expect(tilde("/srv/x")).toBe("/srv/x");
    expect(machineIdFromHost("Dev Box.local")).toBe("dev-box");
    expect(machineIdFromHost("buildbox")).toBe("buildbox");
  });

  it("re-adds a removed project's folder on its own machine, even when another is suggested or it is offline", () => {
    const d = discovery(out, names);
    const typed = rows("/home/dev/src/billing", d.found);
    expect(plan(typed.rows[0], d, target(d, "buildbox"), "buildbox")).toEqual({ kind: "folder", machineId: "buildbox", path: "/home/dev/src/billing", fixed: false });
    expect(prefillMachine("/home/dev/src/billing", "buildbox", "devbox")).toBe("buildbox");
    expect(prefillMachine("~/src/x", undefined, "devbox")).toBe("devbox");
    expect(prefillMachine("acme/x", undefined, "devbox")).toBeUndefined();
  });
});
