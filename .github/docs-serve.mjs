// Serves site/ the way Vercel does for a browser (clean URLs, `/` is home.html), to read the docs locally:
//   node .github/docs-serve.mjs [port]     then open http://127.0.0.1:4791/docs
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "../site");
const port = Number(process.argv[2] ?? 4791);
const types = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2", ".txt": "text/plain; charset=utf-8", ".sh": "text/plain; charset=utf-8" };

/** The file a clean URL names: /docs -> docs/index.html, /docs/x -> docs/x.html, / -> home.html. */
export function resolve(urlPath) {
  const clean = decodeURIComponent(urlPath).replace(/\/+$/u, "");
  const candidates = clean === "" ? ["home.html"] : [clean, `${clean}.html`, `${clean}/index.html`];
  for (const c of candidates) {
    const file = path.join(root, c);
    if (file.startsWith(root) && fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return file;
  }
  return undefined;
}

if (import.meta.main) {
  http
    .createServer((req, res) => {
      const file = resolve(new URL(req.url, "http://x").pathname);
      if (file === undefined) {
        res.writeHead(404).end("not found\n");
        return;
      }
      res.writeHead(200, { "content-type": types[path.extname(file)] ?? "application/octet-stream" });
      fs.createReadStream(file).pipe(res);
    })
    .listen(port, "127.0.0.1", () => console.log(`http://127.0.0.1:${port}/docs`));
}
