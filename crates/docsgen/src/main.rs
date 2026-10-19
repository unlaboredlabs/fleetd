//! `cargo run -q -p docsgen`: writes the docs' generated markdown from the binary itself, so it can't drift: whole
//! pages (the CLI reference) and generated regions inside hand-written pages (the prompt table). Starlight
//! (`docs/site`) then builds the site from that markdown. `-- --check` writes nothing and fails while any differs.
//! The source format is in `site/README.md` ("Docs").

mod agent_tools;
mod cli_ref;
mod prompts;

use std::path::Path;
use std::process::ExitCode;

/// Starlight's content directory, from the repo root.
const CONTENT: &str = "docs/site/src/content/docs";

/// Takes the repo root, for a generator that reads files (fixtures) as well as the binary.
type Generate = fn(&Path) -> Result<String, String>;

/// Whole pages under CONTENT, frontmatter included.
const GENERATED: &[(&str, Generate)] = &[
    ("reference/cli.md", cli_ref::page),
    (agent_tools::PATH, agent_tools::page),
];

/// Regions of hand-written pages under CONTENT: the lines between `<!-- name -->` and `<!-- /name -->`.
const REGIONS: &[(&str, &str, Generate)] =
    &[("what-agents-are-told.md", "prompt-table", prompts::table)];

fn main() -> ExitCode {
    let check = std::env::args().any(|a| a == "--check");
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let files = match build(&root) {
        Ok(files) => files,
        Err(error) => {
            eprintln!("docsgen: {error}");
            return ExitCode::FAILURE;
        }
    };
    let mut stale = Vec::new();
    for (name, text) in &files {
        let path = root.join(CONTENT).join(name);
        if std::fs::read_to_string(&path).ok().as_deref() == Some(text.as_str()) {
            continue;
        }
        if check {
            stale.push(name);
            continue;
        }
        let _ = std::fs::create_dir_all(path.parent().expect("a file under the content dir"));
        if let Err(error) = std::fs::write(&path, text) {
            eprintln!("docsgen: writing {}: {error}", path.display());
            return ExitCode::FAILURE;
        }
    }
    if stale.is_empty() {
        println!(
            "docsgen: {CONTENT}: {} generated files are current",
            files.len()
        );
        return ExitCode::SUCCESS;
    }
    for name in stale {
        println!(
            "::error file={CONTENT}/{name}::{CONTENT}/{name} is out of date; run `cargo run -q -p docsgen` and commit it"
        );
    }
    ExitCode::FAILURE
}

/// (path under CONTENT, the text it should have).
fn build(root: &Path) -> Result<Vec<(String, String)>, String> {
    let mut files = Vec::new();
    for (name, generate) in GENERATED {
        files.push(((*name).to_owned(), generate(root)?));
    }
    for (name, region, generate) in REGIONS {
        let path = root.join(CONTENT).join(name);
        let text =
            std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        files.push((
            (*name).to_owned(),
            splice(&text, region, &generate(root)?).map_err(|e| format!("{name}: {e}"))?,
        ));
    }
    Ok(files)
}

/// `text` with the lines between the region's markers replaced by `generated`.
fn splice(text: &str, region: &str, generated: &str) -> Result<String, String> {
    let open = format!("<!-- {region} -->\n");
    let close = format!("<!-- /{region} -->\n");
    let start = text
        .find(&open)
        .ok_or_else(|| format!("no {open:?} line"))?
        + open.len();
    let end = text[start..]
        .find(&close)
        .ok_or_else(|| format!("no {close:?} line after {open:?}"))?
        + start;
    Ok(format!("{}\n{generated}\n{}", &text[..start], &text[end..]))
}

/// Lowercased words joined by `-`, as Starlight's heading ids are (github-slugger).
pub fn slugify(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() || c == '_' {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') && c != '\'' {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_owned()
}

/// Text safe in a markdown paragraph or table cell: nothing in it reads as markup.
pub fn md_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(
            c,
            '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>' | '|' | '#' | '{' | '}'
        ) {
            out.push('\\');
        }
        out.push(c);
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn splice_replaces_only_the_region() {
        let text = "a\n<!-- t -->\nold\n<!-- /t -->\nb\n";
        assert_eq!(
            super::splice(text, "t", "new\n").unwrap(),
            "a\n<!-- t -->\n\nnew\n\n<!-- /t -->\nb\n"
        );
        assert!(super::splice("a\n", "t", "x").is_err());
    }

    #[test]
    fn md_text_escapes_markup() {
        assert_eq!(
            super::md_text("<hub url>/mcp *a* | b"),
            "\\<hub url\\>/mcp \\*a\\* \\| b"
        );
    }
}
