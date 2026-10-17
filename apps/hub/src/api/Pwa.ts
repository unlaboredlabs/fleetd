// The phone web app, served as static files at `/` on the hub's own origin (its only API is /app).
import crypto from "node:crypto";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

/**
 * Where the built app is: beside the CLI bundle (`apps/cli/dist/pwa`, copied there by its build), else the hub's
 * own `dist/pwa` when the hub runs from source.
 */
export const findPwaDir = (): string | undefined =>
  [new URL("./pwa/", import.meta.url), new URL("../../dist/pwa/", import.meta.url)]
    .map((url) => fileURLToPath(url))
    .find((dir) => fs.existsSync(`${dir}index.html`));

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  webmanifest: "application/manifest+json",
  svg: "image/svg+xml",
  png: "image/png",
  wasm: "application/wasm",
};

/**
 * Same origin only. libsodium (sealing secrets) runs as WebAssembly, hence 'wasm-unsafe-eval'; the page's one inline
 * <style> is allowed by its hash, so no 'unsafe-inline'.
 */
export const contentSecurityPolicy = (indexHtml: string) => {
  const styles = [...indexHtml.matchAll(/<style>([\s\S]*?)<\/style>/gu)].map(
    ([, css]) => `'sha256-${crypto.createHash("sha256").update(css ?? "").digest("base64")}'`,
  );
  return [
    "default-src 'none'",
    "script-src 'self' 'wasm-unsafe-eval'",
    `style-src ${styles.length === 0 ? "'self'" : styles.join(" ")}`,
    "img-src 'self'",
    "connect-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
};

/** GET `/` and one route per file in `dir`, read once at start; nothing else under `/` is served. */
export const layerRoutes = (dir: string | undefined) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      if (dir === undefined) {
        yield* Effect.logWarning("phone web app not found beside the hub; `/` answers 404 (build it with `pnpm build`)");
        yield* router.add("GET", "/", HttpServerResponse.text("The fleetd phone app is not built into this hub. Run `pnpm build`.", { status: 404 }));
        return;
      }
      const index = fs.readFileSync(`${dir}/index.html`, "utf8");
      const headers = {
        "content-security-policy": contentSecurityPolicy(index),
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        // Small files and a live inbox: always revalidate, so a hub upgrade reaches the phone at once.
        "cache-control": "no-cache",
      };
      for (const name of fs.readdirSync(dir).filter((file) => fs.statSync(`${dir}/${file}`).isFile())) {
        const body = fs.readFileSync(`${dir}/${name}`);
        const response = HttpServerResponse.uint8Array(body, { contentType: TYPES[name.split(".").pop() ?? ""] ?? "application/octet-stream", headers });
        yield* router.add("GET", `/${name}`, Effect.succeed(response));
        if (name === "index.html") yield* router.add("GET", "/", Effect.succeed(response));
      }
    }),
  );
