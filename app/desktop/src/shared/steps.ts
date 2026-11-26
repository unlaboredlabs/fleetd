// What an agent or a lead did, in plain words (W949): one labeller for every place a step is read. The working row in
// the reply's place and its recent steps, an agent's page and its step log, the Agents list's now-line, a screen's
// now-line and its replay all say a step the same way: "Edited index.html", "Ran the tests", "Opened Wikipedia",
// "Clicked “Search”", "Starting 3 agents". A file by its name, never its path; a page by its title, never its URL; a
// step that touched nothing (a shell fragment such as "2>", a tool's own help) says nothing at all; "failed" only when
// the step itself failed, never because a command chained after it did. The full command, path or URL stays as `raw`,
// for the row's expand; machine text in a phrase (a file's name, a site, a search) comes in backticks, which the
// places that draw it set in the machine voice (plainStep drops them). Pure, and free of newer JS (no toSorted), so the phone app says the same (app/mobile, through
// its src/desktop.ts).
import type { ActionItem, Activity, WorkStep } from "./contracts";

/** One step in words. */
export interface StepLabel {
  /** What it did, as a short phrase: "Edited index.html". Present tense while it runs ("Editing index.html"). */
  readonly text: string;
  /** The command, path, URL or tool it was, whole, for the row's expand; absent when the words say all of it. */
  readonly raw?: string | undefined;
  /** Only when it failed: "failed", "failed, exit 1", or the browser's own reason. */
  readonly failed?: string | undefined;
  /** It runs now. */
  readonly running?: boolean | undefined;
  /** A thought of the model's, or a message, rather than an action: read as prose, quiet. */
  readonly prose?: boolean | undefined;
  /** Steps that read as one when they come in a row (starting agents, reading files): how many, and their words. */
  readonly group?: { readonly key: string; readonly many: (n: number) => string; readonly each?: true } | undefined;
}

type Tense = "present" | "past";
/** A phrase in both tenses: [while it runs, once done]. */
type Said = readonly [present: string, past: string];

const said = (s: Said, tense: Tense): string => (tense === "present" ? s[0] : s[1]);

// ---- names ----

/** A path's last part: `src/app/index.html` → `index.html`. */
export const fileName = (path: string): string => {
  const parts = path.trim().replace(/\/+$/u, "").split("/");
  return parts[parts.length - 1] || path.trim();
};

/** A URL's site, without `www.`: `https://en.wikipedia.org/wiki/X` → `en.wikipedia.org`. Undefined for no URL. */
export const siteOf = (url: string): string | undefined => {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/iu.exec(url.trim());
  if (m === null) return undefined;
  const host = (m[1] ?? "").replace(/^[^@]*@/u, "").toLowerCase();
  return host.startsWith("www.") ? host.slice(4) : host;
};

/** The separators a page title puts between its own name and its site's: "Web browser - Wikipedia". */
const TITLE_SITE = /\s+[-–—|·:]\s+/u;

/**
 * A page as a person names it: its site's name from its title when the title ends with one ("Web browser -
 * Wikipedia" → "Wikipedia"), else its title when short enough to read in a line, else its site. `url` alone: its site.
 */
export const pageName = (title: string | undefined, url: string | undefined): string | undefined => {
  const t = title?.trim().replace(/\s+/gu, " ") ?? "";
  if (t !== "" && !/^(about:blank|untitled|new tab)$/iu.test(t) && siteOf(t) === undefined) {
    const parts = t.split(TITLE_SITE);
    const last = parts[parts.length - 1] ?? "";
    if (parts.length > 1 && last.length >= 2 && last.length <= 24) return last;
    if (t.length <= 40) return t;
  }
  const u = url?.trim() ?? "";
  if (u === "") return undefined;
  if (/^about:blank$/iu.test(u)) return "a blank page";
  // A file of its own: by its name.
  if (/^file:/iu.test(u)) return u.includes("$") ? "a file" : fileName(u);
  // agent-browser opens `example.com/x` as https.
  const site = siteOf(u) ?? (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/u.test(u) ? siteOf(`https://${u}`) : undefined);
  return site !== undefined && !site.includes("$") ? site : undefined;
};

/** Words in quotes when they read as words: a short button label or search, never a regex or a ref. */
const quotable = (s: string | undefined): string | undefined => {
  const t = s?.trim() ?? "";
  return t !== "" && t.length <= 32 && /^[\p{L}\p{N}][\p{L}\p{N} '’.,&!?+-]*$/u.test(t) ? t : undefined;
};

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : `${String(n)} ${many}`);

/** Machine text in a phrase (a file's name, a site, a search, a program), in backticks: drawn in the machine voice. */
const code = (s: string): string => `\`${s.replace(/`/gu, "")}\``;

/** A phrase as plain words, its machine text unmarked: for a tooltip, a screen reader, a notification. */
export const plainStep = (text: string): string => text.replace(/`/gu, "");

// ---- shell ----

/** A command line's words, as a shell splits them (quotes and backslashes), with `|`, `;`, `&` and newlines as words. */
export const shellWords = (line: string): string[] => {
  const out: string[] = [];
  let word = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i] ?? "";
    if (quote !== null) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < line.length) word += line[++i] ?? "";
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < line.length) {
      word += line[++i] ?? "";
      started = true;
    } else if (/\s/u.test(c) || c === "|" || c === ";" || c === "&") {
      if (started) out.push(word);
      word = "";
      started = false;
      if (c === "\n") out.push(";");
      else if (c !== " " && c !== "\t" && c !== "\r") out.push(c);
    } else {
      word += c;
      started = true;
    }
  }
  if (started) out.push(word);
  return out;
};

/** A heredoc's body is the script, not the command: the line up to it, and which interpreter reads it. */
const withoutHeredocs = (command: string): string => {
  const lines = command.split("\n");
  const out: string[] = [];
  let until: string | undefined;
  for (const line of lines) {
    if (until !== undefined) {
      if (line.trim() === until) until = undefined;
      continue;
    }
    out.push(line);
    const m = /<<-?\s*(['"]?)([A-Za-z_][\w-]*)\1/u.exec(line);
    if (m !== null) until = m[2];
  }
  return out.join("\n");
};

/** One simple command of a line: its words, whether a pipe fed it (a filter of what came before), and the files it
 * writes by redirection (`> notes.md`; never /dev/null). */
interface Part {
  readonly words: readonly string[];
  readonly piped: boolean;
  readonly writes: readonly string[];
}

/** Shell words that open or close a compound command: the command they hold is what runs. */
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "{", "(", "time"]);
/** Lines of a compound command that are only its frame. */
const FRAME = new Set(["for", "done", "fi", "esac", "case", "}", ")", "function", "in"]);

/** A command line as its simple commands, in order: split at `&&`, `||`, `;`, `|`, newlines and `$(…)`. */
const partsOf = (command: string): Part[] => {
  const out: Part[] = [];
  let cur: string[] = [];
  let piped = false;
  // A command substitution runs a command of its own: `r=$(agent-browser snapshot)` is a snapshot.
  const words = shellWords(withoutHeredocs(command).replace(/\$\(|`/gu, " ; "));
  const push = () => {
    if (cur.length > 0) out.push({ words: cur, piped, writes: writesOf(cur) });
    cur = [];
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    if (w === "|" || w === ";" || w === "&") {
      // `2>&1`, `&>`, `>&2`: a redirection, not a split.
      const prev = cur[cur.length - 1];
      if (w === "&" && prev !== undefined && /[<>]$/u.test(prev)) {
        cur[cur.length - 1] = `${prev}&${words[i + 1] ?? ""}`;
        i++;
        continue;
      }
      push();
      const double = words[i + 1] === w;
      if (double) i++;
      piped = w === "|" && !double;
      continue;
    }
    cur.push(w);
  }
  push();
  // A function the line defines (`ab(){ agent-browser "$@"; }`) runs what its body does.
  const aliases = new Map<string, string>();
  for (const m of command.matchAll(/([A-Za-z_][\w-]*)\s*\(\)\s*\{\s*([\w./-]+)/gu)) aliases.set(m[1] ?? "", m[2] ?? "");
  return out
    .map((p) => {
      const words = cleanWords(p.words);
      const alias = aliases.get(words[0] ?? "");
      return { ...p, words: alias === undefined ? words : [alias, ...words.slice(1)] };
    })
    .filter((p) => p.words.length > 0 && !FRAME.has(p.words[0] ?? "") && !/[(){}]$/u.test(p.words[0] ?? ""));
};

/** The files a simple command writes by redirection. */
const writesOf = (words: readonly string[]): string[] => {
  const out: string[] = [];
  words.forEach((w, i) => {
    const m = /^\d*>{1,2}(.*)$/u.exec(w);
    if (m === null || w.includes("&")) return;
    const file = m[1] !== "" ? m[1] : words[i + 1];
    if (file !== undefined && file !== "" && !file.startsWith("/dev/")) out.push(file);
  });
  return out;
};

/** A simple command without what only sets it up: redirections, `VAR=value`, and wrappers (env, timeout, sudo, nice). */
const cleanWords = (words: readonly string[]): string[] => {
  const kept = words.filter((w, i) => {
    if (/^\d*[<>]/u.test(w) || /^&>/u.test(w)) return false;
    const prev = words[i - 1];
    // The file a bare `>` or `2>` writes to.
    return !(prev !== undefined && /^\d*>{1,2}$/u.test(prev));
  });
  let i = 0;
  for (;;) {
    const w = kept[i];
    if (w === undefined) break;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(w) || KEYWORDS.has(w)) i++;
    else if (w === "env") {
      i++;
      while (kept[i] !== undefined && (kept[i]?.startsWith("-") === true || /^[A-Za-z_][A-Za-z0-9_]*=/u.test(kept[i] ?? ""))) i += kept[i] === "-u" ? 2 : 1;
    } else if (w === "sudo" || w === "nice" || w === "time" || w === "command" || w === "exec" || w === "nohup" || w === "fleetd-heavy" || w === "stdbuf") i++;
    else if (w === "timeout") {
      i++;
      while (kept[i]?.startsWith("-") === true) i++;
      i++;
    } else break;
  }
  return kept.slice(i);
};

/** What sets up a line rather than doing its work: said only when nothing else in the line does anything. */
const SETUP = new Set(["cd", "pushd", "popd", "export", "set", "unset", "source", ".", "mkdir", "true", ":", "local", "trap", "ulimit", "umask", "shopt", "eval"]);
/** Echoes and waits: said only when they are all a line does. */
const QUIET = new Set(["echo", "printf", "sleep", "date"]);
/** What a pipe feeds to look at its output: never the step itself. */
const FILTERS = new Set(["head", "tail", "grep", "rg", "sed", "awk", "jq", "wc", "sort", "uniq", "cut", "tr", "cat", "tee", "less", "more", "column", "xargs", "fold", "nl", "base64", "fmt"]);
/** Steps that touch nothing: looking up a tool rather than using it. */
const NOTHING = new Set(["which", "type", "man", "whatis", "whereis", "hash", "help"]);

const program = (word: string | undefined): string => fileName(word ?? "").toLowerCase();

/** The first word that isn't a flag, from `from` on. */
const firstArg = (words: readonly string[], from = 1): string | undefined => words.slice(from).find((w) => !w.startsWith("-"));
/** The words that aren't flags, from `from` on. */
const args = (words: readonly string[], from = 1): string[] => words.slice(from).filter((w) => !w.startsWith("-"));

/** Looks like a file someone would name: has an extension or a slash, and no shell or glob noise. */
const looksLikeFile = (w: string | undefined): boolean => w !== undefined && /^[\w~./@+${}-]+$/u.test(w) && (/\.[A-Za-z0-9]{1,8}$/u.test(w) || w.includes("/")) && !/^-/u.test(w) && !/^\d+(,\d+)?p?$/u.test(w);

const TEST_TOOLS = new Set(["vitest", "jest", "pytest", "mocha", "rspec", "phpunit", "ava", "tap", "karma"]);
const RUNNERS = new Set(["npm", "pnpm", "yarn", "bun", "npx", "bunx", "pnpx", "deno"]);

/** A package script's name in words. */
const scriptSaid = (name: string): Said | undefined => {
  const n = name.toLowerCase();
  if (/(^|:)test|^e2e|spec/u.test(n)) return ["Running the tests", "Ran the tests"];
  if (/typecheck|tsc|types/u.test(n)) return ["Checking types", "Checked types"];
  if (/^lint/u.test(n)) return ["Running the linter", "Ran the linter"];
  if (/^(fmt|format)/u.test(n)) return ["Formatting the code", "Formatted the code"];
  if (/^check/u.test(n)) return ["Running the checks", "Ran the checks"];
  if (/^build/u.test(n)) return ["Building the app", "Built the app"];
  if (/^(dev|start|serve|preview)/u.test(n)) return ["Starting the app", "Started the app"];
  return undefined;
};

const GIT: Readonly<Record<string, Said>> = {
  status: ["Checking git status", "Checked git status"],
  diff: ["Looking at the changes", "Looked at the changes"],
  log: ["Reading the history", "Read the history"],
  show: ["Looking at a commit", "Looked at a commit"],
  blame: ["Reading the history", "Read the history"],
  add: ["Staging changes", "Staged changes"],
  commit: ["Committing", "Committed"],
  push: ["Pushing", "Pushed"],
  pull: ["Pulling the latest", "Pulled the latest"],
  fetch: ["Fetching", "Fetched"],
  checkout: ["Switching branches", "Switched branches"],
  switch: ["Switching branches", "Switched branches"],
  branch: ["Checking branches", "Checked branches"],
  rebase: ["Rebasing", "Rebased"],
  merge: ["Merging", "Merged"],
  "merge-tree": ["Checking the merge", "Checked the merge"],
  stash: ["Stashing changes", "Stashed changes"],
  reset: ["Resetting changes", "Reset changes"],
  restore: ["Restoring files", "Restored files"],
  clone: ["Cloning the repo", "Cloned the repo"],
  "cherry-pick": ["Picking a commit", "Picked a commit"],
  worktree: ["Setting up a worktree", "Set up a worktree"],
  tag: ["Tagging", "Tagged"],
  rm: ["Removing files", "Removed files"],
  mv: ["Moving files", "Moved files"],
};

const GH: Readonly<Record<string, Said>> = {
  "pr create": ["Opening a PR", "Opened a PR"],
  "pr merge": ["Merging the PR", "Merged the PR"],
  "pr comment": ["Commenting on the PR", "Commented on the PR"],
  "pr review": ["Reviewing the PR", "Reviewed the PR"],
  "pr edit": ["Editing the PR", "Edited the PR"],
  "pr checkout": ["Checking out the PR", "Checked out the PR"],
  pr: ["Checking the PR", "Checked the PR"],
  run: ["Checking CI", "Checked CI"],
  workflow: ["Checking CI", "Checked CI"],
  issue: ["Checking issues", "Checked issues"],
  release: ["Checking releases", "Checked releases"],
  repo: ["Checking the repo", "Checked the repo"],
  api: ["Asking GitHub", "Asked GitHub"],
};

const DEVICE: Readonly<Record<string, Said>> = {
  tap: ["Tapping", "Tapped"],
  click: ["Tapping", "Tapped"],
  press: ["Pressing", "Pressed"],
  fill: ["Typing in", "Typed in"],
  type: ["Typing", "Typed"],
  swipe: ["Swiping", "Swiped"],
  scroll: ["Scrolling", "Scrolled"],
  open: ["Opening", "Opened"],
  launch: ["Opening", "Opened"],
  install: ["Installing", "Installed"],
  back: ["Going back", "Went back"],
  home: ["Going to the home screen", "Went to the home screen"],
  screenshot: ["Taking a screenshot", "Took a screenshot"],
  snapshot: ["Reading the screen", "Read the screen"],
};

/** A simple command's words, or undefined when it says nothing of its own (setup, a filter, a lookup). */
const partSaid = (words: readonly string[], tense: Tense): { text: string; group?: StepLabel["group"] } | undefined => {
  const p = program(words[0]);
  const t = (s: Said) => ({ text: said(s, tense) });
  const sub = firstArg(words);
  if (words.includes("--help") || words.includes("-h") || sub === "help" || sub === "--version") return undefined;
  if (NOTHING.has(p)) return undefined;
  switch (p) {
    case "agent-browser":
      return browserSaid(words.slice(1), tense);
    case "agent-device": {
      const [verb = "", ...rest] = args(words);
      const s = DEVICE[verb.toLowerCase()];
      if (s === undefined) return t(["Using the phone", "Used the phone"]);
      const what = quotable(rest.join(" "));
      return { text: what === undefined ? said(s, tense) : `${said(s, tense)} “${what}”` };
    }
    case "git": {
      const s = GIT[sub ?? ""];
      if (sub === "commit" || sub === "add" || sub === "push") return t(s ?? ["Using git", "Used git"]);
      return t(s ?? ["Checking git", "Checked git"]);
    }
    case "gh": {
      const two = args(words).slice(0, 2).join(" ");
      return t(GH[two] ?? GH[sub ?? ""] ?? ["Using GitHub", "Used GitHub"]);
    }
    case "cargo":
    case "go":
      if (sub === "test") return t(["Running the tests", "Ran the tests"]);
      if (sub === "build" || sub === "run") return t(sub === "run" ? ["Running the app", "Ran the app"] : ["Building the app", "Built the app"]);
      if (sub === "check" || sub === "clippy" || sub === "vet") return t(["Running the checks", "Ran the checks"]);
      if (sub === "fmt") return t(["Formatting the code", "Formatted the code"]);
      if (sub === "install" || sub === "add" || sub === "get") return t(["Installing packages", "Installed packages"]);
      return t(["Running a command", "Ran a command"]);
    case "make":
      if (sub === undefined || sub === "build" || sub === "all") return t(["Building the app", "Built the app"]);
      return scriptSaid(sub) === undefined ? { text: `${tense === "present" ? "Running" : "Ran"} ${code(`make ${sub}`)}` } : t(scriptSaid(sub) as Said);
    case "tsc":
    case "tsc-rs":
    case "mypy":
    case "pyright":
      return t(["Checking types", "Checked types"]);
    case "eslint":
    case "ruff":
    case "biome":
    case "oxlint":
    case "stylelint":
    case "shellcheck":
      return t(["Running the linter", "Ran the linter"]);
    case "prettier":
    case "gofmt":
    case "black":
    case "rustfmt":
      return t(words.includes("--check") || words.includes("-c") ? ["Checking the format", "Checked the format"] : ["Formatting the code", "Formatted the code"]);
    case "vite":
    case "next":
    case "expo":
      if (sub === "build" || sub === "export") return t(["Building the app", "Built the app"]);
      return t(["Starting the app", "Started the app"]);
    case "xcodebuild":
    case "gradle":
    case "gradlew":
      return t(words.includes("test") ? ["Running the tests", "Ran the tests"] : ["Building the app", "Built the app"]);
    case "pip":
    case "pip3":
    case "brew":
    case "apt":
    case "apt-get":
      return sub === "install" || sub === "add" ? t(["Installing packages", "Installed packages"]) : t(["Checking packages", "Checked packages"]);
    case "rg":
    case "grep":
    case "ag":
    case "ack":
    case "git-grep": {
      const pattern = quotable(firstArg(words));
      return { text: pattern === undefined ? said(["Searching the code", "Searched the code"], tense) : `${tense === "present" ? "Searching" : "Searched"} for ${code(pattern)}` };
    }
    case "find":
    case "fd":
    case "locate":
    case "ls":
    case "tree":
    case "du":
      return t(["Looking through the files", "Looked through the files"]);
    case "cat":
    case "head":
    case "tail":
    case "less":
    case "bat":
    case "nl":
    case "wc":
    case "file":
    case "stat":
    case "xxd":
    case "hexdump":
    case "jq":
    case "diff":
    case "cmp":
    case "sed":
    case "awk": {
      // sed's, awk's and jq's first word is their script, unless -e or -f gave it.
      const scripted = (p === "sed" || p === "awk" || p === "jq") && !words.some((w) => w === "-e" || w === "-f" || w === "--expression");
      const files = args(words).slice(scripted ? 1 : 0).filter(looksLikeFile);
      if (p === "sed" && words.some((w) => w === "-i" || w.startsWith("-i"))) return fileSaid(files, ["Editing", "Edited"], tense);
      if (p === "cat" && words.some((w) => /^>{1,2}$/u.test(w) || /^\d*>/u.test(w))) return fileSaid(files, ["Writing", "Wrote"], tense);
      return fileSaid(files, ["Reading", "Read"], tense, ["Reading files", "Read files"]);
    }
    case "tee":
      return fileSaid(args(words).filter(looksLikeFile), ["Writing", "Wrote"], tense);
    case "touch":
      return fileSaid(args(words).filter(looksLikeFile), ["Creating", "Created"], tense);
    case "cp":
    case "rsync":
      return fileSaid(args(words).filter(looksLikeFile).slice(0, 1), ["Copying", "Copied"], tense, ["Copying files", "Copied files"]);
    case "mv":
      return fileSaid(args(words).filter(looksLikeFile).slice(0, 1), ["Moving", "Moved"], tense, ["Moving files", "Moved files"]);
    case "rm":
    case "rmdir":
      return fileSaid(args(words).filter(looksLikeFile), ["Deleting", "Deleted"], tense, ["Deleting files", "Deleted files"]);
    case "chmod":
    case "chown":
    case "ln":
      return t(["Setting up files", "Set up files"]);
    case "curl":
    case "wget":
    case "http":
    case "xh": {
      const site = args(words).map(siteOf).find((s) => s !== undefined);
      return { text: site === undefined ? said(["Fetching a page", "Fetched a page"], tense) : `${tense === "present" ? "Fetching" : "Fetched"} ${code(site)}` };
    }
    case "ssh":
    case "scp": {
      const host = firstArg(words)?.replace(/^[^@]*@/u, "").replace(/:.*$/u, "");
      return { text: `${tense === "present" ? "Working on" : "Worked on"} ${host === undefined || host === "" ? "another machine" : code(host)}` };
    }
    case "docker":
    case "podman":
      if (sub === "build") return t(["Building an image", "Built an image"]);
      if (sub === "compose") return t(["Starting containers", "Started containers"]);
      return t(["Using a container", "Used a container"]);
    case "kill":
    case "pkill":
    case "killall":
      return t(["Stopping a process", "Stopped a process"]);
    case "ps":
    case "pgrep":
    case "lsof":
    case "ss":
    case "netstat":
    case "top":
    case "free":
    case "df":
    case "uptime":
    case "nproc":
    case "systemctl":
    case "journalctl":
      return t(["Checking the machine", "Checked the machine"]);
    case "mac":
      if (words.includes("sim")) return t(["Starting an iPhone simulator", "Started an iPhone simulator"]);
      return t(["Working on the Mac", "Worked on the Mac"]);
    case "ffmpeg":
    case "convert":
    case "magick":
    case "sips":
      return t(["Making an image", "Made an image"]);
    case "zip":
    case "unzip":
    case "tar":
      return t(["Packing files", "Packed files"]);
    case "fleetd":
      return { text: `${tense === "present" ? "Running" : "Ran"} ${code(`fleetd${sub === undefined ? "" : ` ${sub}`}`)}` };
    case "sleep":
      return t(["Waiting", "Waited"]);
  }
  if (TEST_TOOLS.has(p) || p === "playwright") return t(["Running the tests", "Ran the tests"]);
  if (RUNNERS.has(p)) {
    // npm test, pnpm run build, bun test, bun x vitest, npx tsc, bun script.ts.
    const rest = args(words);
    const first = rest[0];
    if (first === undefined) return t(["Running a script", "Ran a script"]);
    if (first === "test" || first === "t") return t(["Running the tests", "Ran the tests"]);
    if (first === "install" || first === "i" || first === "ci" || first === "add") return t(["Installing packages", "Installed packages"]);
    if (first === "run" || first === "run-script") {
      const name = rest[1] ?? "";
      return { text: scriptSaid(name) !== undefined ? said(scriptSaid(name) as Said, tense) : `${tense === "present" ? "Running" : "Ran"} ${name === "" ? "a script" : code(name)}` };
    }
    if (first === "x" || first === "exec" || first === "dlx") return partSaid(rest.slice(1), tense);
    if (p === "npx" || p === "bunx" || p === "pnpx") return partSaid(rest, tense);
    if (looksLikeFile(first)) return { text: `${tense === "present" ? "Running" : "Ran"} ${code(fileName(first))}` };
    const s = scriptSaid(first);
    return { text: s !== undefined ? said(s, tense) : `${tense === "present" ? "Running" : "Ran"} ${code(first)}` };
  }
  if (/^(python[\d.]*|node|ruby|perl|php|bash|sh|zsh|osascript|swift)$/u.test(p)) {
    const file = firstArg(words);
    if (file !== undefined && looksLikeFile(file) && words[1] !== "-c" && words[1] !== "-e") return { text: `${tense === "present" ? "Running" : "Ran"} ${code(fileName(file))}` };
    // `perl -pi -e … file`: an edit.
    if (p === "perl" && words.some((w) => /^-p?i/u.test(w))) return fileSaid(args(words).filter(looksLikeFile), ["Editing", "Edited"], tense);
    return t(["Running a script", "Ran a script"]);
  }
  if (/^[a-z][a-z0-9_.+-]{0,30}$/u.test(p) && !p.includes("..")) return { text: `${tense === "present" ? "Running" : "Ran"} ${code(p)}` };
  return t(["Running a command", "Ran a command"]);
};

/** "Read index.html", "Read 3 files", or the words alone when no file was named. */
const fileSaid = (files: readonly string[], verb: Said, tense: Tense, none?: Said): { text: string; group?: StepLabel["group"] } => {
  const v = said(verb, tense);
  const names = files.map(fileName).filter((n, i, all) => all.indexOf(n) === i);
  if (names.length === 0) return { text: none === undefined ? `${v} a file` : said(none, tense) };
  if (names.length === 1) return { text: `${v} ${code(names[0] ?? "")}`, group: { key: `files:${v}`, many: (n) => `${v} ${plural(n, "a file", "files")}` } };
  return { text: `${v} ${plural(names.length, "a file", "files")}` };
};

/**
 * A command line in words (`tense`: while it runs, or once done), or undefined when it does nothing of its own: a
 * shell fragment, setup alone, a lookup of a tool. Its first part that does something speaks for it; a pipe's filters
 * and the setup before it (cd, export, mkdir) never do, and an echo or a wait only when it is all the line does.
 */
export const commandSaid = (command: string, tense: Tense = "past"): { text: string; group?: StepLabel["group"] } | undefined => {
  const parts = partsOf(command);
  let quiet: { text: string } | undefined;
  // A line that drives the browser speaks by its weightiest step (an open over a click over a read), as the replay does.
  let browser: { text: string; rank: number } | undefined;
  let first: { text: string; group?: StepLabel["group"] } | undefined;
  for (const part of parts) {
    const p = program(part.words[0]);
    if (p === "" || !/^[\w.+@~/$-]+$/u.test(part.words[0] ?? "")) continue;
    if (SETUP.has(p)) continue;
    if (part.piped && FILTERS.has(p)) continue;
    // `cat > notes.md`, `echo … >> log.txt`: writing that file.
    if ((p === "cat" || p === "echo" || p === "printf") && part.writes.length > 0) {
      first ??= fileSaid(part.writes, ["Writing", "Wrote"], tense);
      continue;
    }
    if (QUIET.has(p)) {
      quiet ??= p === "sleep" ? { text: tense === "present" ? "Waiting" : "Waited" } : undefined;
      continue;
    }
    if (p === "agent-browser") {
      const s = browserSaid(part.words.slice(1), tense);
      const rank = browserRank(part.words.slice(1));
      if (s !== undefined && (browser === undefined || rank < browser.rank)) browser = { ...s, rank };
      continue;
    }
    // A lookup or help says nothing: the rest of the line may still do something.
    first ??= partSaid(part.words, tense);
  }
  if (browser !== undefined) return { text: browser.text };
  return first ?? quiet;
};

/**
 * The browser command a line is about (the words after `agent-browser`, its flags left out), as commandSaid picks it:
 * the weightiest of the line's (an open over a click over a read). Undefined when the line drives no page: no
 * agent-browser, or only its help and setup.
 */
export const browserPart = (command: string): string[] | undefined => {
  let best: { words: string[]; rank: number } | undefined;
  for (const part of partsOf(command)) {
    if (program(part.words[0]) !== "agent-browser") continue;
    const words = browserCommand(part.words.slice(1));
    if (words.length === 0 || BROWSER_NOTHING.has(words[0]?.toLowerCase() ?? "") || !/^[a-z]/iu.test(words[0] ?? "")) continue;
    const rank = browserRank(words);
    if (best === undefined || rank < best.rank) best = { words, rank };
  }
  return best?.words;
};

/** How much a browser command says of what happened on the page: lower says more. */
const browserRank = (words: readonly string[]): number => {
  const verb = words.find((w) => !w.startsWith("-"))?.toLowerCase() ?? "";
  if (verb === "open" || verb === "goto" || verb === "navigate") return 0;
  if (/^(click|dblclick|tap|fill|type|press|key|select|check|uncheck|find|upload|download|pdf)$/u.test(verb)) return 1;
  if (/^(eval|scroll|scrollintoview|reload|back|forward|close|keyboard|mouse|hover|record)$/u.test(verb)) return 2;
  if (/^(screenshot|snapshot|get|wait)$/u.test(verb)) return 3;
  return 4;
};

// ---- the browser ----

const BROWSER: Readonly<Record<string, Said>> = {
  snapshot: ["Reading the page", "Read the page"],
  get: ["Reading the page", "Read the page"],
  screenshot: ["Taking a screenshot", "Took a screenshot"],
  eval: ["Running a script on the page", "Ran a script on the page"],
  wait: ["Waiting for the page", "Waited for the page"],
  scroll: ["Scrolling the page", "Scrolled the page"],
  scrollintoview: ["Scrolling the page", "Scrolled the page"],
  reload: ["Reloading the page", "Reloaded the page"],
  back: ["Going back", "Went back"],
  forward: ["Going forward", "Went forward"],
  close: ["Closing the browser", "Closed the browser"],
  hover: ["Pointing at the page", "Pointed at the page"],
  set: ["Setting up the browser", "Set up the browser"],
  tab: ["Switching tabs", "Switched tabs"],
  record: ["Recording the screen", "Recorded the screen"],
  console: ["Reading the page’s console", "Read the page’s console"],
  errors: ["Reading the page’s errors", "Read the page’s errors"],
  network: ["Reading the page’s requests", "Read the page’s requests"],
  mouse: ["Moving the pointer", "Moved the pointer"],
  keyboard: ["Typing", "Typed"],
  upload: ["Uploading a file", "Uploaded a file"],
  download: ["Downloading a file", "Downloaded a file"],
  pdf: ["Saving the page as a PDF", "Saved the page as a PDF"],
  cookies: ["Using the browser’s sign-ins", "Used the browser’s sign-ins"],
  state: ["Using the browser’s sign-ins", "Used the browser’s sign-ins"],
  storage: ["Using the browser’s sign-ins", "Used the browser’s sign-ins"],
};

/** agent-browser's own words: its help and setup, which touch no page. */
const BROWSER_NOTHING = new Set(["skills", "help", "version", "install", "--version", "session", "connect", "profiler", "trace", "addinitscript", "dialog"]);
/** agent-browser's flags that take a value, before its command. */
const BROWSER_VALUE_FLAGS = new Set(["--session", "--profile", "--cdp", "--port", "--timeout", "--state"]);

/** agent-browser's command and what follows it, without the flags before it. */
const browserCommand = (words: readonly string[]): string[] => {
  const rest: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    if (rest.length === 0 && w.startsWith("--")) {
      if (!w.includes("=") && BROWSER_VALUE_FLAGS.has(w)) i++;
      continue;
    }
    rest.push(w);
  }
  return rest;
};

/** A browser target's name when it is one: `text=Search`, a quoted label; never a ref (`@e3`) or a selector. */
export const browserTargetName = (target: string | undefined): string | undefined => {
  if (target === undefined) return undefined;
  const t = /^text=(.+)$/u.exec(target)?.[1] ?? target;
  return target.startsWith("@") || /[#.[\]>:=()]/u.test(t) ? undefined : quotable(t);
};

/** An agent-browser command (the words after `agent-browser`) in words; undefined for its help and setup. */
export const browserSaid = (words: readonly string[], tense: Tense, page?: { readonly title?: string | undefined; readonly url?: string | undefined }): { text: string } | undefined => {
  const rest = browserCommand(words);
  const [verb0 = "", a, b] = rest;
  const verb = verb0.toLowerCase();
  if (verb === "" || BROWSER_NOTHING.has(verb) || !/^[a-z]/u.test(verb)) return undefined;
  const v = (s: Said) => said(s, tense);
  switch (verb) {
    case "open":
    case "goto":
    case "navigate": {
      const url = a ?? page?.url;
      const name = pageName(page?.title, url);
      // A page by its title in words; by its site (no title known), as machine text.
      const site = name !== undefined && url !== undefined && (name === siteOf(url) || name === siteOf(`https://${url}`));
      return { text: `${tense === "present" ? "Opening" : "Opened"} ${name === undefined ? "a page" : site ? code(name) : name}` };
    }
    case "click":
    case "dblclick":
    case "tap": {
      const name = browserTargetName(a);
      return { text: name === undefined ? v(["Clicking on the page", "Clicked on the page"]) : `${tense === "present" ? "Clicking" : "Clicked"} “${name}”` };
    }
    case "fill":
    case "type": {
      const name = browserTargetName(a);
      return { text: name === undefined ? v(["Typing into the page", "Typed into the page"]) : `${tense === "present" ? "Typing into" : "Typed into"} “${name}”` };
    }
    case "press":
    case "key":
      return { text: a === undefined ? v(["Pressing a key", "Pressed a key"]) : `${tense === "present" ? "Pressing" : "Pressed"} ${a}` };
    case "select":
      return { text: quotable(b) === undefined ? v(["Choosing an option", "Chose an option"]) : `${tense === "present" ? "Choosing" : "Chose"} “${quotable(b) ?? ""}”` };
    case "check":
    case "uncheck":
      return { text: v(["Ticking a box", "Ticked a box"]) };
    case "find": {
      // find role button --name "Search" click
      const at = rest.indexOf("--name");
      const name = at === -1 ? quotable(rest[2]) : quotable(rest[at + 1]);
      const act = rest[rest.length - 1]?.toLowerCase();
      if (act === "click") return { text: name === undefined ? v(["Clicking on the page", "Clicked on the page"]) : `${tense === "present" ? "Clicking" : "Clicked"} “${name}”` };
      if (act === "fill" || act === "type") return { text: name === undefined ? v(["Typing into the page", "Typed into the page"]) : `${tense === "present" ? "Typing into" : "Typed into"} “${name}”` };
      return { text: v(["Reading the page", "Read the page"]) };
    }
  }
  const s = BROWSER[verb];
  return { text: s === undefined ? v(["Using the browser", "Used the browser"]) : v(s) };
};

/**
 * Whether a browser step failed, and why. agent-browser says so itself: "✗ <why>" on a failure, "✓" when it worked;
 * either outranks the shell's exit, which may be a command chained after it (`… && rg x`, `| tail -1`). With
 * neither (its output sent elsewhere), the exit counts only for a line that is that one command.
 */
export const browserFailed = (command: string, ok: boolean, result: string | undefined): string | undefined => {
  const lines = (result ?? "").split("\n").map((l) => l.trim());
  const bad = lines.find((l) => l.startsWith("✗"));
  if (bad !== undefined) {
    // Its first sentence: "Element not found: @e9. Verify the selector…" → "Element not found: @e9".
    const why = bad.slice(1).trim().split(/\.\s/u)[0]?.replace(/[.:]$/u, "") ?? "";
    return why === "" ? "failed" : `failed: ${why}`;
  }
  if (ok || lines.some((l) => l.startsWith("✓"))) return undefined;
  const parts = partsOf(command).filter((p) => !SETUP.has(program(p.words[0])) && !(p.piped && FILTERS.has(program(p.words[0]))));
  return parts.length === 1 ? "failed" : undefined;
};

/** The page an `open` landed on, from agent-browser's own answer: "✓ <title>" then its URL. */
export const openedTitle = (result: string | undefined): string | undefined => {
  const first = (result ?? "").split("\n").map((l) => l.trim()).find((l) => l.startsWith("✓"));
  const t = first?.slice(1).trim();
  return t === undefined || t === "" || t === "Done" || /^(Screenshot|State|Saved|Clicked|Filled)\b/u.test(t) ? undefined : t;
};

// ---- tools ----

/** fleetd's own tools (agents' and leads'), by name: [while it runs, once done]. Absent: said as "Used fleetd". */
const FLEETD: Readonly<Record<string, Said>> = {
  spawn_agent: ["Starting an agent", "Started an agent"],
  message_agent: ["Messaging an agent", "Messaged an agent"],
  agent_message: ["Messaging an agent", "Messaged an agent"],
  agents: ["Checking on the agents", "Checked on the agents"],
  agent_messages: ["Reading the agents’ messages", "Read the agents’ messages"],
  stop_agent: ["Stopping an agent", "Stopped an agent"],
  brief: ["Writing a brief", "Wrote a brief"],
  brief_read: ["Reading the brief", "Read the brief"],
  checklist: ["Updating the checklist", "Updated the checklist"],
  plan: ["Planning", "Planned"],
  decide: ["Noting a decision", "Noted a decision"],
  decisions_record: ["Noting a decision", "Noted a decision"],
  decisions_search: ["Looking up decisions", "Looked up decisions"],
  close: ["Closing the order", "Closed the order"],
  remember: ["Remembering", "Remembered"],
  forget: ["Forgetting a note", "Forgot a note"],
  memory_read: ["Reading its memory", "Read its memory"],
  nudge: ["Setting a reminder", "Set a reminder"],
  automation_create: ["Setting up an automation", "Set up an automation"],
  automation_update: ["Changing an automation", "Changed an automation"],
  automation_delete: ["Deleting an automation", "Deleted an automation"],
  automation_run: ["Running an automation", "Ran an automation"],
  automation_list: ["Checking automations", "Checked automations"],
  automation_runs: ["Checking automations", "Checked automations"],
  skill_install: ["Adding a skill", "Added a skill"],
  skill_save: ["Saving a skill", "Saved a skill"],
  gated_run: ["Asking to run a command", "Asked to run a command"],
  request_secret: ["Asking you for a value", "Asked you for a value"],
  ask_lead: ["Asking the lead", "Asked the lead"],
  report: ["Filing its review", "Filed its review"],
  review_read: ["Reading review findings", "Read review findings"],
  wait_ci: ["Waiting on CI", "Waited on CI"],
  change_enqueue: ["Queueing a PR", "Queued a PR"],
  chat_file: ["Sending a file", "Sent a file"],
  chat_search: ["Searching the chat", "Searched the chat"],
  chat_read: ["Reading the chat", "Read the chat"],
  publish_artifact: ["Publishing a report", "Published a report"],
  artifact_read: ["Reading a report", "Read a report"],
  attachment_read: ["Opening a file", "Opened a file"],
  session_start: ["Opening a screen", "Opened a screen"],
  session_end: ["Closing the screen", "Closed the screen"],
  desktop: ["Using the screen", "Used the screen"],
  request_takeover: ["Asking you to take over", "Asked you to take over"],
  request_sign_in: ["Asking you to sign in", "Asked you to sign in"],
  fill_credential: ["Signing in", "Signed in"],
  fill_address: ["Filling in an address", "Filled in an address"],
  purchase_request: ["Checking out", "Checked out"],
  vault_items: ["Checking the vault", "Checked the vault"],
  vault_store: ["Saving to the vault", "Saved to the vault"],
  repo_add: ["Adding a repo", "Added a repo"],
  repo_create: ["Creating a repo", "Created a repo"],
  repo_remove: ["Removing a repo", "Removed a repo"],
  factory_status: ["Checking the workspace", "Checked the workspace"],
  confirm_step: ["Confirming a step", "Confirmed a step"],
  project_message: ["Messaging another bot", "Messaged another bot"],
};

/** Claude's own tools, by name. */
const CLAUDE: Readonly<Record<string, Said>> = {
  TodoWrite: ["Planning", "Updated its plan"],
  Task: ["Starting a helper", "Started a helper"],
  Agent: ["Starting a helper", "Started a helper"],
  WebSearch: ["Searching the web", "Searched the web"],
  WebFetch: ["Reading the web", "Read the web"],
  NotebookEdit: ["Editing a notebook", "Edited a notebook"],
  ExitPlanMode: ["Planning", "Planned"],
  KillShell: ["Stopping a command", "Stopped a command"],
  BashOutput: ["Checking a command", "Checked a command"],
  Monitor: ["Watching a command", "Watched a command"],
};

/** Claude's tools that touch nothing: its own help and tool lookups. */
const CLAUDE_NOTHING = new Set(["Skill", "ToolSearch", "ListMcpResourcesTool", "ReadMcpResourceTool", "LS"]);

/** `mcp__<server>__<tool>` as [server, tool]. */
const mcpName = (name: string): readonly [string, string] | undefined => {
  if (!name.startsWith("mcp__")) return undefined;
  const rest = name.slice(5);
  const at = rest.indexOf("__");
  return at < 0 ? undefined : [rest.slice(0, at), rest.slice(at + 2)];
};

/** A server's name as people read it: "Paper", "Notion", "Linear". */
const serverName = (server: string): string => (server === "" ? "a connection" : `${server.charAt(0).toUpperCase()}${server.slice(1)}`);

/** A tool call in words, by its name and what it acted on (a path, a pattern, a URL or query); undefined: touched nothing. */
export const toolSaid = (name: string, target: string | undefined, tense: Tense, server?: string): { text: string; group?: StepLabel["group"] } | undefined => {
  const mcp = mcpName(name);
  const srv = server ?? mcp?.[0];
  const tool = mcp?.[1] ?? name;
  if (srv === "fleetd" || (srv === undefined && FLEETD[tool] !== undefined && CLAUDE[tool] === undefined)) {
    const s = FLEETD[tool] ?? (/^(change_|review_)/u.test(tool) ? (["Moving a PR along", "Moved a PR along"] as const) : undefined);
    if (tool === "spawn_agent") return { text: said(FLEETD["spawn_agent"] as Said, tense), group: { key: "spawn", each: true, many: (n) => `${tense === "present" ? "Starting" : "Started"} ${plural(n, "an agent", "agents")}` } };
    return { text: said(s ?? ["Checking with fleetd", "Checked with fleetd"], tense) };
  }
  if (srv !== undefined) return { text: `${tense === "present" ? "Using" : "Used"} ${serverName(srv)}` };
  if (CLAUDE_NOTHING.has(tool)) return undefined;
  switch (tool) {
    case "Read":
    case "NotebookRead":
      return target === undefined || target === "" ? { text: tense === "present" ? "Reading a file" : "Read a file" } : fileSaid([target], ["Reading", "Read"], tense);
    case "Grep":
    case "Glob": {
      const q = quotable(target);
      return { text: q === undefined ? said(["Searching the code", "Searched the code"], tense) : `${tense === "present" ? "Searching" : "Searched"} for ${code(q)}` };
    }
    case "WebFetch": {
      const site = target === undefined ? undefined : siteOf(target);
      return { text: site === undefined ? said(["Reading the web", "Read the web"], tense) : `${tense === "present" ? "Reading" : "Read"} ${code(site)}` };
    }
    case "WebSearch": {
      const q = quotable(target);
      return { text: q === undefined ? said(["Searching the web", "Searched the web"], tense) : `${tense === "present" ? "Searching the web for" : "Searched the web for"} “${q}”` };
    }
    case "Edit":
    case "MultiEdit":
      return fileSaid(target === undefined ? [] : [target], ["Editing", "Edited"], tense);
    case "Write":
      return fileSaid(target === undefined ? [] : [target], ["Writing", "Wrote"], tense);
  }
  const s = CLAUDE[tool];
  return { text: said(s ?? ["Working", "Worked"], tense) };
};

// ---- the three inputs ----

/**
 * What a lead or agent does this moment (its live lane's activity), in words: "Editing index.html", "Running the
 * tests", "Starting an agent". Undefined while it only thinks or writes: its glyph says that, and a row with no words
 * says it by its time alone.
 */
export const activityLabel = (a: Activity): string | undefined => {
  switch (a.kind) {
    case "read":
      if (a.path !== undefined && a.path !== "") return `Reading ${code(fileName(a.path))}`;
      return quotable(a.pattern) === undefined ? "Searching the code" : `Searching for ${code(quotable(a.pattern) ?? "")}`;
    case "edit":
      return `Editing ${code(fileName(a.path))}`;
    case "command":
      return commandSaid(a.text, "present")?.text ?? "Running a command";
    case "web":
      return a.detail !== undefined && a.detail !== "" && siteOf(`https://${a.detail}`) !== undefined && !a.detail.includes(" ") ? `Reading ${code(siteOf(`https://${a.detail}`) ?? "")}` : "Searching the web";
    case "planning":
      return "Planning";
    case "compacting":
      return "Tidying its notes";
    case "retrying":
      return undefined;
    case "starting":
      return a.text;
    case "tool":
      return toolSaid(a.name, undefined, "present", a.server)?.text;
    case "thinking":
    case "writing":
      return undefined;
  }
};

/** A model's thought, as the runner titles it ("Thinking: …"): its words, whole sentences only. */
const thoughtOf = (summary: string): string | undefined => {
  const m = /^Thinking:\s*(.*)$/su.exec(summary);
  if (m === null) return undefined;
  return wholeSentences(m[1] ?? "");
};

/** Text cut short by its sender ends at its last whole sentence, or with an ellipsis after its last whole word. */
export const wholeSentences = (text: string): string => {
  const t = text.trim().replace(/\s+/gu, " ");
  if (t === "" || /[.!?:…)"”’]$/u.test(t)) return t;
  const end = Math.max(t.lastIndexOf(". "), t.lastIndexOf("! "), t.lastIndexOf("? "));
  if (end > 20) return t.slice(0, end + 1);
  const space = t.lastIndexOf(" ");
  return `${space > 20 ? t.slice(0, space) : t}…`;
};

const failedWords = (a: Pick<ActionItem, "failed" | "exitCode">): string | undefined =>
  !a.failed ? undefined : a.exitCode === undefined ? "failed" : `failed, exit ${String(a.exitCode)}`;

/**
 * One step of an agent's log (agent_work, actions_list) in words, or undefined for a step that touched nothing (a
 * tool's own help, a shell fragment). A command: its first part that does something ("Ran the tests"), the whole
 * command as `raw`; an edit: the file's name ("Edited index.html"), its path as `raw`; a thought: its words, whole.
 */
export const actionLabel = (a: ActionItem & { readonly target?: string | undefined }): StepLabel | undefined => {
  const running = a.status === "running";
  const tense: Tense = running ? "present" : "past";
  const failed = failedWords(a);
  const base = { ...(running ? { running: true as const } : {}), ...(failed === undefined ? {} : { failed }) };
  switch (a.kind) {
    case "command": {
      const raw = a.summary.trim();
      const s = commandSaid(raw, tense);
      if (s === undefined) return failed === undefined ? undefined : { text: tense === "present" ? "Running a command" : "Ran a command", raw, ...base };
      return { ...s, raw, ...base };
    }
    case "file_change": {
      // The runner's summary is the path; an older one's, "Edit <path>".
      const path = a.summary.replace(/^(Edit|MultiEdit|Write|NotebookEdit)\s+/u, "").trim();
      const wrote = a.summary.startsWith("Write ");
      const s = fileSaid(path === "" ? [] : [path], wrote ? ["Writing", "Wrote"] : ["Editing", "Edited"], tense);
      return { ...s, ...(path === "" ? {} : { raw: path }), ...base };
    }
    case "tool_call": {
      const thought = thoughtOf(a.summary);
      if (thought !== undefined) return thought === "" ? undefined : { text: thought, prose: true };
      const name = a.summary.trim().split(/\s/u)[0] ?? "";
      const s = toolSaid(name, a.target, tense);
      if (s === undefined) return undefined;
      const raw = a.target === undefined ? (name.startsWith("mcp__") ? name : undefined) : a.target;
      return { ...s, ...(raw === undefined ? {} : { raw }), ...base };
    }
    case "other":
      // A start's step, a retry, an error: already words, and kept whole.
      return { text: a.summary.trim(), prose: true, ...base };
  }
};

/** One step of agent_work: an action as actionLabel says it; a message of the agent's, whole, as prose. */
export const stepLabel = (step: WorkStep): StepLabel | undefined => {
  if (step.kind === "action") return actionLabel(step.action);
  const text = step.text.trim();
  return text === "" ? undefined : { text: wholeSentences(text), prose: true };
};

/**
 * Steps as a list reads them: steps that read as one in a row merge ("Started 3 agents", "Read 4 files"), and the same
 * words twice in a row show once. Oldest first, as given.
 */
export const mergeSteps = (labels: readonly StepLabel[]): StepLabel[] => {
  const out: StepLabel[] = [];
  // The run being merged: how many steps, and the different words among them (files read twice count once).
  let run = { steps: 1, words: new Set<string>() };
  for (const l of labels) {
    const prev = out[out.length - 1];
    if (prev !== undefined && prev.failed === undefined && l.failed === undefined && prev.running !== true) {
      const g = l.group;
      if (g !== undefined && prev.group?.key === g.key) {
        run.steps += 1;
        run.words.add(l.text);
        const n = g.each === true ? run.steps : run.words.size;
        out[out.length - 1] = n === 1 ? { ...l } : { ...l, text: g.many(n), raw: undefined };
        continue;
      }
      if (prev.text === l.text) {
        out[out.length - 1] = { ...prev, running: l.running };
        continue;
      }
    }
    run = { steps: 1, words: new Set([l.text]) };
    out.push(l);
  }
  return out;
};
