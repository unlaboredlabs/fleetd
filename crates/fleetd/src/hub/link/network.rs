//! A machine that lost its IPv4 network. Its node says with each heartbeat whether its own network hardware holds a
//! routable IPv4 address (node/network.rs), and the landing scanner finds whether git there reaches GitHub
//! (hub/work/landings.rs). Both at once, no IPv4 and GitHub not answering, degrade the machine with the fix only the
//! person can run; either one back clears it. Agents keep running there: claude may still reach its API over IPv6.
use fleetd_contracts::node_link::NodeNetwork;

/// Why the machine is degraded for its network, with the fix, or None while it has IPv4 or GitHub answers it. A node
/// that says nothing of its network (an older one, a Mac, a container) is never degraded for it.
pub fn problem(network: Option<&NodeNetwork>, github_down: bool) -> Option<String> {
    let network = network.filter(|n| !n.ipv4 && github_down)?;
    Some(match network.iface.as_ref().map(|i| i.as_str()) {
        Some(iface) => format!(
            "no IPv4 network on {iface}, so GitHub can't be reached. Fix: run `sudo networkctl reconfigure {iface}` \
             or `sudo netplan apply`"
        ),
        None => "no IPv4 network, so GitHub can't be reached. Fix: run `sudo netplan apply`".into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::node::network::verdict;

    fn read(addrs: &[(&str, &str)]) -> Option<NodeNetwork> {
        let addrs: Vec<_> = addrs
            .iter()
            .map(|(n, ip)| ((*n).to_owned(), ip.parse().unwrap()))
            .collect();
        verdict(&addrs, &["enp3s0".to_owned()])
    }

    #[test]
    fn only_link_local_and_github_down_is_degraded_with_the_interfaces_fix() {
        let lost = read(&[("enp3s0", "169.254.77.12"), ("tailscale0", "100.64.0.7")]);
        assert_eq!(
            problem(lost.as_ref(), true).as_deref(),
            Some(
                "no IPv4 network on enp3s0, so GitHub can't be reached. Fix: run `sudo networkctl reconfigure enp3s0` \
                 or `sudo netplan apply`"
            )
        );
        // GitHub still answers (over IPv6, or not asked yet): nothing to fix.
        assert_eq!(problem(lost.as_ref(), false), None);
    }

    #[test]
    fn a_normal_address_or_no_word_from_the_node_is_healthy() {
        let fine = read(&[("enp3s0", "192.168.1.20")]);
        assert_eq!(problem(fine.as_ref(), true), None);
        assert_eq!(problem(None, true), None);
    }
}
