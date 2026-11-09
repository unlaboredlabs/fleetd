// gzip for the JSON the hub answers over HTTP (/link/v1, /mcp), only when the
// request's Accept-Encoding offers it: a client that doesn't ask gets the same bytes as before. Event streams and
// small answers stay as they are.
import type { Route } from "./route.ts";

/** Below this a gzip header and trailer (18 bytes) and the extra work buy nothing. */
export const MIN_BYTES = 1024;
/** The largest answer compressed here, read whole first. Anything bigger goes as it is: uncompressed and whole, never cut. */
export const MAX_BYTES = 64 << 20;

/** Whether an Accept-Encoding header offers gzip (`gzip`, `x-gzip` or `*`, with no `q=0`). */
export function acceptsGzip(headers: Headers): boolean {
  // Headers joins repeated headers with ", ", so each coding is still one of the comma's pieces.
  return (headers.get("accept-encoding") ?? "").split(",").some((coding) => {
    const [name = "", ...params] = coding.split(";");
    const refused = params.some((p) => {
      const t = p.trim();
      const q = t.startsWith("q=") ? t.slice(2).trim() : "";
      return q !== "" && Number(q) === 0;
    });
    const n = name.trim().toLowerCase();
    return !refused && (n === "gzip" || n === "x-gzip" || n === "*");
  });
}

/** `response` gzipped when `request` offered gzip and it is a JSON answer worth it; else unchanged. */
export async function negotiate(request: Headers, response: Response): Promise<Response> {
  const type = response.headers.get("content-type") ?? "";
  if (!type.startsWith("application/json") || response.headers.has("content-encoding")) return response;
  // Varies either way, so a cache between never hands a gzipped answer to a client that didn't ask.
  const headers = new Headers(response.headers);
  headers.append("vary", "accept-encoding");
  const init = { status: response.status, statusText: response.statusText, headers };
  const body = response.body;
  if (!acceptsGzip(request) || !body) return new Response(body, init);
  // Bun doesn't say whether a body is in memory, so it is read here up to the cap: one past it goes out as it is,
  // what was read first and then the rest.
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
    if (size > MAX_BYTES) {
      const whole = new ReadableStream<Uint8Array>({
        start(c) {
          for (const chunk of chunks) c.enqueue(chunk);
        },
        async pull(c) {
          const next = await reader.read();
          if (next.done) c.close();
          else c.enqueue(next.value);
        },
        cancel: (reason) => reader.cancel(reason),
      });
      return new Response(whole, init);
    }
  }
  const bytes = Buffer.concat(chunks);
  if (size < MIN_BYTES) return new Response(bytes, init);
  headers.delete("content-length");
  headers.set("content-encoding", "gzip");
  return new Response(Bun.gzipSync(bytes, { level: 1 }), init);
}

/** `route`'s answers through `negotiate`; an upgrade (no answer) is left alone. */
export const gzipped =
  (route: Route): Route =>
  async (req, ctx) => {
    const answer = await route(req, ctx);
    return answer === undefined ? undefined : negotiate(req.headers, answer);
  };
