// A build plugin for the renderer's index.html: the chunks the first screen draws, named up front. Each is loaded by
// import(), so without a hint the page finds them one at a time (entry → app → panel → panes), a round trip each on
// the web and a turn of the event loop each on the desktop. Named here, each chunk and its static imports come as a
// modulepreload (fetched and parsed with the entry, run only when imported) and their styles as a preload (the
// stylesheet the import adds then comes from the cache). With `fonts`, those fonts too (after the chunks), which the
// page's text waits for (font-display: block). `later` chunks come the same way at low priority, so on a connection
// with few requests at a time (HTTP/1.1) they wait behind what the first paint needs. The web's check
// (scripts/web-check.ts) holds what it names to a budget.
import type { HtmlTagDescriptor, Plugin, Rollup } from "vite";

export interface PreloadChunks {
  /** Source files, from app/desktop, each the entry of a chunk of its own (a dynamic import's target). */
  readonly entries: readonly string[];
  /** The same, for what the screen draws after its first paint (a side panel): preloaded at low priority. */
  readonly later?: readonly string[];
  /** Preload the build's fonts whose file names match too. */
  readonly fonts?: RegExp;
}

export const preloadChunks = ({ entries, later = [], fonts }: PreloadChunks): Plugin => {
  let base = "/";
  return {
    name: "fleetd-preload-chunks",
    apply: "build",
    configResolved(config) {
      base = config.base;
    },
    transformIndexHtml: {
      order: "post",
      handler(html, { bundle, path }) {
        // The app's own page only, not another input of the same build (the desktop's recorder page).
        if (bundle === undefined || path !== "/index.html") return html;
        const chunks = Object.values(bundle).filter((o): o is Rollup.OutputChunk => o.type === "chunk");
        // What the page already names (its entry and the entry's own imports) stays as Vite wrote it.
        const seen = new Set<string>([...Object.keys(bundle)].filter((f) => html.includes(`/${f}"`)));
        /** Each source's chunk and its static imports, and their styles, that nothing before has named. */
        const closure = (sources: readonly string[]) => {
          const files: string[] = [];
          const css: string[] = [];
          const add = (chunk: Rollup.OutputChunk): void => {
            if (seen.has(chunk.fileName)) return;
            seen.add(chunk.fileName);
            files.push(chunk.fileName);
            for (const c of chunk.viteMetadata?.importedCss ?? []) {
              if (seen.has(c)) continue;
              seen.add(c);
              css.push(c);
            }
            for (const name of chunk.imports) {
              const next = bundle[name];
              if (next?.type === "chunk") add(next);
            }
          };
          for (const source of sources) {
            // By its path's end: electron-vite bundles its config elsewhere, so this file's own folder is no anchor.
            const chunk = chunks.find((c) => c.facadeModuleId?.endsWith(`/app/desktop/${source}`) === true);
            if (chunk === undefined)
              throw new Error(
                `fleetd-preload-chunks: ${source} is no chunk of its own (renamed, or no longer imported by import()?)`,
              );
            add(chunk);
          }
          return { files, css };
        };
        const link = (attrs: Record<string, string | boolean>): HtmlTagDescriptor => ({
          tag: "link",
          attrs,
          injectTo: "head",
        });
        const tags = (set: { files: string[]; css: string[] }, low: boolean) => {
          const priority = low ? { fetchpriority: "low" } : {};
          return [
            ...set.files.map((f) =>
              link({ rel: "modulepreload", ...priority, crossorigin: true, href: `${base}${f}` }),
            ),
            ...set.css.map((f) =>
              link({ rel: "preload", as: "style", ...priority, crossorigin: true, href: `${base}${f}` }),
            ),
          ];
        };
        const first = closure(entries);
        const after = closure(later);
        const faces =
          fonts === undefined ? [] : Object.keys(bundle).filter((f) => f.endsWith(".woff2") && fonts.test(f));
        // The fonts after the first chunks: the text waits on both, but the app's script on nothing else, and its start
        // (the hub's socket) is what the rest waits on.
        return [
          ...tags(first, false),
          ...faces.map((f) =>
            link({ rel: "preload", as: "font", type: "font/woff2", crossorigin: true, href: `${base}${f}` }),
          ),
          ...tags(after, true),
        ];
      },
    },
  };
};
