//! The one guard on a Navi's shell commands (W239): they never ask (D208), whatever its approval mode, but a command
//! that would wipe the machine or the person's home is refused, with why. It is a short list of the obvious ones
//! (removing `/` or the home directory recursively, making a filesystem, writing raw onto a disk, a fork bomb), not a
//! sandbox: the OS sandbox stays the guard of what a command may touch.

/// Why fleetd refuses `command`, or None: it runs.
pub fn refused(command: &str, home: Option<&str>) -> Option<&'static str> {
    if command.replace(' ', "").contains(":(){:|:&};:") {
        return Some(FORK_BOMB);
    }
    for simple in command.split(['\n', ';', '|', '&']) {
        let words: Vec<String> = simple
            .split_whitespace()
            .map(|w| w.trim_matches(['"', '\'']).to_owned())
            .collect();
        let mut words = words.as_slice();
        // `sudo`, `env`, `nohup`, `exec` and variable assignments in front run the command after them.
        while let Some((first, rest)) = words.split_first() {
            let lead = ["sudo", "env", "nohup", "exec", "command", "doas", "time"]
                .contains(&first.as_str())
                || (first.contains('=') && !first.starts_with('-'))
                || (first.starts_with('-') && words.len() > 1);
            if !lead {
                break;
            }
            words = rest;
        }
        let Some((program, args)) = words.split_first() else {
            continue;
        };
        let program = program.rsplit('/').next().unwrap_or(program);
        if let Some(why) = wipes(program, args, home) {
            return Some(why);
        }
        // A redirect straight onto a disk: `> /dev/sda`.
        if simple.contains('>') {
            let target = simple.rsplit('>').next().unwrap_or_default().trim();
            if disk(target.split_whitespace().next().unwrap_or_default()) {
                return Some(DISK);
            }
        }
    }
    None
}

const ROOT: &str = "Refused by fleetd: this would delete everything on the machine or in your home folder. A Navi's \
                    commands never ask, but this one never runs. Say what you meant to remove, by its own path.";
const FILESYSTEM: &str = "Refused by fleetd: making a filesystem or erasing a disk wipes what's on it. A Navi never \
                          does that; the person does it themselves.";
const DISK: &str = "Refused by fleetd: writing straight onto a disk device destroys what's on it. A Navi never does \
                    that; the person does it themselves.";
const FORK_BOMB: &str =
    "Refused by fleetd: this command starts processes without end and would freeze the machine.";

fn wipes(program: &str, args: &[String], home: Option<&str>) -> Option<&'static str> {
    match program {
        "rm" => {
            let recursive = args.iter().any(|a| {
                a == "--recursive"
                    || (a.starts_with('-')
                        && !a.starts_with("--")
                        && (a.contains('r') || a.contains('R')))
            });
            let everything = args
                .iter()
                .filter(|a| !a.starts_with('-'))
                .any(|a| everything(a, home));
            (recursive && everything || args.iter().any(|a| a == "--no-preserve-root"))
                .then_some(ROOT)
        }
        "chmod" | "chown" | "chgrp" => {
            let recursive = args.iter().any(|a| a == "-R" || a == "--recursive");
            (recursive && args.iter().any(|a| a == "/")).then_some(ROOT)
        }
        "wipefs" | "mkswap" => Some(FILESYSTEM),
        p if p == "mkfs" || p.starts_with("mkfs.") || p == "newfs" || p.starts_with("newfs_") => {
            Some(FILESYSTEM)
        }
        "diskutil" => args
            .iter()
            .any(|a| {
                let a = a.to_ascii_lowercase();
                a.starts_with("erase")
                    || a.starts_with("partition")
                    || a == "zerodisk"
                    || a == "randomdisk"
            })
            .then_some(FILESYSTEM),
        "dd" => args
            .iter()
            .filter_map(|a| a.strip_prefix("of="))
            .any(disk)
            .then_some(DISK),
        "shred" => args.iter().any(|a| disk(a)).then_some(DISK),
        _ => None,
    }
}

/// `/`, the home directory, or everything in one: what a recursive `rm` must never get.
fn everything(path: &str, home: Option<&str>) -> bool {
    let path = path.trim_end_matches("/*").trim_end_matches('*');
    let path = if path.len() > 1 {
        path.trim_end_matches('/')
    } else {
        path
    };
    let homes = ["~", "$HOME", "${HOME}", "/home", "/Users", "/root"];
    path.is_empty()
        || path == "/"
        || homes.contains(&path)
        || home.is_some_and(|h| path == h.trim_end_matches('/'))
}

/// A disk device: `/dev/sda`, `/dev/nvme0n1`, `/dev/disk2`, `/dev/mmcblk0`; not `/dev/null` and the like.
fn disk(path: &str) -> bool {
    let Some(dev) = path.strip_prefix("/dev/") else {
        return false;
    };
    let dev = dev
        .strip_prefix('r')
        .filter(|d| d.starts_with("disk"))
        .unwrap_or(dev);
    [
        "sd", "hd", "vd", "xvd", "nvme", "disk", "mmcblk", "md", "dm-", "mapper/",
    ]
    .iter()
    .any(|p| dev.starts_with(p))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_obvious_wipes_are_refused_and_everything_else_runs() {
        let home = Some("/home/ada");
        for wipe in [
            "rm -rf /",
            "rm -rf /*",
            "sudo rm -rf / ",
            "rm -fr ~",
            "rm -rf ~/",
            "rm -rf ~/*",
            "rm -r -f $HOME",
            "rm -rf \"$HOME\"",
            "rm -rf ${HOME}/",
            "rm -rf /home/ada",
            "cd /tmp && rm -Rf /",
            "rm --recursive --force /",
            "rm --no-preserve-root -rf /",
            "/bin/rm -rf /",
            "mkfs.ext4 /dev/sdb1",
            "mkfs -t ext4 /dev/sdb",
            "wipefs -a /dev/sda",
            "dd if=/dev/zero of=/dev/sda bs=1M",
            "dd if=img.iso of=/dev/rdisk2",
            "cat /dev/urandom > /dev/nvme0n1",
            "shred -n 1 /dev/sda",
            "diskutil eraseDisk APFS X disk2",
            "chmod -R 000 /",
            ":(){ :|:& };:",
        ] {
            assert!(refused(wipe, home).is_some(), "{wipe}");
        }
        for runs in [
            "rm -rf node_modules",
            "rm -rf ./build /tmp/x",
            "rm -rf ~/navi/ada/drafts",
            "rm -rf /home/ada/navi/ada/tmp",
            "rm /",
            "ls -la /",
            "dd if=/dev/zero of=./disk.img bs=1M count=10",
            "echo hi > /dev/null",
            "curl -s https://api.example | jq . > out.json",
            "grep -r mkfs notes",
            "chmod -R u+w ./out",
            "agent-browser open https://example.org",
        ] {
            assert_eq!(refused(runs, home), None, "{runs}");
        }
    }
}
