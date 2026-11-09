// What each of the hub's connections read so far (crates/fleetd/src/hub/http/counted.rs): the node link times its
// silence by bytes arriving, not whole frames, so one large frame coming in slowly (a 25 MiB put_file over 1 Mbit/s)
// never looks like a dead link.
//
// Rust counts in its own listener. Bun.serve surfaces neither a connection's bytes nor a websocket's partial message,
// so the kernel's count stands in: on Linux, `ss` reads each TCP connection's `bytes_received` (its tcp_info), one run
// for every connection on the hub's port. Where there is no `ss` (macOS, a container without iproute2) there is no
// count, and silence is timed by frames alone, as before.

/** A connection to the hub: who dialed (`address`, `port`) and the hub's port it came in on (`local`). */
export type Peer = { address: string; port: number; local: number };

/** One `ss` run's output, or undefined when it couldn't run. */
export type RunSs = (args: string[]) => Promise<string | undefined>;

/** `::ffff:10.0.0.1` and `[::1]`, as `ss` and Bun write them, alike: `10.0.0.1` and `::1`. */
function bare(address: string): string {
  const unbracketed = address.startsWith("[") && address.endsWith("]") ? address.slice(1, -1) : address;
  const unscoped = unbracketed.replace(/%[^%]*$/, "");
  return /^::ffff:\d+\.\d+\.\d+\.\d+$/i.test(unscoped) ? unscoped.slice(7) : unscoped.toLowerCase();
}

/** `host:port` (IPv6 in brackets) split, or undefined. */
function endpoint(text: string): { address: string; port: number } | undefined {
  const colon = text.lastIndexOf(":");
  const port = Number(text.slice(colon + 1));
  if (colon < 1 || !Number.isInteger(port)) return undefined;
  return { address: bare(text.slice(0, colon)), port };
}

const keyOf = (address: string, port: number) => `${bare(address)} ${port}`;

/**
 * `ss -tinHO`'s lines as bytes received per peer: `Recv-Q Send-Q local peer` then tcp_info, one connection a line.
 * A connection that read nothing yet has no `bytes_received`: 0.
 */
export function parseSs(output: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of output.split("\n")) {
    const [, , , peerText, ...info] = line.trim().split(/\s+/);
    const peer = peerText ? endpoint(peerText) : undefined;
    if (!peer) continue;
    const received = info.find((field) => field.startsWith("bytes_received:"));
    out.set(keyOf(peer.address, peer.port), received ? Number(received.slice("bytes_received:".length)) || 0 : 0);
  }
  return out;
}

/** An `ss` that answers in time; undefined where it isn't there or fails. */
const runSs: RunSs = async (args) => {
  if (process.platform !== "linux") return undefined;
  try {
    const child = Bun.spawn(["ss", ...args], { stdout: "pipe", stderr: "ignore", stdin: "ignore", timeout: 2000 });
    const [text, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    return code === 0 ? text : undefined;
  } catch {
    return undefined;
  }
};

/** Reads what connections to the hub's port read so far, by the kernel's count. */
export class ReadCounts {
  /** False once `ss` couldn't run: it isn't tried again. */
  private usable = true;

  constructor(private readonly run: RunSs = runSs) {}

  /**
   * Each of `peers`' bytes read so far, by `keyOf`-style key (`read`); undefined where there is no count to read. One
   * `ss` run per hub port.
   */
  async sample(peers: Peer[]): Promise<Map<string, number> | undefined> {
    if (!this.usable || peers.length === 0) return undefined;
    const counts = new Map<string, number>();
    for (const local of new Set(peers.map((p) => p.local))) {
      const output = await this.run(["-tinHO", "state", "established", "sport", "=", `:${local}`]);
      if (output === undefined) {
        this.usable = false;
        console.warn("hub http: ss can't read connections' byte counts here, so node links time silence by frames");
        return undefined;
      }
      for (const [key, bytes] of parseSs(output)) counts.set(`${local} ${key}`, bytes);
    }
    return counts;
  }

  /** `peer`'s count in a `sample`. */
  static read(counts: Map<string, number>, peer: Peer): number | undefined {
    return counts.get(`${peer.local} ${keyOf(peer.address, peer.port)}`);
  }
}
