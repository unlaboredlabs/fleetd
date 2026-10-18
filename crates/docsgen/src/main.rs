//! `cargo run -q -p docsgen`: renders `docs/site/*.md` and the CLI's own help into `site/docs/`, which is committed
//! because the Vercel project has no build step. `-- --check` writes nothing and fails while `site/docs/` differs.
//! The source format is in `site/README.md` ("Docs").

mod cli_ref;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::Path;
use std::process::ExitCode;

use pulldown_cmark::{CodeBlockKind, CowStr, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

const CSS: &str = include_str!("../assets/docs.css");
const JS: &str = include_str!("../assets/docs.js");
const REPO: &str = "https://github.com/unlaboredlabs/fleetd";
/// Generated files under site/docs/ that a run owns; anything else there (img/) is left alone.
const KEEP: &[&str] = &["img"];

struct Front {
    title: String,
    section: String,
    order: i64,
    description: String,
    slug: String,
}

struct Page {
    file: String,
    front: Front,
    body: String,
    /// (level, text, id) of every h2 and h3.
    headings: Vec<(u8, String, String)>,
    ids: HashSet<String>,
    /// (slug, anchor) this page links to.
    links: Vec<(String, Option<String>)>,
    text: String,
}

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
    let out = root.join("site/docs");
    let existing = list(&out);
    if check {
        let mut stale: Vec<String> = files
            .iter()
            .filter(|(name, bytes)| {
                std::fs::read(out.join(name)).ok().as_deref() != Some(bytes.as_bytes())
            })
            .map(|(name, _)| name.clone())
            .collect();
        stale.extend(existing.iter().filter(|n| !files.contains_key(*n)).cloned());
        if stale.is_empty() {
            println!("docsgen: site/docs is up to date ({} files)", files.len());
            return ExitCode::SUCCESS;
        }
        for name in stale {
            println!(
                "::error file=site/docs/{name}::site/docs/{name} is out of date; run `cargo run -q -p docsgen` and commit site/docs"
            );
        }
        return ExitCode::FAILURE;
    }
    for name in existing.iter().filter(|n| !files.contains_key(*n)) {
        let _ = std::fs::remove_file(out.join(name));
    }
    for (name, bytes) in &files {
        let path = out.join(name);
        let _ = std::fs::create_dir_all(path.parent().expect("a file under site/docs"));
        if std::fs::read(&path).ok().as_deref() != Some(bytes.as_bytes())
            && let Err(error) = std::fs::write(&path, bytes)
        {
            eprintln!("docsgen: writing {}: {error}", path.display());
            return ExitCode::FAILURE;
        }
    }
    println!("docsgen: wrote site/docs ({} files)", files.len());
    ExitCode::SUCCESS
}

/// Files directly in site/docs/ (not the hand-kept subdirectories).
fn list(dir: &Path) -> Vec<String> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    entries
        .filter_map(Result::ok)
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| !KEEP.contains(&n.as_str()))
        .collect()
}

fn build(root: &Path) -> Result<BTreeMap<String, String>, String> {
    let src = root.join("docs/site");
    let mut sources: Vec<(String, String)> = std::fs::read_dir(&src)
        .map_err(|e| format!("{}: {e}", src.display()))?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "md"))
        .map(|p| -> Result<(String, String), String> {
            let name = p
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or_default()
                .to_owned();
            std::fs::read_to_string(&p)
                .map(|t| (name, t))
                .map_err(|e| format!("{}: {e}", p.display()))
        })
        .collect::<Result<_, _>>()?;
    sources.sort();

    let mut fronts = Vec::new();
    for (file, text) in &sources {
        let (front, body) = frontmatter(file, text)?;
        fronts.push((file.clone(), front, body));
    }
    let slugs: HashMap<String, String> = fronts
        .iter()
        .map(|(f, fr, _)| (f.clone(), fr.slug.clone()))
        .collect();
    let mut seen_slug = HashSet::new();
    let mut seen_order = HashSet::new();
    for (file, front, _) in &fronts {
        if !seen_slug.insert(front.slug.clone()) || front.slug == "index" {
            return Err(format!("docs/site/{file}: slug {:?} is taken", front.slug));
        }
        if !seen_order.insert(front.order) {
            return Err(format!(
                "docs/site/{file}: order {} is used by another page",
                front.order
            ));
        }
    }

    let mut pages = Vec::new();
    for (file, front, body) in fronts {
        let mut page = render(&file, front, body, &slugs)?;
        if page.file == "cli.md" {
            cli_reference(&mut page)?;
        }
        pages.push(page);
    }
    pages.sort_by_key(|p| p.front.order);

    // Every link to a page and anchor resolves.
    let by_slug: HashMap<&str, &Page> = pages.iter().map(|p| (p.front.slug.as_str(), p)).collect();
    for page in &pages {
        for (slug, anchor) in &page.links {
            let target = by_slug.get(slug.as_str()).ok_or_else(|| {
                format!("docs/site/{}: links to a missing page {slug}", page.file)
            })?;
            if let Some(anchor) = anchor
                && !target.ids.contains(anchor)
            {
                return Err(format!(
                    "docs/site/{}: links to #{anchor}, which {} doesn't have",
                    page.file, target.file
                ));
            }
        }
    }

    // Sections in the order of their first page; a section split by another breaks the nav.
    let mut sections: Vec<(String, Vec<&Page>)> = Vec::new();
    for page in &pages {
        match sections.last_mut() {
            Some((name, list)) if *name == page.front.section => list.push(page),
            _ => {
                if sections.iter().any(|(n, _)| *n == page.front.section) {
                    return Err(format!(
                        "docs/site/{}: section {:?} is split by another section; fix the orders",
                        page.file, page.front.section
                    ));
                }
                sections.push((page.front.section.clone(), vec![page]));
            }
        }
    }

    let v = |s: &str| format!("{:08x}", fnv(s) as u32);
    let assets = Assets {
        css: format!("/docs/docs.css?v={}", v(CSS)),
        js: format!("/docs/docs.js?v={}", v(JS)),
    };
    let mut files = BTreeMap::new();
    files.insert("docs.css".into(), CSS.to_owned());
    files.insert("docs.js".into(), JS.to_owned());
    files.insert("index.html".into(), index_html(&sections, &assets));
    for (i, page) in pages.iter().enumerate() {
        let prev = i.checked_sub(1).map(|j| &pages[j]);
        let next = pages.get(i + 1);
        files.insert(
            format!("{}.html", page.front.slug),
            page_html(page, &sections, prev, next, &assets),
        );
    }
    files.insert("search.json".into(), search_index(&pages));
    Ok(files)
}

fn frontmatter(file: &str, text: &str) -> Result<(Front, String), String> {
    let err = |m: String| format!("docs/site/{file}: {m}");
    let rest = text
        .strip_prefix("---\n")
        .ok_or_else(|| err("starts with a --- frontmatter block".into()))?;
    let (head, body) = rest
        .split_once("\n---\n")
        .ok_or_else(|| err("frontmatter has no closing ---".into()))?;
    let mut map = HashMap::new();
    for line in head.lines().filter(|l| !l.trim().is_empty()) {
        let (k, v) = line
            .split_once(':')
            .ok_or_else(|| err(format!("frontmatter line {line:?} is not key: value")))?;
        let k = k.trim();
        if !["title", "section", "order", "description", "slug"].contains(&k) {
            return Err(err(format!("unknown frontmatter key {k:?}")));
        }
        let v = v.trim();
        let v = v
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .unwrap_or(v);
        map.insert(k, v.to_owned());
    }
    let mut take = |k: &str| {
        map.remove(k)
            .filter(|v| !v.is_empty())
            .ok_or_else(|| err(format!("frontmatter needs {k}")))
    };
    let stem = file.trim_end_matches(".md").to_owned();
    let front = Front {
        title: take("title")?,
        section: take("section")?,
        order: take("order")?
            .parse()
            .map_err(|_| err("order is an integer".into()))?,
        description: take("description")?,
        slug: take("slug").unwrap_or(stem),
    };
    if !front
        .slug
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err(err(format!("slug {:?} is not [a-z0-9-]", front.slug)));
    }
    Ok((front, body.to_owned()))
}

pub fn slugify(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars().flat_map(char::to_lowercase) {
        if c.is_alphanumeric() || c == '_' {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') && c != '\'' && c != '’' {
            out.push('-');
        }
    }
    out.trim_end_matches('-').to_owned()
}

pub fn esc(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

fn fnv(s: &str) -> u64 {
    s.bytes().fold(0xcbf29ce484222325, |h, b| {
        (h ^ u64::from(b)).wrapping_mul(0x100000001b3)
    })
}

fn render(
    file: &str,
    front: Front,
    md: String,
    slugs: &HashMap<String, String>,
) -> Result<Page, String> {
    let err = |m: String| format!("docs/site/{file}: {m}");
    let opts = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_HEADING_ATTRIBUTES;
    let mut parser = Parser::new_ext(&md, opts);
    let mut events: Vec<Event> = Vec::new();
    let mut page = Page {
        file: file.to_owned(),
        front,
        body: String::new(),
        headings: Vec::new(),
        ids: HashSet::new(),
        links: Vec::new(),
        text: String::new(),
    };
    while let Some(event) = parser.next() {
        match event {
            Event::Start(Tag::Heading { level, id, .. }) => {
                let n = match level {
                    HeadingLevel::H2 => 2,
                    HeadingLevel::H3 => 3,
                    HeadingLevel::H4 => 4,
                    _ => {
                        return Err(err(
                            "use ## to #### for headings; the title is the page's h1".into(),
                        ));
                    }
                };
                let mut inner = Vec::new();
                for e in parser.by_ref() {
                    if matches!(e, Event::End(TagEnd::Heading(_))) {
                        break;
                    }
                    inner.push(e);
                }
                let text: String = inner
                    .iter()
                    .filter_map(|e| match e {
                        Event::Text(t) | Event::Code(t) => Some(t.as_ref()),
                        _ => None,
                    })
                    .collect();
                let id = id.map(|i| i.to_string()).unwrap_or_else(|| slugify(&text));
                if !page.ids.insert(id.clone()) {
                    return Err(err(format!(
                        "two headings have the id #{id}; pin one with {{#other-id}}"
                    )));
                }
                let mut html = String::new();
                pulldown_cmark::html::push_html(
                    &mut html,
                    inner
                        .into_iter()
                        .map(link_rewriter(file, slugs, &mut page.links))
                        .collect::<Result<Vec<_>, _>>()?
                        .into_iter(),
                );
                events.push(Event::Html(heading(n, &id, &html).into()));
                page.text.push_str(&text);
                page.text.push('\n');
                if n <= 3 {
                    page.headings.push((n, text, id));
                }
            }
            Event::Start(Tag::CodeBlock(kind)) => {
                let info = match kind {
                    CodeBlockKind::Fenced(info) => info.to_string(),
                    CodeBlockKind::Indented => {
                        return Err(err(
                            "use a fenced code block (```sh, ```console, ```text)".into()
                        ));
                    }
                };
                let mut code = String::new();
                for e in parser.by_ref() {
                    match e {
                        Event::End(TagEnd::CodeBlock) => break,
                        Event::Text(t) => code.push_str(&t),
                        _ => {}
                    }
                }
                let (html, searchable) = code_block(&info, &code).map_err(err)?;
                page.text.push_str(&searchable);
                page.text.push('\n');
                events.push(Event::Html(html.into()));
            }
            Event::Html(h) | Event::InlineHtml(h) => events.push(Event::Text(h)),
            other => {
                if let Event::Text(t) | Event::Code(t) = &other {
                    page.text.push_str(t);
                    page.text.push(' ');
                }
                events.push(link_rewriter(file, slugs, &mut page.links)(other)?);
            }
        }
    }
    pulldown_cmark::html::push_html(&mut page.body, events.into_iter());
    // Tables scroll on their own on a phone instead of widening the page.
    page.body = page
        .body
        .replace("<table>", "<div class=\"table\"><table>")
        .replace("</table>", "</table></div>");
    Ok(page)
}

fn heading(n: u8, id: &str, inner: &str) -> String {
    format!(
        "<h{n} id=\"{id}\">{inner}<a class=\"anchor\" href=\"#{id}\" aria-label=\"Link to this section\">#</a></h{n}>\n"
    )
}

/// `machines.md#doctor` -> `/docs/machines#doctor`, recording it for the check; external and site links pass as is.
fn link_rewriter<'a, 'b>(
    file: &'b str,
    slugs: &'b HashMap<String, String>,
    links: &'b mut Vec<(String, Option<String>)>,
) -> impl FnMut(Event<'a>) -> Result<Event<'a>, String> + 'b {
    move |event| {
        let Event::Start(Tag::Link {
            link_type,
            dest_url,
            title,
            id,
        }) = event
        else {
            return Ok(event);
        };
        let dest = dest_url.to_string();
        let own_slug = slugs.get(file).cloned().unwrap_or_default();
        let new = if dest.starts_with("http://")
            || dest.starts_with("https://")
            || dest.starts_with("mailto:")
            || dest.starts_with('/')
        {
            dest
        } else if let Some(anchor) = dest.strip_prefix('#') {
            links.push((own_slug, Some(anchor.to_owned())));
            dest
        } else {
            let (target, anchor) = match dest.split_once('#') {
                Some((t, a)) => (t, Some(a.to_owned())),
                None => (dest.as_str(), None),
            };
            let slug = slugs.get(target).ok_or_else(|| format!("docs/site/{file}: link to {dest}: page links are <file>.md, and docs/site/{target} doesn't exist"))?;
            links.push((slug.clone(), anchor.clone()));
            format!(
                "/docs/{slug}{}",
                anchor.map(|a| format!("#{a}")).unwrap_or_default()
            )
        };
        Ok(Event::Start(Tag::Link {
            link_type,
            dest_url: CowStr::from(new),
            title,
            id,
        }))
    }
}

/// The block's HTML and the text search should see (commands, not output).
fn code_block(info: &str, code: &str) -> Result<(String, String), String> {
    let mut words = info.split_whitespace();
    let lang = words.next().unwrap_or("");
    if !["sh", "console", "text", "yaml", "toml", "json", "ini"].contains(&lang) {
        return Err(format!(
            "code block {info:?}: start it with ```sh, ```console, ```text, ```yaml, ```toml, ```json or ```ini"
        ));
    }
    let mut capture = None;
    for word in words {
        match word.strip_prefix("capture=") {
            Some(name)
                if lang == "console"
                    && !name.is_empty()
                    && name
                        .chars()
                        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-') =>
            {
                capture = Some(name)
            }
            _ => {
                return Err(format!(
                    "code block {info:?}: only ```console capture=<name> ([a-z0-9-]) is understood after the language"
                ));
            }
        }
    }
    let code = code.strip_suffix('\n').unwrap_or(code);
    let (body, searchable) = if lang == "console" {
        let mut body = String::new();
        let mut commands = String::new();
        let mut continued = false;
        let mut open: Option<&str> = None;
        for line in code.split('\n') {
            let is_command = continued || line.starts_with("$ ");
            continued = is_command && line.ends_with('\\');
            let class = if is_command { "c" } else { "o" };
            if open != Some(class) {
                if open.is_some() {
                    body.push_str("</span>");
                }
                body.push_str(&format!("<span class=\"{class}\">"));
                open = Some(class);
            }
            body.push_str(&esc(line));
            body.push('\n');
            if is_command {
                commands.push_str(line.trim_start_matches("$ "));
                commands.push('\n');
            }
        }
        // The newline before a closing tag would add an empty last line.
        let body =
            format!("{}</span>", body.trim_end_matches('\n')).replace("\n</span>", "</span>\n");
        (body, commands)
    } else if lang == "sh" {
        // One span per command so each gets its own `$ ` (drawn by CSS, so copying leaves it out); comments get none.
        let lines: Vec<String> = code
            .split('\n')
            .map(|l| {
                if l.is_empty() || l.starts_with('#') {
                    esc(l)
                } else {
                    format!("<span class=\"l\">{}</span>", esc(l))
                }
            })
            .collect();
        (lines.join("\n"), code.to_owned())
    } else {
        (
            esc(code),
            if lang == "text" {
                String::new()
            } else {
                code.to_owned()
            },
        )
    };
    let copy = if lang == "text" { "" } else { " data-copy" };
    let capture = capture
        .map(|c| format!(" data-capture=\"{c}\""))
        .unwrap_or_default();
    Ok((
        format!("<pre class=\"code {lang}\"{copy}{capture}><code>{body}</code></pre>\n"),
        searchable,
    ))
}

fn cli_reference(page: &mut Page) -> Result<(), String> {
    let groups = cli_ref::parse(&fleetd::cli::usage_text())?;
    let commands: Vec<&str> = groups
        .iter()
        .flat_map(|g| g.entries.iter())
        .filter_map(|e| e.name.split(' ').next())
        .collect();
    let mut html = String::new();
    for group in &groups {
        if !page.ids.insert(group.id.clone()) {
            return Err(format!("cli.md: #{} is used twice", group.id));
        }
        // "lead-side commands (run by a lead …)" -> "Lead-side commands", and the parenthesis as its lede.
        let (short, aside) = match group.title.split_once(" (") {
            Some((s, a)) => (s, Some(a.trim_end_matches(')'))),
            None => (group.title.as_str(), None),
        };
        let title = short[..1].to_uppercase() + &short[1..];
        html.push_str(&heading(2, &group.id, &esc(&title)));
        if let Some(aside) = aside {
            html.push_str(&format!(
                "<p class=\"lede\">{}.</p>\n",
                esc(&(aside[..1].to_uppercase() + &aside[1..]))
            ));
        }
        page.headings.push((2, title, group.id.clone()));
        html.push_str("<dl class=\"cli\">\n");
        for entry in &group.entries {
            if !page.ids.insert(entry.id.clone()) {
                return Err(format!("cli.md: #{} is used twice", entry.id));
            }
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
            html.push_str(&format!(
                "<dt id=\"{id}\"><a class=\"anchor\" href=\"#{id}\" aria-label=\"Link to fleetd {name}\">#</a><pre class=\"syn\"><code>{syn}</code></pre></dt>\n",
                id = entry.id,
                name = esc(&entry.name),
                syn = esc(&synopsis.join("\n")),
            ));
            if !entry.desc.is_empty() {
                html.push_str(&format!(
                    "<dd>{}</dd>\n",
                    cli_ref::prose(&entry.desc.join(" "), &commands)
                ));
            }
            page.headings
                .push((3, format!("fleetd {}", entry.name), entry.id.clone()));
            page.text.push_str(&format!(
                "{}\n{}\n",
                synopsis.join(" "),
                entry.desc.join(" ")
            ));
        }
        html.push_str("</dl>\n");
        if !group.note.is_empty() {
            html.push_str(&format!(
                "<p class=\"note\">{}</p>\n",
                cli_ref::prose(&group.note.join(" "), &commands)
            ));
        }
    }
    page.body.push_str(&html);
    Ok(())
}

struct Assets {
    css: String,
    js: String,
}

fn head(title: &str, description: &str, assets: &Assets) -> String {
    format!(
        r##"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{description}">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="preload" href="/fonts/plex-sans-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="preload" href="/fonts/lilex-Regular.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="{css}">
<script src="{js}" defer></script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<header class="top">
  <a class="mark" href="/">fleetd</a><a class="crumb" href="/docs">docs</a>
  <div class="search" role="search">
    <input id="q" type="search" placeholder="Search" aria-label="Search the docs" autocomplete="off" spellcheck="false"><kbd>/</kbd>
    <ul id="hits" role="listbox" hidden></ul>
  </div>
  <a class="gh" href="{REPO}">GitHub</a>
  <button class="menu" type="button" aria-controls="side" aria-expanded="false">Menu</button>
</header>
"##,
        title = esc(title),
        description = esc(description),
        css = assets.css,
        js = assets.js,
    )
}

fn nav(sections: &[(String, Vec<&Page>)], current: Option<&str>) -> String {
    let mut html = String::from("<nav class=\"side\" id=\"side\" aria-label=\"Docs\">\n");
    for (name, pages) in sections {
        html.push_str(&format!("<p>{}</p>\n<ul>\n", esc(name)));
        for page in pages {
            let here = if current == Some(page.front.slug.as_str()) {
                " aria-current=\"page\""
            } else {
                ""
            };
            html.push_str(&format!(
                "<li><a href=\"/docs/{}\"{here}>{}</a></li>\n",
                page.front.slug,
                esc(&page.front.title)
            ));
        }
        html.push_str("</ul>\n");
    }
    html.push_str("</nav>\n");
    html
}

const FOOT: &str = "<footer class=\"end\"><span>fleetd · MIT</span><a href=\"/\">fleetd.sh</a></footer>\n</body>\n</html>\n";

fn page_html(
    page: &Page,
    sections: &[(String, Vec<&Page>)],
    prev: Option<&Page>,
    next: Option<&Page>,
    assets: &Assets,
) -> String {
    let f = &page.front;
    let mut html = head(
        &format!("{} · fleetd docs", f.title),
        &f.description,
        assets,
    );
    html.push_str("<div class=\"wrap\">\n");
    html.push_str(&nav(sections, Some(&f.slug)));
    html.push_str(&format!(
        "<main class=\"doc\" id=\"main\">\n<p class=\"kicker\">{}</p>\n<h1>{}</h1>\n",
        esc(&f.section),
        esc(&f.title)
    ));
    html.push_str(&page.body);
    html.push_str("<nav class=\"pn\" aria-label=\"Previous and next\">\n");
    for (class, label, p) in [("prev", "Previous", prev), ("next", "Next", next)] {
        match p {
            Some(p) => html.push_str(&format!(
                "<a class=\"{class}\" href=\"/docs/{}\"><span>{label}</span>{}</a>\n",
                p.front.slug,
                esc(&p.front.title)
            )),
            None => html.push_str("<span></span>\n"),
        }
    }
    html.push_str(&format!("</nav>\n<p class=\"edit\"><a href=\"{REPO}/edit/main/docs/site/{}\">Edit this page</a></p>\n</main>\n", page.file));
    let toc: Vec<_> = page.headings.iter().filter(|(n, _, _)| *n == 2).collect();
    if toc.len() >= 2 {
        html.push_str(
            "<aside class=\"toc\" aria-label=\"On this page\">\n<p>On this page</p>\n<ul>\n",
        );
        for (_, text, id) in toc {
            html.push_str(&format!("<li><a href=\"#{id}\">{}</a></li>\n", esc(text)));
        }
        html.push_str("</ul>\n</aside>\n");
    }
    html.push_str("</div>\n");
    html.push_str(FOOT);
    html
}

fn index_html(sections: &[(String, Vec<&Page>)], assets: &Assets) -> String {
    let mut html = head(
        "fleetd docs",
        "How to install, set up and run fleetd: machines, projects, orders, approvals, the desktop app and the CLI.",
        assets,
    );
    html.push_str("<div class=\"wrap\">\n");
    html.push_str(&nav(sections, None));
    html.push_str("<main class=\"doc\" id=\"main\">\n<h1>fleetd docs</h1>\n");
    for (name, pages) in sections {
        let id = slugify(name);
        html.push_str(&heading(2, &id, &esc(name)));
        html.push_str("<dl class=\"idx\">\n");
        for page in pages {
            html.push_str(&format!(
                "<dt><a href=\"/docs/{}\">{}</a></dt><dd>{}</dd>\n",
                page.front.slug,
                esc(&page.front.title),
                esc(&page.front.description)
            ));
        }
        html.push_str("</dl>\n");
    }
    html.push_str("</main>\n</div>\n");
    html.push_str(FOOT);
    html
}

/// One entry per page: title, url, section, description, headings and the page's words, for docs.js.
fn search_index(pages: &[Page]) -> String {
    let entries: Vec<serde_json::Value> = pages
        .iter()
        .map(|p| {
            let words = p.text.split_whitespace().collect::<Vec<_>>().join(" ");
            serde_json::json!({
                "t": p.front.title,
                "u": format!("/docs/{}", p.front.slug),
                "s": p.front.section,
                "d": p.front.description,
                "h": p.headings.iter().map(|(_, text, id)| [text.as_str(), id.as_str()]).collect::<Vec<_>>(),
                "x": words,
            })
        })
        .collect();
    serde_json::to_string(&entries).expect("json") + "\n"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs() {
        assert_eq!(slugify("Remove a machine"), "remove-a-machine");
        assert_eq!(slugify("Projects & orders"), "projects-orders");
        assert_eq!(slugify("What's `claude.env`?"), "whats-claude-env");
        assert_eq!(slugify("claude_login"), "claude_login");
    }

    #[test]
    fn console_blocks_split_commands_from_output() {
        let (html, search) = code_block(
            "console capture=x",
            "$ fleetd version\nfleetd 0.1.0 (protocol 1)\n$ a \\\n  b\nout\n",
        )
        .unwrap();
        assert_eq!(
            html,
            "<pre class=\"code console\" data-copy data-capture=\"x\"><code><span class=\"c\">$ fleetd version</span>\n<span class=\"o\">fleetd 0.1.0 (protocol 1)</span>\n<span class=\"c\">$ a \\\n  b</span>\n<span class=\"o\">out</span></code></pre>\n"
        );
        assert_eq!(search, "fleetd version\na \\\n  b\n");
        assert!(code_block("text capture=x", "").is_err());
        assert!(code_block("bash", "").is_err());
        assert!(!code_block("text", "x").unwrap().0.contains("data-copy"));
    }

    #[test]
    fn links_resolve_or_fail() {
        let slugs = HashMap::from([
            ("a.md".to_owned(), "a".to_owned()),
            ("b.md".to_owned(), "bee".to_owned()),
        ]);
        let front = |slug: &str| Front {
            title: "T".into(),
            section: "S".into(),
            order: 1,
            description: "D".into(),
            slug: slug.into(),
        };
        let page = render(
            "a.md",
            front("a"),
            "## Hi there\n\nSee [b](b.md#x) and <b>raw</b>.\n".into(),
            &slugs,
        )
        .unwrap();
        assert!(page.body.contains("href=\"/docs/bee#x\""));
        assert!(page.body.contains("&lt;b&gt;raw&lt;/b&gt;"));
        assert!(page.body.contains("<h2 id=\"hi-there\">"));
        assert_eq!(page.links, [("bee".to_owned(), Some("x".to_owned()))]);
        assert!(render("a.md", front("a"), "[c](c.md)".into(), &slugs).is_err());
        assert!(render("a.md", front("a"), "# Title".into(), &slugs).is_err());
    }
}
