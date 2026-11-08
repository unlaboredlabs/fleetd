//! Whether the machine has an IPv4 network, sent with each heartbeat's load (`NodeLoad::network`). Only the machine's
//! own network hardware counts (an interface with a device behind it in `/sys/class/net`), so Tailscale's address,
//! docker's bridge and loopback, which stay up when DHCP fails, never make it look fine. A plain address check: a
//! routable IPv4 on one of them, or none (only 169.254.x link-local, what systemd-networkd falls back to when DHCP times
//! out under memory pressure). The hub degrades the machine only when GitHub can't be reached from it too.
//! Linux only: the fix it names is systemd-networkd's and netplan's.
use std::net::Ipv4Addr;

use fleetd_contracts::node_link::NodeNetwork;
use fleetd_contracts::prim::Text;

/// What the interfaces say: `addrs` each IPv4 address with its interface's name, `hardware` the names of the
/// interfaces of the machine's own hardware. None with no hardware interface (a container): nothing to tell.
pub fn verdict(addrs: &[(String, Ipv4Addr)], hardware: &[String]) -> Option<NodeNetwork> {
    let mut hardware: Vec<&String> = hardware.iter().collect();
    if hardware.is_empty() {
        return None;
    }
    hardware.sort();
    let on_hardware = |name: &String| hardware.contains(&name);
    let ipv4 = addrs.iter().any(|(name, ip)| {
        on_hardware(name) && !ip.is_link_local() && !ip.is_loopback() && !ip.is_unspecified()
    });
    let iface = (!ipv4)
        .then(|| {
            addrs
                .iter()
                .find(|(name, ip)| on_hardware(name) && ip.is_link_local())
                .map(|(name, _)| name)
                .or(hardware.first().copied())
        })
        .flatten()
        .and_then(|name| Text::new(name).ok());
    Some(NodeNetwork { ipv4, iface })
}

/// Reads the interfaces now. Blocking (a few small files in `/sys`): run it off the async threads.
#[cfg(target_os = "linux")]
pub fn read() -> Option<NodeNetwork> {
    let addrs: Vec<(String, Ipv4Addr)> = nix::ifaddrs::getifaddrs()
        .ok()?
        .filter_map(|a| {
            let ip = a.address?.as_sockaddr_in()?.ip();
            Some((a.interface_name, ip))
        })
        .collect();
    let hardware: Vec<String> = std::fs::read_dir("/sys/class/net")
        .ok()?
        .filter_map(|e| {
            let e = e.ok()?;
            e.path()
                .join("device")
                .exists()
                .then(|| e.file_name().to_string_lossy().into_owned())
        })
        .collect();
    verdict(&addrs, &hardware)
}

#[cfg(not(target_os = "linux"))]
pub fn read() -> Option<NodeNetwork> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    fn addrs(list: &[(&str, &str)]) -> Vec<(String, Ipv4Addr)> {
        list.iter()
            .map(|(name, ip)| ((*name).to_owned(), ip.parse().unwrap()))
            .collect()
    }

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|n| (*n).to_owned()).collect()
    }

    /// The Nov 8 outage: DHCP timed out and enp3s0 kept only a link-local address, while Tailscale's and docker's
    /// stayed up.
    #[test]
    fn only_a_link_local_address_on_the_hardware_is_no_ipv4_and_names_its_interface() {
        let got = verdict(
            &addrs(&[
                ("lo", "127.0.0.1"),
                ("enp3s0", "169.254.77.12"),
                ("tailscale0", "100.64.0.7"),
                ("docker0", "172.17.0.1"),
            ]),
            &names(&["enp3s0"]),
        )
        .unwrap();
        assert!(!got.ipv4);
        assert_eq!(got.iface.as_ref().map(|i| i.as_str()), Some("enp3s0"));
    }

    #[test]
    fn a_routable_address_on_the_hardware_is_ipv4() {
        let got = verdict(
            &addrs(&[
                ("lo", "127.0.0.1"),
                ("enp3s0", "192.168.1.20"),
                ("tailscale0", "100.64.0.7"),
            ]),
            &names(&["enp3s0", "wlp2s0"]),
        )
        .unwrap();
        assert_eq!(
            got,
            NodeNetwork {
                ipv4: true,
                iface: None
            }
        );
    }

    /// No address at all: the first hardware interface is the one to bring back.
    #[test]
    fn no_address_names_the_first_hardware_interface() {
        let got = verdict(
            &addrs(&[("lo", "127.0.0.1")]),
            &names(&["wlp2s0", "enp3s0"]),
        )
        .unwrap();
        assert!(!got.ipv4);
        assert_eq!(got.iface.as_ref().map(|i| i.as_str()), Some("enp3s0"));
    }

    /// A container's interfaces are all virtual: it says nothing rather than a false alarm.
    #[test]
    fn no_hardware_interface_says_nothing() {
        assert_eq!(verdict(&addrs(&[("eth0", "172.18.0.4")]), &[]), None);
    }
}
