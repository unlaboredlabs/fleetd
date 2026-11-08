// The heartbeat's IPv4 check (Rust's node/network.rs): only the machine's own network hardware counts, so a
// link-local address left after DHCP timed out reads as no network even while Tailscale's and docker's stay up.
import { expect, test } from "bun:test";
import { read, verdict } from "../../src/node/load/network.ts";

test("only a link-local address on the hardware is no IPv4, and names its interface", () => {
  const addrs: [string, string][] = [
    ["lo", "127.0.0.1"],
    ["enp3s0", "169.254.77.12"],
    ["tailscale0", "100.64.0.7"],
    ["docker0", "172.17.0.1"],
  ];
  expect(verdict(addrs, ["enp3s0"])).toEqual({ ipv4: false, iface: "enp3s0" });
});

test("a routable address on the hardware is IPv4", () => {
  expect(verdict([["lo", "127.0.0.1"], ["enp3s0", "192.168.1.20"], ["tailscale0", "100.64.0.7"]], ["enp3s0", "wlp2s0"])).toEqual({ ipv4: true });
});

test("no address names the first hardware interface; a container's interfaces say nothing", () => {
  expect(verdict([["lo", "127.0.0.1"]], ["wlp2s0", "enp3s0"])).toEqual({ ipv4: false, iface: "enp3s0" });
  expect(verdict([["eth0", "172.18.0.4"]], [])).toBeUndefined();
});

test("this machine's interfaces read as a verdict on Linux, and nothing elsewhere", () => {
  const got = read();
  if (process.platform !== "linux") expect(got).toBeUndefined();
  else if (got) expect(typeof got.ipv4).toBe("boolean");
});
