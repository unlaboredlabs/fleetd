/** Ports this process gave: never given twice, since what takes one listens only later. */
const given = new Set<number>();

/** A port free on every address, held by this process until `release`: for another process (a box's bootstrap) to
 * listen on once it starts, which takes seconds on a loaded machine. Never one the kernel hands out by itself (Linux's
 * from 32768, macOS's from 49152): a port 0 picks comes from that range, where every test run on the machine takes its
 * own port 0 and its connections' ends, and under load one of those took it before the process did. */
export function heldPort(): { port: number; release: () => void } {
  for (;;) {
    const port = 20_000 + Math.floor(Math.random() * 12_000);
    if (given.has(port)) continue;
    let held: { stop(closeActive?: boolean): void };
    try {
      held = Bun.listen({ hostname: "0.0.0.0", port, socket: { data() {} } });
    } catch {
      continue;
    }
    given.add(port);
    return { port, release: () => held.stop(true) };
  }
}

/** A port for another process to listen on a moment later (a hub, a box's bootstrap): `heldPort`'s, let go at once. */
export function listenPort(): number {
  const { port, release } = heldPort();
  release();
  return port;
}
