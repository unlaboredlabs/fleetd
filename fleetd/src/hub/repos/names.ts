// A repo's name as the hub gives it from its key or folder (store.ts keeps repos).
import type { RepoName } from "../../shared/contracts.ts";

/** A repo's name from the last part of its repo key or folder: `github.com/acme/My_Shop` → `my-shop`; `repo` when nothing is left. */
export function nameFor(path: string | undefined): RepoName {
  const last = path?.replace(/\/+$/, "").split("/").pop() ?? "";
  let name = "";
  for (const ch of last.toLowerCase()) {
    const c = /^[a-z0-9]$/.test(ch) ? ch : "-";
    if (!(c === "-" && (name === "" || name.endsWith("-")))) name += c;
  }
  name = name.slice(0, 32).replace(/-+$/, "");
  return name === "" ? "repo" : name;
}
