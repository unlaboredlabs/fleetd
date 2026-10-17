// Reading playbook files: YAML frontmatter checked against the Playbook schema, pinned by git blob SHA. Pure apart
// from the directory reads.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Playbook, PlaybookName, PlaybookRef } from "@fleetd/contracts";
import * as Schema from "effect/Schema";
import { parseDocument } from "yaml";

export class PlaybookError extends Schema.TaggedError<PlaybookError>()("PlaybookError", { message: Schema.String }) {}

export interface LoadedPlaybook {
  readonly ref: PlaybookRef;
  readonly playbook: Playbook;
  /** The whole file, as hashed. */
  readonly text: string;
}

/** What `git hash-object <file>` prints for these bytes. */
export const gitBlobSha = (content: string | Uint8Array): string => {
  const bytes = typeof content === "string" ? Buffer.from(content, "utf8") : content;
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
};

const decodeRef = Schema.decodeUnknownSync(PlaybookRef);
const isName = Schema.is(PlaybookName);

/** Parses one playbook file. `expectedName` is the file's base name, which must match its `name`. */
export const parsePlaybook = (text: string, where: string, expectedName?: string): LoadedPlaybook => {
  const invalid = (problem: string) => new PlaybookError({ message: `playbook ${where} is invalid: ${problem}`.slice(0, 1000) });
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(text);
  if (match === null) throw invalid("it must start with YAML frontmatter between two `---` lines");
  const doc = parseDocument(match[1]!, { prettyErrors: true });
  if (doc.errors.length > 0) throw invalid(`YAML: ${doc.errors[0]!.message.split("\n")[0]}`);
  const decoded = Schema.decodeUnknownExit(Playbook)(doc.toJS());
  if (decoded._tag === "Failure") {
    const error = decoded.cause.reasons.find((r) => r._tag === "Fail")?.error;
    throw invalid(error instanceof Error ? error.message.replace(/\n\s*/gu, " ") : "the frontmatter does not match the Playbook shape");
  }
  const playbook = decoded.value;
  if (expectedName !== undefined && playbook.name !== expectedName) throw invalid(`its name is ${playbook.name} but the file is ${expectedName}.md`);
  return { ref: decodeRef(`${playbook.name}@${gitBlobSha(text)}`), playbook, text };
};

/** Every `<name>.md` in `dir`, by name. A missing directory has none; any other `.md` file there is an error. */
export const loadDir = (dir: string): ReadonlyMap<PlaybookName, LoadedPlaybook> => {
  const loaded = new Map<PlaybookName, LoadedPlaybook>();
  let files: Array<string>;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return loaded;
    throw new PlaybookError({ message: `cannot read playbooks in ${dir}: ${(error as Error).message}` });
  }
  for (const file of files) {
    const name = file.slice(0, -".md".length);
    const where = path.join(dir, file);
    if (!isName(name)) {
      throw new PlaybookError({ message: `playbook ${where} is invalid: playbooks are named ${PlaybookName.literals.join(", ")}` });
    }
    loaded.set(name, parsePlaybook(fs.readFileSync(where, "utf8"), where, name));
  }
  return loaded;
};

/** fleetd's own playbooks: copied beside the CLI bundle by its build, or the repo's `playbooks/` in the source tree. */
export const bundledDir = (): string => {
  const candidates = [new URL("./playbooks/", import.meta.url), new URL("../../../../playbooks/", import.meta.url)];
  const found = candidates.find((url) => fs.existsSync(url));
  if (found === undefined) throw new PlaybookError({ message: "fleetd's bundled playbooks are missing from this build" });
  return fileURLToPath(found);
};

/** The bundled playbooks with the user's overrides on top; every name must end up with one. */
export const loadAll = (bundled: string, overrides: string | undefined): ReadonlyMap<PlaybookName, LoadedPlaybook> => {
  const all = new Map([...loadDir(bundled), ...(overrides === undefined ? [] : loadDir(overrides))]);
  const missing = PlaybookName.literals.filter((name) => !all.has(name));
  if (missing.length > 0) throw new PlaybookError({ message: `no playbook for ${missing.join(", ")} in ${bundled}` });
  return all;
};
