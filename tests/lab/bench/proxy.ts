// A pass-through proxy in front of the user's Claude endpoint that logs every API request, so a run can prove that
// every call (main loops, subagents, compaction, small background helpers that never reach a session file) used the
// pinned model and effort, and so its usage is counted from what the API itself answered. Bodies and responses pass
// through unchanged; one JSON line per request records the request's method, path, model, effort, tool schema size
// and times, and the response's status, message id and usage object.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import zlib from "node:zlib";

export interface ProxyRecord {
  /** When the response headers arrived. */
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly model?: string;
  readonly effort?: string;
  readonly status?: number;
  /** When the request body was in, and when the response ended (or was cut off). */
  readonly sentAt?: string;
  readonly endAt?: string;
  /** Bytes of the request's `tools` array as JSON, and how many tools it had. */
  readonly toolsBytes?: number;
  readonly tools?: number;
  readonly messageId?: string;
  /** The response's usage object as the API sent it: message_start's, with message_delta's fields over it. */
  readonly usage?: Record<string, unknown>;
}

/**
 * The message id and usage in a Messages API response body: a JSON message, or an SSE stream whose message_start
 * carries the input side and whose message_delta events carry the final output count (and, on newer APIs, the input
 * side again). Null when the body has neither.
 */
export const usageFromResponse = (body: string): { messageId?: string; usage: Record<string, unknown> } | null => {
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const json = JSON.parse(trimmed) as { id?: unknown; usage?: Record<string, unknown> };
      if (json.usage === undefined) return null;
      return { ...(typeof json.id === "string" ? { messageId: json.id } : {}), usage: json.usage };
    } catch {
      return null;
    }
  }
  let messageId: string | undefined;
  let usage: Record<string, unknown> | undefined;
  for (const line of body.split("\n")) {
    if (!line.startsWith("data:") || !/"message_(start|delta)"/u.test(line)) continue;
    let event: { type?: string; message?: { id?: unknown; usage?: Record<string, unknown> }; usage?: Record<string, unknown> };
    try {
      event = JSON.parse(line.slice(5)) as typeof event;
    } catch {
      continue;
    }
    if (event.type === "message_start" && event.message !== undefined) {
      if (typeof event.message.id === "string") messageId = event.message.id;
      usage = { ...event.message.usage };
    } else if (event.type === "message_delta" && event.usage !== undefined) {
      usage = { ...usage, ...Object.fromEntries(Object.entries(event.usage).filter(([, v]) => v !== null && v !== undefined)) };
    }
  }
  return usage === undefined ? null : { ...(messageId === undefined ? {} : { messageId }), usage };
};

const decode = (raw: Buffer, encoding: string | undefined) => {
  switch ((encoding ?? "").trim()) {
    case "gzip":
      return zlib.gunzipSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    case "br":
      return zlib.brotliDecompressSync(raw, { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH });
    case "deflate":
      return zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    default:
      return raw;
  }
};

export const startProxy = async (upstream: string, logFile: string) => {
  const target = new URL(upstream);
  const client = target.protocol === "https:" ? https : http;
  const basePath = target.pathname.replace(/\/$/u, "");
  /** In-flight upstream requests: a contender stopped mid-stream leaves one open, which would keep this process up. */
  const inFlight = new Set<http.ClientRequest>();
  const server = http.createServer((req, res) => {
    const chunks: Array<Buffer> = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const sentAt = new Date().toISOString();
      const body = Buffer.concat(chunks);
      let model: string | undefined;
      let effort: string | undefined;
      let toolsBytes: number | undefined;
      let tools: number | undefined;
      if (body.length > 0 && String(req.headers["content-type"] ?? "").includes("json")) {
        try {
          const json = JSON.parse(body.toString("utf8")) as { model?: unknown; output_config?: { effort?: unknown }; tools?: unknown };
          if (typeof json.model === "string") model = json.model;
          if (typeof json.output_config?.effort === "string") effort = json.output_config.effort;
          if (Array.isArray(json.tools)) {
            tools = json.tools.length;
            toolsBytes = Buffer.byteLength(JSON.stringify(json.tools));
          }
        } catch {
          // Not JSON after all; logged without a model.
        }
      }
      const headers = { ...req.headers, host: target.host };
      const upstreamReq = client.request(
        { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: `${basePath}${req.url ?? ""}`, headers },
        (upstreamRes) => {
          const head = { at: new Date().toISOString(), method: req.method ?? "", path: (req.url ?? "").split("?")[0]!, model, effort, status: upstreamRes.statusCode, sentAt, toolsBytes, tools };
          const generation = head.method === "POST" && /\/messages$/u.test(head.path);
          const response: Array<Buffer> = [];
          if (generation) upstreamRes.on("data", (c: Buffer) => response.push(c));
          let logged = false;
          // Once, at the response's end or when it is cut off: a record per request, with whatever usage arrived.
          const record = () => {
            if (logged) return;
            logged = true;
            let parsed: ReturnType<typeof usageFromResponse> = null;
            if (generation) {
              try {
                parsed = usageFromResponse(decode(Buffer.concat(response), upstreamRes.headers["content-encoding"]).toString("utf8"));
              } catch {
                // A cut-off or undecodable body: the request is still logged, without usage.
              }
            }
            const full: ProxyRecord = { ...head, endAt: new Date().toISOString(), ...(parsed ?? {}) };
            fs.appendFileSync(logFile, `${JSON.stringify(full)}\n`);
          };
          upstreamRes.on("end", record);
          upstreamRes.on("close", record);
          res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
          upstreamRes.pipe(res);
        },
      );
      inFlight.add(upstreamReq);
      upstreamReq.on("close", () => inFlight.delete(upstreamReq));
      res.on("close", () => {
        if (!res.writableFinished) upstreamReq.destroy();
      });
      upstreamReq.on("error", (error) => {
        fs.appendFileSync(logFile, `${JSON.stringify({ at: new Date().toISOString(), method: req.method, path: req.url, model, effort, error: error.message })}\n`);
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      upstreamReq.end(body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        for (const r of inFlight) r.destroy();
        server.close(() => resolve());
      }),
  };
};

export const readProxyLog = (file: string): Array<ProxyRecord> =>
  fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => l.startsWith("{"))
        .map((l) => JSON.parse(l) as ProxyRecord)
    : [];
