// The node's CDP proxy (./cdp_proxy.ts) for its agents' browsers. A claude runs on through a node restart and keeps its
// environment, so the port and the tokens do too: the port is kept in `browser/proxy.json`, with the key each token is
// signed with. A session hosted on another machine is reached through the hub's relay, sealed.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Proxy as CdpProxy, type Sessions } from "./cdp_proxy.ts";
import { clientEnd, pipeSealed, relaySaysGone } from "../session_route/relay.ts";

export { type DriverEnd, type Sessions } from "./cdp_proxy.ts";

type Kept = { port: number; key: string };

const keptPath = (home: string) => join(home, "browser", "proxy.json");

function readKept(home: string): Kept | undefined {
  try {
    const kept = JSON.parse(readFileSync(keptPath(home), "utf8")) as Kept;
    return typeof kept.port === "number" && typeof kept.key === "string" && kept.key.length === 64 ? kept : undefined;
  } catch {
    return undefined;
  }
}

export class Proxy extends CdpProxy {
  /**
   * Listens on the port the node's last run did, so the claudes that ran on through its restart still reach it; on a
   * new one only when that port is taken.
   */
  static start(home: string, sessions: Sessions): CdpProxy {
    const kept = readKept(home);
    const key = kept?.key ?? randomBytes(32).toString("hex");
    const relayed: Sessions = {
      ...sessions,
      pipe: (driver, relay, thread) => {
        const hub = new WebSocket(relay.url);
        // A session that ended there by itself (idle, a person, a lost runner): forget its relay here too.
        hub.addEventListener("error", () => void relaySaysGone(relay.url).then((gone) => gone && sessions.gone?.(thread)), { once: true });
        void pipeSealed(driver, clientEnd(hub), relay.key, "agent");
      },
    };
    let proxy: CdpProxy;
    try {
      proxy = CdpProxy.serve(key, relayed, kept?.port ?? 0);
    } catch (e) {
      if (!kept) throw e;
      console.warn(`browser proxy: port ${kept.port} is taken; the agents that ran on through the restart lose their browser`);
      proxy = CdpProxy.serve(key, relayed, 0);
    }
    const path = keptPath(home);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const next = `${path}.next`;
    writeFileSync(next, `${JSON.stringify({ port: proxy.port, key })}\n`, { mode: 0o600 });
    chmodSync(next, 0o600);
    renameSync(next, path);
    return proxy;
  }
}
