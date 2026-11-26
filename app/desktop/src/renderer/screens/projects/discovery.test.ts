import { describe, expect, it } from "vitest";
import type { ProjectDiscoverOutput } from "./contracts";
import { discovery, projectHome, progress, repoSuggestions, target } from "./discovery";
import { prefillMachine } from "./store";
import { addSource, githubRepo, linkUrl, machineIdFromHost, otherHost, tilde } from "./source";

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
  it("lists checkouts by machine, then GitHub, and marks what is already a bot", () => {
    const d = discovery(out, names);
    expect(d.best).toBe("devbox");
    expect(d.ghOn).toBe("the workspace");
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

  it("says each problem and its fix as sentences, as the screen runs them together", () => {
    // The hub's words end without a stop: "gh is not logged in on the hub Run `gh auth login`…" read as one.
    const github: ProjectDiscoverOutput["github"] = { owners: [], repos: [], problem: { code: "gh_unavailable", message: "gh repo list did not run: gh is not logged in on the workspace", fix: "Run `gh auth login` on the workspace machine, or paste the repository's URL" } };
    const d = discovery({ machines: [], github }, names);
    expect(d.problems).toEqual([
      { message: "gh repo list did not run: gh is not logged in on the workspace.", fix: "Run `gh auth login` on the workspace machine, or paste the repository's URL.", github: true },
    ]);
  });

  it("defaults to the hub's best worker, and never to an offline one", () => {
    const d = discovery(out, names);
    expect(target(d, null)?.machineId).toBe("devbox");
    expect(target(d, "buildbox")?.machineId).toBe("devbox");
    expect(target({ ...d, best: "buildbox" }, null)?.machineId).toBe("devbox");
    expect(target({ ...d, workers: d.workers.map((w) => ({ ...w, online: false })) }, null)).toBeNull();
  });

});

describe("what New bot offers to add", () => {
  it("is what the hub found that isn't a bot yet, checkouts on the bot's machine only, best match first", () => {
    const d = discovery(out, names);
    const names_ = (text: string, machine = "devbox", taken: string[] = []) => repoSuggestions(text, d, machine, taken, 6).map((r) => (r.kind === "clone" ? r.repo : r.path));
    expect(names_("")).toEqual(["/home/me/code/notes", "acme/ledger", "acme/site"]);
    expect(names_("", "buildbox")).toEqual(["acme/ledger", "acme/site"]);
    expect(names_("led")).toEqual(["acme/ledger"]);
    expect(names_("", "devbox", ["gh:acme/ledger", "dir:/home/me/code/notes"])).toEqual(["acme/site"]);
  });

  it("starts with what is typed when it reads as a repo or a path", () => {
    const d = discovery(out, names);
    expect(repoSuggestions("https://github.com/acme/ledger", d, "devbox", [], 6)[0]).toEqual({ kind: "clone", repo: "acme/ledger", detail: "from GitHub" });
    expect(repoSuggestions("/srv/notes", d, "devbox", [], 6)).toEqual([{ kind: "folder", path: "/srv/notes" }]);
  });
});

describe("the agents' Mac", () => {
  it("are no bot's home: not offered, and their checkouts not listed", () => {
    const mac: ProjectDiscoverOutput = {
      ...out,
      machines: [...out.machines, { machineId: "mac", online: true, cloneRoot: "/Users/agents/src", repos: [{ path: "/Users/agents/src/storefront", name: "storefront", repo: "acme/storefront" }] }],
      github: { ...out.github, repos: [{ repo: "acme/site", url: "https://github.com/acme/site", private: false, checkouts: [{ machineId: "mac", path: "/Users/agents/src/site" }] }] },
      best: "mac",
    };
    const d = discovery(mac, names, (id) => id !== "mac");
    expect(d.workers.map((w) => w.machineId)).toEqual(["devbox", "buildbox"]);
    expect(d.found.some((f) => f.source.kind === "checkout" && f.source.machineId === "mac")).toBe(false);
    expect(d.found.find((f) => f.name === "acme/site")?.detail).toBe("");
    expect(d.best).toBeUndefined();
    expect(target(d, null)?.machineId).toBe("devbox");
  });

  it("are told apart by the machine's own flags", () => {
    expect(projectHome({})).toBe(true);
    expect(projectHome({ agentsMac: true })).toBe(false);
  });
});

describe("a clone's progress", () => {
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

  it("re-adds a deleted bot's folder on its own machine, and a path dropped here on this computer", () => {
    expect(prefillMachine("/home/dev/src/billing", "buildbox", "devbox")).toBe("buildbox");
    expect(prefillMachine("~/src/x", undefined, "devbox")).toBe("devbox");
    expect(prefillMachine("acme/x", undefined, "devbox")).toBeUndefined();
  });
});
