// `fleetd push-relay`: `set <url|off>` points the hub's phone notifications at
// a relay (push_relay_set), the relay's key sealed here to the hub's box key; with no argument it runs a relay.
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { seal } from "../shared/sealed_box.ts";
import { ArgError, parse, type Parsed } from "../cli/args.ts";
import { eprintln, ioMessage, println } from "../cli/common.ts";
import { Exit, Hub } from "../cli/time.ts";
import { PUSH_RELAY_USAGE } from "../cli/usages.ts";
export { PUSH_RELAY_USAGE, DEFAULT_LISTEN };

import { DEFAULT_LISTEN, Relay, serve } from "./index.ts";

/** `<ip>:<port>`, as Rust's SocketAddr parses it: an IPv4 address, or an IPv6 one in brackets. */
export function parseSocketAddr(text: string): [string, number] | undefined {
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|(\d{1,3}(?:\.\d{1,3}){3})):(\d{1,5})$/.exec(text);
  if (!m) return undefined;
  const host = m[1] ?? m[2]!;
  const port = Number(m[3]);
  if (port > 65535 || isIP(host) === 0) return undefined;
  return [host, port];
}

async function serveCommand(listen: string): Promise<number> {
  const addr = parseSocketAddr(listen);
  if (!addr) {
    eprintln(`fleetd push-relay: --listen must be <ip>:<port>, got '${listen}'`);
    return 2;
  }
  try {
    await serve(addr[0], addr[1], Relay.fromEnv());
    return 0;
  } catch (error) {
    eprintln(`fleetd push-relay: ${(error as Error).message}`);
    return 1;
  }
}

export async function pushRelayCommand(argv: string[]): Promise<number> {
  const v = parse(argv, {
    options: { listen: "str", "relay-key-file": "str", hub: "str", "key-file": "str" },
    positionals: true,
  });
  if (v instanceof ArgError) {
    process.stderr.write(`fleetd: ${v.message}\n\nusage:\n${PUSH_RELAY_USAGE}`);
    return 2;
  }
  const p = v.positionals;
  if (p.length === 0) return serveCommand(v.str("listen") ?? DEFAULT_LISTEN);
  if (p.length === 2 && p[0] === "set") return set(v, p[1]!);
  process.stderr.write(`fleetd: push-relay takes \`set <url|off>\` or nothing\n\nusage:\n${PUSH_RELAY_USAGE}`);
  return 2;
}

async function set(v: Parsed, raw: string): Promise<number> {
  const [hubUrl, keyFile] = [v.str("hub"), v.str("key-file")];
  if ((hubUrl === undefined) !== (keyFile === undefined)) {
    eprintln("fleetd push-relay: --hub and --key-file go together");
    return 2;
  }
  try {
    const hub = await Hub.connect(hubUrl === undefined ? undefined : [hubUrl, keyFile!], undefined, "push-relay");
    const input: Record<string, unknown> = { url: raw === "off" ? "" : raw };
    const path = v.str("relay-key-file");
    if (path !== undefined) {
      let key: string;
      try {
        key = readFileSync(path, "utf8");
      } catch (error) {
        eprintln(`fleetd push-relay: can't read ${path}: ${ioMessage(error)}`);
        return 1;
      }
      // Sealed here to the hub's box key: the key never crosses the connection in the clear.
      const got = await hub.call("hub_links_get", {});
      const pub = Buffer.from(typeof got?.boxPubKey === "string" ? got.boxPubKey : "", "base64");
      if (pub.length !== 32) {
        eprintln("fleetd push-relay: the hub sent no key to seal the relay's key to");
        return 1;
      }
      input.key = Buffer.from(seal(new Uint8Array(pub), new TextEncoder().encode(key.trim()))).toString("base64");
    }
    const out = await hub.call("push_relay_set", input);
    const url = typeof out?.url === "string" ? out.url : undefined;
    if (url === undefined) println("phone notifications are off");
    else if (out.default === true) println(`phone notifications go through ${url}, the default relay`);
    else if (out.key === true) println(`phone notifications go through ${url}, with its key`);
    else println(`phone notifications go through ${url}`);
    return 0;
  } catch (error) {
    if (error instanceof Exit) return error.code;
    throw error;
  }
}
