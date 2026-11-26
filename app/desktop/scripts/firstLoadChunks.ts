// A build plugin and the chunk groups it feeds, for the web's first load (vite.web.config.ts): what the first chat
// draws comes as a few files, not one per shared module.
//
// - `main`: the app (a chunk loaded by import(), named in index.html) with every module only it and what loads after
//   it import. Left to Rolldown, a module the app shares with a screen loaded later (Settings, a sheet) is a chunk of
//   its own, since Rolldown can't tell that screen loads only once the app has run: a dozen files of a few hundred
//   bytes each in the first load. A module that can load before the app (the entry's, or one a chunk the entry imports
//   by import() reaches: the gate, Shiki, the side panel) stays out of it, so the gate never runs the app's modules.
// - `icons`: the icons the first chat's modules import, in one file (each would be ~200 bytes of its own). An icon
//   only a later screen draws comes with that screen.
import type { Plugin } from "vite";

/** Every icon of lucide-react's index, by each name it exports: `ChevronRight` → its module's path's end. */
const iconFiles = (index: string): Map<string, string> => {
  const files = new Map<string, string>();
  for (const m of index.matchAll(/export\s*\{([^}]*)\}\s*from\s*["']\.\/icons\/([\w-]+\.mjs)["']/gu))
    for (const name of (m[1] ?? "").split(",")) {
      const as = /as\s+(\w+)/u.exec(name)?.[1];
      if (as !== undefined) files.set(as, `/icons/${m[2] ?? ""}`);
    }
  return files;
};

/** The names a module's code imports from lucide-react, or null when it takes them all (a namespace or import()). */
const iconNames = (code: string): string[] | null => {
  if (/import\s*\*\s*as\s+\w+\s+from\s*["']lucide-react["']|import\(\s*["']lucide-react["']\s*\)/u.test(code)) return null;
  const names: string[] = [];
  for (const m of code.matchAll(/import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["']lucide-react["']/gu))
    for (const part of (m[1] ?? "").split(",")) {
      const name = part.trim();
      if (name === "" || name.startsWith("type ")) continue;
      names.push(name.split(/\s+as\s+/u)[0] ?? name);
    }
  return names;
};

export interface FirstLoadChunks {
  /** The page's entry, from app/desktop. */
  readonly entry: string;
  /** The app, from app/desktop: the entry imports it by import() once the session is read. */
  readonly app: string;
}

export const firstLoadChunks = ({ entry, app }: FirstLoadChunks) => {
  const inApp = new Set<string>();
  const firstIcons = new Set<string>();
  let allIcons = false;
  const plugin: Plugin = {
    name: "fleetd-first-load-chunks",
    apply: "build",
    buildEnd(error) {
      if (error !== undefined) return;
      const ids = [...this.getModuleIds()];
      const at = (source: string) => {
        // By its path's end, as preloadChunks finds its entries.
        const id = ids.find((i) => i.endsWith(`/app/desktop/${source}`));
        if (id === undefined) throw new Error(`fleetd-first-load-chunks: ${source} isn't in the build`);
        return id;
      };
      const statics = (roots: Iterable<string>) => {
        const seen = new Set(roots);
        const queue = [...seen];
        for (let id = queue.pop(); id !== undefined; id = queue.pop())
          for (const next of this.getModuleInfo(id)?.importedIds ?? [])
            if (!seen.has(next)) {
              seen.add(next);
              queue.push(next);
            }
        return seen;
      };
      const appId = at(app);
      const page = statics([at(entry)]);
      // What can load before the app: whatever the page's own modules import by import(), but the app, and theirs.
      const early = new Set<string>();
      for (const id of page) for (const next of this.getModuleInfo(id)?.dynamicallyImportedIds ?? []) if (next !== appId) early.add(next);
      const before = statics(early);
      inApp.clear();
      // The app's own module stays the chunk the page imports: captured in a group, Rolldown names its exports in the
      // group's chunk and leaves the import() a chunk that exports them undefined (1.2.14).
      for (const id of statics([appId])) if (id !== appId && !page.has(id) && !before.has(id)) inApp.add(id);

      firstIcons.clear();
      allIcons = false;
      const index = ids.find((i) => /lucide-react[\\/]dist[\\/]esm[\\/]lucide-react\.mjs$/u.test(i));
      const files = iconFiles(index === undefined ? "" : (this.getModuleInfo(index)?.code ?? ""));
      for (const id of [...page, ...inApp]) {
        if (id.includes("node_modules")) continue;
        const names = iconNames(this.getModuleInfo(id)?.code ?? "");
        if (names === null) allIcons = true;
        for (const name of names ?? []) {
          const file = files.get(name);
          if (file !== undefined) firstIcons.add(file);
        }
      }
    },
  };
  const icon = (id: string) => {
    const path = id.replace(/\\/gu, "/");
    return /lucide-react\/dist\/esm\/icons\//u.test(path) ? path.slice(path.lastIndexOf("/icons/")) : null;
  };
  const groups = [
    {
      name: "icons",
      test: (id: string) => {
        const file = icon(id);
        return file !== null && (allIcons || firstIcons.has(file));
      },
    },
    // Only the modules found above: Rolldown's default would add their imports too, the page's own among them.
    { name: "main", test: (id: string) => inApp.has(id), includeDependenciesRecursively: false },
  ];
  return { plugin, groups };
};
