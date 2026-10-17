// Repo-relative path globs for policy areas. `**` spans any number of directories (including none), `*` and `?`
// stay within one path segment, `{a,b}` is alternation and `[...]` a character class (`[!...]` negated). A glob
// without wildcards names a file or a directory, so "docs" covers everything under docs/. Dotfiles are not
// special: an area check is about where a change lands, not about hiding files.

const strip = (p: string) => p.replace(/^(?:\.\/)+/u, "");

const escape = (c: string) => c.replace(/[.+^$()|\\/\]}]/u, (m) => `\\${m}`);

/** Index of the brace that closes the one at `open`, or -1. */
const closingBrace = (glob: string, open: number) => {
  let depth = 0;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === "{") depth++;
    else if (glob[i] === "}" && --depth === 0) return i;
  }
  return -1;
};

/** Splits a brace body on top-level commas. */
const alternatives = (body: string) => {
  const parts: Array<string> = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "{") depth++;
    else if (body[i] === "}") depth--;
    else if (body[i] === "," && depth === 0) {
      parts.push(body.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(body.slice(start));
  return parts;
};

const toSource = (glob: string): string => {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*") {
      if (glob[i + 1] === "*") {
        const atSegmentStart = i === 0 || glob[i - 1] === "/";
        if (atSegmentStart && glob[i + 2] === "/") {
          out += "(?:[^/]*/)*";
          i += 2;
          continue;
        }
        if (atSegmentStart && i + 2 === glob.length) {
          out += ".*";
          i += 1;
          continue;
        }
        i += 1;
      }
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "[") {
      const close = glob.indexOf("]", i + 2);
      if (close === -1) {
        out += "\\[";
        continue;
      }
      const body = glob.slice(i + 1, close);
      const negated = body.startsWith("!") || body.startsWith("^");
      out += `[${negated ? "^/" : ""}${(negated ? body.slice(1) : body).replace(/\\/gu, "\\\\")}]`;
      i = close;
    } else if (c === "{") {
      const close = closingBrace(glob, i);
      if (close === -1) {
        out += "\\{";
        continue;
      }
      out += `(?:${alternatives(glob.slice(i + 1, close)).map(toSource).join("|")})`;
      i = close;
    } else {
      out += escape(c);
    }
  }
  return out;
};

const WILDCARD = /[*?[{]/u;

/** A predicate for repo-relative paths. */
export const globMatcher = (glob: string): ((path: string) => boolean) => {
  let g = strip(glob.trim());
  if (g.endsWith("/")) g = `${g}**`;
  if (g === "" || g === "**") return () => true;
  if (!WILDCARD.test(g)) return (path) => {
    const p = strip(path);
    return p === g || p.startsWith(`${g}/`);
  };
  const re = new RegExp(`^${toSource(g)}$`, "u");
  return (path) => re.test(strip(path));
};

/** Paths that no glob matches, in input order. */
export const outsideGlobs = (paths: ReadonlyArray<string>, globs: ReadonlyArray<string>): ReadonlyArray<string> => {
  const matchers = globs.map(globMatcher);
  return paths.filter((p) => !matchers.some((m) => m(p)));
};
