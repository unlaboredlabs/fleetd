//! The CLI reference, parsed from the usage text `fleetd help` prints. That text is the only list of commands the
//! binary has (its parser is hand-rolled, not clap), so reading it here is what keeps the page from drifting.

use crate::md_text;

pub struct Group {
    pub title: String,
    pub id: String,
    pub entries: Vec<Entry>,
    /// Lines after the last entry that talk about the whole group, not that entry.
    pub note: Vec<String>,
}

pub struct Entry {
    pub id: String,
    pub name: String,
    pub synopsis: Vec<String>,
    pub desc: Vec<String>,
}

/// The help's layout: a group heading at column 0 ending in `:`, an entry at column 2 (its description may follow
/// after two spaces), synopsis continuations indented less than 13, descriptions at 13.
pub fn parse(help: &str) -> Result<Vec<Group>, String> {
    let mut groups: Vec<Group> = Vec::new();
    let mut in_note = false;
    for line in help.lines() {
        let body = line.trim_start();
        if body.is_empty() || line.starts_with("usage:") {
            continue;
        }
        let indent = line.len() - body.len();
        if indent == 0 {
            let Some(title) = body.strip_suffix(':') else {
                return Err(format!("fleetd help: unexpected line {line:?}"));
            };
            let short = title.split(" (").next().unwrap_or(title);
            groups.push(Group {
                title: title.to_owned(),
                id: crate::slugify(short),
                entries: Vec::new(),
                note: Vec::new(),
            });
            in_note = false;
            continue;
        }
        let Some(group) = groups.last_mut() else {
            return Err(format!("fleetd help: {line:?} before any group heading"));
        };
        if indent == 2 {
            let (synopsis, desc) = match body.split_once("  ") {
                Some((s, d)) => (s, Some(d.trim())),
                None => (body, None),
            };
            let name = command_words(synopsis).join(" ");
            if name.is_empty() {
                return Err(format!("fleetd help: no command in {line:?}"));
            }
            group.entries.push(Entry {
                id: String::new(),
                name,
                synopsis: vec![synopsis.to_owned()],
                desc: desc.into_iter().map(str::to_owned).collect(),
            });
            continue;
        }
        let Some(entry) = group.entries.last_mut() else {
            return Err(format!("fleetd help: {line:?} before any command"));
        };
        if indent >= 13 {
            let short = group.title.split(" (").next().unwrap_or(&group.title);
            in_note |= body.starts_with(short);
            if in_note {
                group.note.push(body.to_owned());
            } else {
                entry.desc.push(body.to_owned());
            }
        } else {
            entry.synopsis.push(body.to_owned());
        }
    }
    assign_ids(&mut groups);
    if groups.iter().map(|g| g.entries.len()).sum::<usize>() < 10 {
        return Err("fleetd help lists fewer than 10 commands; did its layout change?".into());
    }
    Ok(groups)
}

/// `machine add <ssh-host> | --local …` -> ["machine", "add"].
fn command_words(synopsis: &str) -> Vec<&str> {
    synopsis
        .split_whitespace()
        .take_while(|w| {
            w.chars().next().is_some_and(|c| c.is_ascii_lowercase())
                && w.chars().all(|c| c.is_ascii_lowercase() || c == '-')
        })
        .collect()
}

/// The command words joined by `-`; a repeated command adds its first option and that option's literal value:
/// `request-secret`, `pair-worker`, `hub-key-create-human`.
fn assign_ids(groups: &mut [Group]) {
    let mut seen = std::collections::HashSet::new();
    for entry in groups.iter_mut().flat_map(|g| g.entries.iter_mut()) {
        let mut id = entry.name.replace(' ', "-");
        if seen.contains(&id) {
            let mut words = entry.synopsis[0]
                .split_whitespace()
                .skip_while(|w| !w.trim_start_matches(['[', '(']).starts_with("--"));
            if let Some(flag) = words.next() {
                id.push('-');
                id.push_str(
                    flag.trim_start_matches(['[', '('])
                        .trim_start_matches('-')
                        .trim_end_matches([']', ')']),
                );
                if let Some(value) = words
                    .next()
                    .filter(|w| w.chars().all(|c| c.is_ascii_lowercase()))
                {
                    id.push('-');
                    id.push_str(value);
                }
            }
        }
        while seen.contains(&id) {
            id.push('_');
        }
        seen.insert(id.clone());
        entry.id = id;
    }
}

/// The whole CLI reference page.
pub fn page(_root: &std::path::Path) -> Result<String, String> {
    let groups = parse(&fleetd::cli::usage_text())?;
    let commands: Vec<&str> = groups
        .iter()
        .flat_map(|g| g.entries.iter())
        .filter_map(|e| e.name.split(' ').next())
        .collect();
    let mut md = String::from(
        "---
title: CLI reference
description: Every fleetd command and option, generated from the binary's own help.
tableOfContents:
  maxHeadingLevel: 2
---

<!-- Generated by crates/docsgen from `fleetd help`. Don't edit: run `cargo run -q -p docsgen`. -->

Every `fleetd` command, from `fleetd help` in the binary this site was built with.

| Exit code | Means |
|---|---|
| 0 | ok |
| 1 | failed: a check did not pass |
| 2 | usage error |
| 3 | refused |
| 4 | the hub or the node is unreachable |
| 78 | `listen` only: the hub refused the key |
",
    );
    let mut seen = std::collections::HashSet::new();
    for group in &groups {
        // "lead-side commands (run by a lead …)" -> "Lead-side commands", and the parenthesis as its first line.
        let (short, aside) = match group.title.split_once(" (") {
            Some((s, a)) => (s, Some(a.trim_end_matches(')'))),
            None => (group.title.as_str(), None),
        };
        // Explicit ids keep the anchors (#machine-add, #hub-key-create-human) independent of the heading text.
        for id in std::iter::once(&group.id).chain(group.entries.iter().map(|e| &e.id)) {
            if !seen.insert(id.clone()) {
                return Err(format!("CLI reference: #{id} is used twice"));
            }
        }
        md.push_str(&format!(
            "\n## {} {{#{}}}\n\n",
            md_text(&capitalize(short)),
            group.id
        ));
        if let Some(aside) = aside {
            md.push_str(&format!("{}.\n\n", md_text(&capitalize(aside))));
        }
        // `hub start` alone leaves a hub the other commands can't use; the docs walk through the order that works.
        if group.id == "running-by-hand" {
            md.push_str(
                ":::tip\nRun `fleetd init --no-service` before `fleetd hub start`: it writes the setup the other \
                 commands read. The whole order is in [Run a second fleet on one \
                 machine](/docs/config-and-files#second-fleet).\n:::\n\n",
            );
        }
        for entry in &group.entries {
            let synopsis: Vec<String> = entry
                .synopsis
                .iter()
                .enumerate()
                .map(|(i, l)| {
                    if i == 0 {
                        format!("fleetd {l}")
                    } else {
                        format!("    {l}")
                    }
                })
                .collect();
            md.push_str(&format!(
                "### fleetd {} {{#{}}}\n\n```text\n{}\n```\n\n",
                entry.name,
                entry.id,
                synopsis.join("\n")
            ));
            if !entry.desc.is_empty() {
                md.push_str(&format!("{}\n\n", prose(&entry.desc.join(" "), &commands)));
            }
        }
        if !group.note.is_empty() {
            md.push_str(&format!(
                ":::note\n{}\n:::\n",
                prose(&group.note.join(" "), &commands)
            ));
        }
    }
    Ok(md.trim_end().to_owned() + "\n")
}

fn capitalize(s: &str) -> String {
    s[..1].to_uppercase() + &s[1..]
}

const TRAILING: [char; 6] = [',', ';', ':', '.', ')', '"'];

/// Description prose with machine text set as code: anything in backticks, `--options`, `~/paths`, and `fleetd`
/// followed by command words.
pub fn prose(text: &str, commands: &[&str]) -> String {
    let is_code = |c: &str| (c.starts_with("--") && c.len() > 2) || c.starts_with("~/");
    let mut out = String::new();
    for (i, part) in text.split('`').enumerate() {
        if i % 2 == 1 {
            out.push_str(&format!("`{part}`"));
            continue;
        }
        let tokens: Vec<&str> = part.split(' ').collect();
        let mut t = 0;
        while t < tokens.len() {
            if t > 0 {
                out.push(' ');
            }
            let token = tokens[t];
            let lead = token.len() - token.trim_start_matches(['(', '"']).len();
            let core_end = token.trim_end_matches(TRAILING).len().max(lead);
            let (pre, core, post) = (&token[..lead], &token[lead..core_end], &token[core_end..]);
            let next_is_command = tokens
                .get(t + 1)
                .is_some_and(|n| commands.contains(&n.trim_end_matches(TRAILING)));
            // "the fleetd version" is prose; "then fleetd doctor" names a command.
            let prose_before = t > 0 && ["the", "this", "a"].contains(&tokens[t - 1]);
            if core == "fleetd" && post.is_empty() && next_is_command && !prose_before {
                // "fleetd pair --worker prints": the command words and options that follow, up to punctuation.
                let mut words = vec![core];
                let mut tail = "";
                let mut j = t + 1;
                while let Some(next) = tokens.get(j) {
                    let c = next.trim_end_matches(TRAILING);
                    if !tail.is_empty() || !(commands.contains(&c) || is_code(c)) {
                        break;
                    }
                    words.push(c);
                    tail = &next[c.len()..];
                    j += 1;
                }
                out.push_str(&format!(
                    "{}`{}`{}",
                    md_text(pre),
                    words.join(" "),
                    md_text(tail)
                ));
                t = j;
                continue;
            }
            if is_code(core) {
                out.push_str(&format!("{}`{core}`{}", md_text(pre), md_text(post)));
            } else {
                out.push_str(&md_text(token));
            }
            t += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_real_help() {
        let groups = parse(&fleetd::cli::usage_text()).unwrap();
        let ids: Vec<&str> = groups
            .iter()
            .flat_map(|g| g.entries.iter().map(|e| e.id.as_str()))
            .collect();
        for id in [
            "version",
            "init",
            "init-join",
            "machine-add",
            "pair-worker",
            "hub-key-create-human",
            "request-secret",
            "request-withdraw",
            "change-enqueue",
        ] {
            assert!(ids.contains(&id), "{id} in {ids:?}");
        }
        let lead = groups
            .iter()
            .find(|g| g.id == "lead-side-commands")
            .unwrap();
        assert!(lead.note.join(" ").contains("FLEETD_NODE_SOCK"));
        let last = lead.entries.last().unwrap();
        assert!(!last.desc.join(" ").contains("FLEETD_NODE_SOCK"));
    }

    #[test]
    fn prose_marks_machine_text() {
        let commands = ["pair", "doctor"];
        assert_eq!(
            prose(
                "the command fleetd pair --worker prints, then fleetd doctor. --yes (or ~/.fleetd/hub) and `fleetd node join`",
                &commands
            ),
            "the command `fleetd pair --worker` prints, then `fleetd doctor`. `--yes` (or `~/.fleetd/hub`) and `fleetd node join`"
        );
        assert_eq!(
            prose("replace this fleetd with", &commands),
            "replace this fleetd with"
        );
        assert_eq!(
            prose("print the fleetd doctor", &commands),
            "print the fleetd doctor"
        );
    }
}
