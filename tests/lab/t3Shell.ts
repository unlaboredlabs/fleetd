// Watches a lab T3's shell stream directly, with no hub in between, over the same handshake and framing
// crates/t3-wire speaks: bearer -> one-time ws ticket -> /ws?wsTicket=…&orchestrationProtocol=2, then effect RPC's
// JSON messages (a Request, a Chunk per batch of values, an Ack after each so the server sends the next, and Pings).
type Body = Record<string, any>;

/** Resolves true once `match` holds for a shell item (a `snapshot` or a `thread.updated`), false after `ms`. */
export async function waitShell(t3Url: string, bearer: string, match: (item: Body) => boolean, ms: number): Promise<boolean> {
  const base = new URL(t3Url).origin;
  const res = await fetch(`${base}/api/auth/websocket-ticket`, { method: "POST", headers: { authorization: `Bearer ${bearer}` } });
  if (!res.ok) throw new Error(`T3 websocket ticket: HTTP ${res.status}`);
  const { ticket } = (await res.json()) as { ticket: string };
  const url = new URL("/ws", base);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set("orchestrationProtocol", "2");

  const ws = new WebSocket(url);
  return await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => finish(false), ms);
    // A Ping every 5 s, as effect's client sends, so the server keeps an otherwise quiet subscription open.
    const pinger = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ _tag: "Ping" })), 5_000);
    const stop = () => {
      clearTimeout(timer);
      clearInterval(pinger);
      ws.close();
    };
    const finish = (hit: boolean) => {
      stop();
      resolve(hit);
    };
    ws.onopen = () => ws.send(JSON.stringify({ _tag: "Request", id: 0, tag: "orchestration.subscribeShell", payload: {}, headers: [] }));
    ws.onerror = () => {
      stop();
      reject(new Error(`cannot open T3's /ws at ${base}`));
    };
    ws.onmessage = (event) => {
      const parsed = JSON.parse(String(event.data)) as Body | Array<Body>;
      for (const m of Array.isArray(parsed) ? parsed : [parsed]) {
        if (m._tag === "Chunk") {
          if ((m.values as Array<Body>).some(match)) return finish(true);
          ws.send(JSON.stringify({ _tag: "Ack", requestId: 0 }));
        } else if (m._tag === "Exit" || m._tag === "Defect") {
          stop();
          reject(new Error(`T3 ended the shell stream: ${JSON.stringify(m).slice(0, 300)}`));
        }
      }
    };
  });
}
