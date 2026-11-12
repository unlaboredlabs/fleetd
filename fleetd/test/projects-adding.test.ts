import { expect, test } from "bun:test";
import { aProject, BY_KEY, BY_PROJECT, BY_THREAD } from "../src/hub/navi/erase_tables.ts";
import { archivedNote, namesFolder, problem, problemError, slugOr } from "../src/hub/projects/adding.ts";
import { nameFor } from "../src/hub/repos/names.ts";

test("a new project's folder and a repo's name come from its title or key, with a fallback when nothing is left", () => {
  expect(slugOr("  My Shop!  v2 ", "inbox")).toBe("my-shop-v2");
  expect(slugOr("!!!", "inbox")).toBe("inbox");
  expect(slugOr("a".repeat(60), "inbox")).toHaveLength(40);
  expect(nameFor("github.com/acme/My_Shop/")).toBe("my-shop");
  expect(nameFor("/")).toBe("repo");
  expect(nameFor(undefined)).toBe("repo");
});

test("a node's refusal names the folder as given or as ~ expands; a problem becomes a tool's error by its kind", () => {
  expect(namesFolder("cannot create /home/me/site: denied", "~/site")).toBe(true);
  expect(namesFolder("cannot create /home/me/other: denied", "~/site")).toBe(false);
  expect(namesFolder("cannot create ~/site: denied", "~/site")).toBe(true);
  expect(namesFolder("cannot create /site here", "~/site")).toBe(true);
  expect(problemError(problem("gh_no_access", "No access", "Ask for it")).code).toBe("not_found");
  expect(problemError(problem("dest_exists", "Taken", "Pick another")).code).toBe("invalid");
  expect(problemError(problem("machine_offline", "Off", "Start it")).code).toBe("machine_offline");
  const [message] = archivedNote({ machineId: "m", projectId: "p" }, { name: "web" } as never);
  expect(message).toBe("This project is archived: its directory is repo web of project p on m.");
});

test("erasing a project never takes a hub-wide key as a project's, and each table is listed once", () => {
  expect(() => aProject({ machineId: "", projectId: "p" })).toThrow("nothing was erased");
  expect(() => aProject({ machineId: "m", projectId: "p" })).not.toThrow();
  const all = [...BY_PROJECT, ...BY_THREAD, ...BY_KEY];
  expect(new Set(all).size).toBe(all.length);
});
