// A laptop waking, on real sockets, and how long the app takes to be back: `pnpm wake-repro [stall s]` (bundled and run
// on Node, whose `ws` the app uses), with `--no-event` for a wake no event announces (the network changing under a
// running app), found by the heartbeat alone. There is no Mac here: the sleep, the wake and Tailscale are simulated.
// A stand-in hub sits behind a proxy the script drives. Asleep, the proxy forwards nothing: the live link goes silent
// without a word, as a socket does when the machine sleeps. Woken, the network stays unusable for the stall (Tailscale
// coming back): the proxy accepts each connection and holds it forever, as a SYN or an upgrade lost on a tunnel that
// isn't up yet; then new connections go through. The app's side is HubClient over the real WebSocket transport, woken
// as powerMonitor's `resume` wakes it. Prints each state with its time after the wake, then the totals.
import net from "node:net";
import { WebSocketServer } from "ws";
import type { HubState } from "../src/shared/hub";
import { HubClient } from "../src/main/hub/client";
import { webSocketTransport } from "../src/main/hub/transport";

const args = process.argv.slice(2);
const noEvent = args.includes("--no-event");
const stallMs = Number(args.find((a) => !a.startsWith("--")) ?? "3") * 1000;
const LIMIT_MS = 120_000;

// The hub: the auth on the upgrade request, `ready` and a snapshot right after it, as a current hub answers.
const hub = new WebSocketServer({ host: "127.0.0.1", port: 0 });
hub.on("connection", (socket) => {
  socket.send(JSON.stringify({ t: "ready", protocol: 1 }));
  socket.send(JSON.stringify({ t: "snapshot", cursor: 1, machines: [], projects: [] }));
});
await new Promise((resolve) => hub.once("listening", resolve));
const hubPort = (hub.address() as net.AddressInfo).port;

// The network between them. A link that was up when the computer slept stays dead: its peer forgot it meanwhile.
let mode: "pass" | "blackhole" = "pass";
interface Link {
  readonly client: net.Socket;
  upstream: net.Socket | null;
  dead: boolean;
}
const links = new Set<Link>();
const proxy = net.createServer((client) => {
  const link: Link = { client, upstream: null, dead: false };
  links.add(link);
  client.on("error", () => {});
  client.on("close", () => {
    links.delete(link);
    link.upstream?.destroy();
  });
  if (mode === "blackhole") return;
  const upstream = net.connect(hubPort, "127.0.0.1");
  upstream.on("error", () => client.destroy());
  upstream.on("close", () => client.destroy());
  link.upstream = upstream;
  client.on("data", (bytes) => {
    if (mode === "pass" && !link.dead) upstream.write(bytes);
  });
  upstream.on("data", (bytes) => {
    if (mode === "pass" && !link.dead) client.write(bytes);
  });
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyPort = (proxy.address() as net.AddressInfo).port;

let t0 = performance.now();
const at = () => ((performance.now() - t0) / 1000).toFixed(2).padStart(6);
let live: (() => void) | null = null;
const words = (state: HubState): string => {
  switch (state.phase) {
    case "connecting":
      return `connecting (attempt ${String(state.attempt)})`;
    case "retrying":
      return `retrying in ${((state.retryAt - Date.now()) / 1000).toFixed(2)} s: ${state.reason}${"waking" in state && state.waking !== undefined ? " [quiet]" : ""}`;
    default:
      return state.phase;
  }
};
const client = new HubClient({
  hub: `http://127.0.0.1:${String(proxyPort)}`,
  key: "k",
  transport: webSocketTransport,
  emit: (frame) => {
    if (frame.t !== "state") return;
    if (t0 !== 0) console.log(`${at()} s  ${words(frame.state)}`);
    if (frame.state.phase === "live") live?.();
  },
});
const isLive = () => new Promise<void>((resolve) => (live = resolve));

t0 = 0;
let up = isLive();
client.start();
await up;

// Asleep: the live link's packets go nowhere, and new connections are held.
mode = "blackhole";
for (const link of links) link.dead = true;
await new Promise((resolve) => setTimeout(resolve, 500));

// Awake: what powerMonitor's resume does (main/index.ts), then the network comes back after the stall.
t0 = performance.now();
console.log(`  0.00 s  wake${noEvent ? " (no event)" : ""}; the network is usable from ${(stallMs / 1000).toFixed(2)} s`);
up = isLive();
const wake = client as unknown as { woke?: () => void; reconnectNow: () => void };
if (noEvent) {
  // Nothing tells the app.
} else if (wake.woke === undefined) wake.reconnectNow();
else wake.woke();
setTimeout(() => {
  mode = "pass";
  console.log(`${at()} s  network usable: new connections go through`);
}, stallMs);
const timedOut = await Promise.race([up.then(() => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), LIMIT_MS))]);
const total = performance.now() - t0;
console.log(
  timedOut
    ? `not live after ${String(LIMIT_MS / 1000)} s`
    : `live ${(total / 1000).toFixed(2)} s after the wake, ${((total - stallMs) / 1000).toFixed(2)} s after the network was usable`,
);
client.stop();
for (const link of links) link.client.destroy();
proxy.close();
hub.close();
process.exit(timedOut ? 1 : 0);
