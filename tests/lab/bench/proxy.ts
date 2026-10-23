// A pass-through proxy in front of the user's Claude endpoint that logs the model and effort of every API request,
// so a run can prove that every call (main loops, subagents, compaction, small background helpers that never reach a
// session file) used the pinned model and effort. Bodies and responses pass through unchanged; only the request's
// method, path, model, effort and the response status are written, one JSON line per request.
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";

export interface ProxyRecord {
  readonly at: string;
  readonly method: string;
  readonly path: string;
  readonly model?: string;
  readonly effort?: string;
  readonly status?: number;
}

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
      const body = Buffer.concat(chunks);
      let model: string | undefined;
      let effort: string | undefined;
      if (body.length > 0 && String(req.headers["content-type"] ?? "").includes("json")) {
        try {
          const json = JSON.parse(body.toString("utf8")) as { model?: unknown; output_config?: { effort?: unknown } };
          if (typeof json.model === "string") model = json.model;
          if (typeof json.output_config?.effort === "string") effort = json.output_config.effort;
        } catch {
          // Not JSON after all; logged without a model.
        }
      }
      const headers = { ...req.headers, host: target.host };
      const upstreamReq = client.request(
        { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: `${basePath}${req.url ?? ""}`, headers },
        (upstreamRes) => {
          const record: ProxyRecord = { at: new Date().toISOString(), method: req.method ?? "", path: (req.url ?? "").split("?")[0]!, model, effort, status: upstreamRes.statusCode };
          fs.appendFileSync(logFile, `${JSON.stringify(record)}\n`);
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
