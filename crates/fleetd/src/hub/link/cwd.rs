//! Which project a lead-side call's cwd belongs to. Pure.

/// Lexical normal form without a trailing slash (`path.posix.normalize`). The hub cannot see the node's filesystem,
/// so symlinks stay as given.
pub fn normalize(p: &str) -> String {
    let absolute = p.starts_with('/');
    let mut parts: Vec<&str> = vec![];
    for seg in p.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if parts.last().is_some_and(|l| *l != "..") {
                    parts.pop();
                } else if !absolute {
                    parts.push("..");
                }
            }
            s => parts.push(s),
        }
    }
    let joined = parts.join("/");
    match (absolute, joined.is_empty()) {
        (true, _) => format!("/{joined}"),
        (false, true) => ".".to_owned(),
        (false, false) => joined,
    }
}

fn contains(root: &str, cwd: &str) -> bool {
    cwd == root
        || cwd.starts_with(&if root == "/" {
            "/".to_owned()
        } else {
            format!("{root}/")
        })
}

/// The index of the project whose workspace root is `cwd` or one of its ancestors, so worktrees under the root count.
/// With nested roots the deepest wins; with equal roots, the first (newest activity first from the store).
pub fn project_index_for_cwd<'a>(
    roots: impl IntoIterator<Item = &'a str>,
    cwd: &str,
) -> Option<usize> {
    let target = normalize(cwd);
    let mut best: Option<(usize, usize)> = None;
    for (i, root) in roots.into_iter().enumerate() {
        let root = normalize(root);
        if !root.starts_with('/') || !contains(&root, &target) {
            continue;
        }
        // UTF-16 length, as older hubs compared it.
        let depth = root.encode_utf16().count();
        if best.is_none_or(|(_, d)| depth > d) {
            best = Some((i, depth));
        }
    }
    best.map(|(i, _)| i)
}

const MAX_LISTED_ROOTS: usize = 5;

/// `(message, fix)` of the refusal for a cwd outside every project on the machine.
pub fn outside_every_project(machine_id: &str, cwd: &str, roots: &[&str]) -> (String, String) {
    if roots.is_empty() {
        return (
            format!(
                "the hub knows no projects on {machine_id} yet, so it cannot tell which project {cwd} belongs to"
            ),
            format!(
                "check that the node on {machine_id} is online and has added the project (fleetd_status), then run the command again"
            ),
        );
    }
    let listed = roots
        .iter()
        .take(MAX_LISTED_ROOTS)
        .copied()
        .collect::<Vec<_>>()
        .join(", ");
    let more = if roots.len() > MAX_LISTED_ROOTS {
        format!(" and {} more", roots.len() - MAX_LISTED_ROOTS)
    } else {
        String::new()
    };
    (
        format!("{cwd} is not inside any project workspace on {machine_id}"),
        format!("run fleetd from the project's workspace or a worktree under it ({listed}{more})"),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn resolve<'a>(projects: &[(&'a str, &str)], cwd: &str) -> Option<&'a str> {
        project_index_for_cwd(projects.iter().map(|p| p.1), cwd).map(|i| projects[i].0)
    }

    const PROJECTS: [(&str, &str); 3] = [
        ("ab", "/a/b"),
        ("abc", "/a/bc"),
        ("nested", "/a/b/tools/sub"),
    ];

    type Roots<'a> = &'a [(&'a str, &'a str)];

    #[test]
    fn resolves_a_cwd_to_the_deepest_root_it_is_inside() {
        let linked = [("link", "/home/me/proj")];
        let cases: &[(Roots, &str, Option<&str>)] = &[
            (&PROJECTS, "/a/b", Some("ab")),
            (&PROJECTS, "/a/b/src", Some("ab")),
            (&PROJECTS, "/a/b/.fleetd/worktrees/w12/apps", Some("ab")),
            // A sibling sharing a name prefix is not inside.
            (&PROJECTS, "/a/bc", Some("abc")),
            (&PROJECTS, "/a/bcd", None),
            (&[("ab", "/a/b")], "/a/bc/x", None),
            (&PROJECTS, "/a", None),
            (&PROJECTS, "/", None),
            (&PROJECTS, "/elsewhere", None),
            (&PROJECTS, "/a/b/tools/sub/x", Some("nested")),
            (&PROJECTS, "/a/b/tools", Some("ab")),
            // Lexically normalized; `..` cannot climb out of a root and still match it.
            (&[("ab", "/a/b/")], "/a/b", Some("ab")),
            (&PROJECTS, "/a/b/src/", Some("ab")),
            (&PROJECTS, "/a//b/./src", Some("ab")),
            (&PROJECTS, "/a/b/../bc/x", Some("abc")),
            (&PROJECTS, "/a/b/../x", None),
            // Symlinked roots are kept as written.
            (&linked, "/home/me/proj/src", Some("link")),
            (&linked, "/data/proj/src", None),
            (&[("rel", "a/b")], "/a/b", None),
            (&[("root", "/")], "/anything/here", Some("root")),
        ];
        for (projects, cwd, want) in cases {
            assert_eq!(resolve(projects, cwd), *want, "{cwd}");
        }
    }

    #[test]
    fn outside_every_project_lists_five_roots() {
        let roots: Vec<String> = (0..7).map(|i| format!("/src/p{i}")).collect();
        let roots: Vec<&str> = roots.iter().map(String::as_str).collect();
        let (message, fix) = outside_every_project("lab-a", "/tmp", &roots);
        assert_eq!(message, "/tmp is not inside any project workspace on lab-a");
        assert_eq!(
            fix,
            "run fleetd from the project's workspace or a worktree under it (/src/p0, /src/p1, /src/p2, /src/p3, /src/p4 and 2 more)"
        );
        let (_, fix) = outside_every_project("lab-a", "/src/api", &[]);
        assert_eq!(
            fix,
            "check that the node on lab-a is online and has added the project (fleetd_status), then run the command again"
        );
    }
}
