// Whether a machine can run VMs (sandbox/host/capable.ts), with every probe stood in: each answer is yes, or a plain
// reason with the fix where a person has one, and nothing makes the check throw.
import { expect, test } from "bun:test";
import { RETRY_FETCH_MS, type Probes, upstream, vmCheck } from "../../src/sandbox/host/capable.ts";

const STUB = "# This is /run/systemd/resolve/stub-resolv.conf\nnameserver 127.0.0.53\noptions edns0 trust-ad\nsearch .\n";
const UPSTREAM = "# This is /run/systemd/resolve/resolv.conf\nnameserver 192.168.1.1\nnameserver fe80::1%enp3s0\nnameserver 2606:4700:4700::1111\n";

const NET = { ip: "/usr/sbin/ip", nsenter: "/usr/bin/nsenter" };

const probes = (over: Partial<Probes> = {}): Probes => ({
  platform: "linux",
  arch: "x64",
  kvm: () => ({ ok: "direct" }),
  userns: () => undefined,
  net: () => NET,
  addrs: () => ["192.168.1.20", "fd7a:115c:a1e0::1"],
  read: (path) => ({ "/etc/resolv.conf": STUB, "/run/systemd/resolve/resolv.conf": UPSTREAM })[path],
  tools: () => "ready",
  now: () => 1_000_000,
  ...over,
});

test("a Linux machine with KVM, namespaces, DNS behind systemd-resolved's stub and its files can run VMs", () => {
  expect(vmCheck(probes())).toEqual({ ok: true, kvm: "direct", dns: ["192.168.1.1", "2606:4700:4700::1111"], tools: "ready", net: NET });
  expect(vmCheck(probes({ kvm: () => ({ ok: "sg" }), tools: () => "fetch" }))).toEqual({
    ok: true,
    kvm: "sg",
    dns: ["192.168.1.1", "2606:4700:4700::1111"],
    tools: "fetch",
    net: NET,
  });
});

test("a resolver in /etc/resolv.conf that isn't a stub is used as it is", () => {
  const read = (path: string) => (path === "/etc/resolv.conf" ? "nameserver 10.0.0.2\nnameserver 127.0.0.1\n" : undefined);
  expect(vmCheck(probes({ read }))).toMatchObject({ ok: true, dns: ["10.0.0.2"] });
});

test("upstream servers skip loopback, link-local and repeats, IPv4 first", () => {
  expect(upstream("nameserver ::1\nnameserver 2001:db8::53\nnameserver 169.254.169.254\nnameserver 9.9.9.9\nnameserver 9.9.9.9\n")).toEqual([
    "9.9.9.9",
    "2001:db8::53",
  ]);
  expect(upstream(STUB)).toEqual([]);
});

test("macOS and arm64 keep plain processes, and say so", () => {
  expect(vmCheck(probes({ platform: "darwin" }))).toEqual({
    ok: false,
    why: "VMs need Linux with KVM; this machine runs macOS, so its agents run as plain processes.",
    expected: true,
  });
  expect(vmCheck(probes({ arch: "arm64" }))).toEqual({
    ok: false,
    why: "VMs run on x86_64 machines for now; this one is arm64, so its agents run as plain processes.",
    expected: true,
  });
});

test("no KVM for this user gives the kvm group's fix", () => {
  const check = vmCheck(probes({ kvm: () => ({ err: { why: "ada can't open /dev/kvm read-write", fix: "sudo usermod -aG kvm ada" } }) }));
  expect(check).toEqual({ ok: false, why: "ada can't open /dev/kvm read-write", fix: "sudo usermod -aG kvm ada" });
});

test("user namespaces held back by AppArmor or turned off say which, with the sysctl that fixes it", () => {
  const userns = () => "unshare: write failed /proc/self/uid_map: Operation not permitted";
  const apparmor = vmCheck(probes({ userns, read: (p) => (p === "/proc/sys/kernel/apparmor_restrict_unprivileged_userns" ? "1\n" : undefined) }));
  expect(apparmor).toMatchObject({ ok: false, fix: "echo kernel.apparmor_restrict_unprivileged_userns=0 | sudo tee /etc/sysctl.d/60-fleetd-userns.conf && sudo sysctl --system" });
  const off = vmCheck(probes({ userns, read: (p) => (p === "/proc/sys/user/max_user_namespaces" ? "0\n" : undefined) }));
  expect(off).toMatchObject({ ok: false, fix: "echo user.max_user_namespaces=15000 | sudo tee /etc/sysctl.d/60-fleetd-userns.conf && sudo sysctl --system" });
  expect(vmCheck(probes({ userns, read: () => undefined }))).toEqual({
    ok: false,
    why: "This user can't make the user namespace virtiofsd shares files from: unshare: write failed /proc/self/uid_map: Operation not permitted",
  });
});

test("only a local stub and nothing behind it: no DNS for VMs", () => {
  const check = vmCheck(probes({ read: (p) => (p === "/etc/resolv.conf" ? STUB : undefined) }));
  expect(check).toMatchObject({ ok: false });
  expect((check as { why: string }).why).toStartWith("No DNS server for VMs:");
});

test("a fetch that failed holds the machine back for an hour, then it may try again", () => {
  const failed = { failed: "github.com answered 503 for root vm-aaaa", at: Date.UTC(2026, 10, 17, 9, 30) };
  expect(vmCheck(probes({ tools: () => failed, now: () => failed.at + 60_000 }))).toEqual({
    ok: false,
    why: "Fetching the VM files failed: github.com answered 503 for root vm-aaaa. The node tries again after 10:30 UTC.",
  });
  expect(vmCheck(probes({ tools: () => failed, now: () => failed.at + RETRY_FETCH_MS }))).toMatchObject({ ok: true, tools: "fetch" });
});

test("a probe that throws is an answer of no, never a throw", () => {
  const check = vmCheck(probes({ userns: () => { throw new Error("spawn failed"); } }));
  expect(check).toEqual({ ok: false, why: "checking for VMs failed: spawn failed" });
});

test("a VM's network needs ip, nsenter and /dev/net/tun, and says which is missing", () => {
  expect(vmCheck(probes({ net: () => ({ missing: "the `ip` command, which iproute2 installs" }) }))).toEqual({
    ok: false,
    why: "A VM's network needs the `ip` command, which iproute2 installs, and this machine doesn't have it: the node keeps each VM off this machine's own addresses with it.",
  });
  const tun = vmCheck(probes({ net: () => ({ missing: "/dev/net/tun, which the tun module makes", fix: "echo tun | sudo tee /etc/modules-load.d/fleetd-tun.conf && sudo modprobe tun" }) }));
  expect(tun).toMatchObject({ ok: false, fix: "echo tun | sudo tee /etc/modules-load.d/fleetd-tun.conf && sudo modprobe tun" });
});

test("a DNS server on this machine itself is no DNS server for a VM, which can't reach it", () => {
  const read = (path: string) => (path === "/etc/resolv.conf" ? "nameserver 192.168.1.20\nnameserver 9.9.9.9\n" : undefined);
  expect(vmCheck(probes({ read }))).toMatchObject({ ok: true, dns: ["9.9.9.9"] });
  const onlyOwn = (path: string) => (path === "/etc/resolv.conf" ? "nameserver 192.168.1.20\n" : undefined);
  expect(vmCheck(probes({ read: onlyOwn }))).toMatchObject({ ok: false, why: expect.stringContaining("the only one this machine names is on this machine itself") });
});
