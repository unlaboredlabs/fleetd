//! The text of an Office file a person sent (.docx, .xlsx, .pptx), which a lead's Read can't open: a Word document's
//! paragraphs, an Excel workbook's sheets as CSV, a PowerPoint deck's slides. The hub writes it beside the file
//! ([`super::attachments::place`]). Read from the file's zip by hand (stored or deflated entries only), and bounded
//! however the file is built: each entry inflates to at most [`ENTRY_MAX`] and the text stops at [`TEXT_MAX`].
use std::io::Read;

use fleetd_contracts::mcp::AttachmentMime;

/// The most one entry of the archive inflates to: a zip bomb stops here.
const ENTRY_MAX: u64 = 64 * 1024 * 1024;
/// The most text written for one file.
pub const TEXT_MAX: usize = 4 * 1024 * 1024;

/// The file's text, or None when it isn't an Office file or holds none.
pub fn text(mime: AttachmentMime, bytes: &[u8]) -> Option<String> {
    let zip = Zip::open(bytes)?;
    let mut out = match mime {
        AttachmentMime::Docx => paragraphs(&zip.read("word/document.xml")?),
        AttachmentMime::Pptx => slides(&zip),
        AttachmentMime::Xlsx => sheets(&zip),
        _ => return None,
    };
    if out.trim().is_empty() {
        return None;
    }
    if out.len() > TEXT_MAX {
        let mut cut = TEXT_MAX;
        while !out.is_char_boundary(cut) {
            cut -= 1;
        }
        out.truncate(cut);
        out.push_str("\n[cut: the rest of the file's text is longer than fleetd writes]\n");
    }
    Some(out)
}

/// A zip archive's entries, by name.
struct Zip<'a> {
    bytes: &'a [u8],
    /// Each entry's name, compression method, compressed size and local header's offset.
    entries: Vec<(String, u16, usize, usize)>,
}

fn u16_at(b: &[u8], at: usize) -> Option<u16> {
    Some(u16::from_le_bytes(b.get(at..at + 2)?.try_into().ok()?))
}

fn u32_at(b: &[u8], at: usize) -> Option<usize> {
    Some(u32::from_le_bytes(b.get(at..at + 4)?.try_into().ok()?) as usize)
}

impl<'a> Zip<'a> {
    fn open(bytes: &'a [u8]) -> Option<Self> {
        // The end-of-directory record sits in the last 64 KiB and some.
        let from = bytes.len().saturating_sub(22 + 65_535);
        let end = (from..=bytes.len().checked_sub(22)?)
            .rev()
            .find(|&at| bytes[at..].starts_with(b"PK\x05\x06"))?;
        let count = u16_at(bytes, end + 10)? as usize;
        let mut at = u32_at(bytes, end + 16)?;
        let mut entries = Vec::with_capacity(count.min(4096));
        for _ in 0..count {
            if !bytes.get(at..)?.starts_with(b"PK\x01\x02") {
                return None;
            }
            let method = u16_at(bytes, at + 10)?;
            let size = u32_at(bytes, at + 20)?;
            let (name_len, extra, comment) = (
                u16_at(bytes, at + 28)? as usize,
                u16_at(bytes, at + 30)? as usize,
                u16_at(bytes, at + 32)? as usize,
            );
            let local = u32_at(bytes, at + 42)?;
            let name =
                String::from_utf8_lossy(bytes.get(at + 46..at + 46 + name_len)?).into_owned();
            entries.push((name, method, size, local));
            at += 46 + name_len + extra + comment;
        }
        Some(Zip { bytes, entries })
    }

    fn names(&self) -> impl Iterator<Item = &str> {
        self.entries.iter().map(|(n, ..)| n.as_str())
    }

    /// One entry's text, inflated up to [`ENTRY_MAX`]; None when it is missing or can't be read.
    fn read(&self, name: &str) -> Option<String> {
        let (_, method, size, local) = self.entries.iter().find(|(n, ..)| n == name)?;
        let b = self.bytes;
        if !b.get(*local..)?.starts_with(b"PK\x03\x04") {
            return None;
        }
        let start = local + 30 + u16_at(b, local + 26)? as usize + u16_at(b, local + 28)? as usize;
        let data = b.get(start..start.checked_add(*size)?)?;
        let mut out = Vec::new();
        match method {
            0 => data.take(ENTRY_MAX).read_to_end(&mut out).ok()?,
            8 => flate2::read::DeflateDecoder::new(data)
                .take(ENTRY_MAX)
                .read_to_end(&mut out)
                .ok()?,
            _ => return None,
        };
        Some(String::from_utf8_lossy(&out).into_owned())
    }
}

/// One piece of XML: a tag (its name without a prefix, whether it closes, and its attributes as written) or text.
enum Xml<'a> {
    Open(&'a str, &'a str),
    Close(&'a str),
    Text(&'a str),
}

/// The tags and text of an XML document, in order: enough to read Office's own XML, never a general parser.
fn xml(doc: &str) -> impl Iterator<Item = Xml<'_>> {
    let mut rest = doc;
    std::iter::from_fn(move || {
        loop {
            if rest.is_empty() {
                return None;
            }
            if let Some(after) = rest.strip_prefix('<') {
                let end = after.find('>')?;
                let tag = &after[..end];
                rest = &after[end + 1..];
                if tag.starts_with('?') || tag.starts_with('!') {
                    continue;
                }
                if let Some(name) = tag.strip_prefix('/') {
                    return Some(Xml::Close(local(name.trim())));
                }
                let tag = tag.strip_suffix('/').unwrap_or(tag);
                let (name, attrs) = tag.split_once(char::is_whitespace).unwrap_or((tag, ""));
                // A self-closing tag (`<w:tab/>`) is an open one with no close: what matters is where it is.
                return Some(Xml::Open(local(name), attrs));
            }
            let end = rest.find('<').unwrap_or(rest.len());
            let text = &rest[..end];
            rest = &rest[end..];
            return Some(Xml::Text(text));
        }
    })
}

fn local(name: &str) -> &str {
    name.rsplit_once(':').map_or(name, |(_, n)| n)
}

fn attr<'a>(attrs: &'a str, key: &str) -> Option<&'a str> {
    let mut rest = attrs;
    while let Some(at) = rest.find(key) {
        let before_ok = at == 0 || rest[..at].ends_with(|c: char| c.is_whitespace() || c == ':');
        let after = rest[at + key.len()..].trim_start();
        if before_ok && let Some(value) = after.strip_prefix('=') {
            let value = value.trim_start();
            let quote = value.chars().next()?;
            let value = &value[1..];
            return value.find(quote).map(|end| &value[..end]);
        }
        rest = &rest[at + key.len()..];
    }
    None
}

/// Text with XML's entities read: `&amp;`, `&lt;`, `&#233;`.
fn unescape(text: &str, out: &mut String) {
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let after = &rest[at + 1..];
        let Some(end) = after.find(';').filter(|&e| e <= 10) else {
            out.push('&');
            rest = after;
            continue;
        };
        let entity = &after[..end];
        let c = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            e => e
                .strip_prefix("#x")
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| e.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match c {
            Some(c) => {
                out.push(c);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
}

/// A Word document's or a slide's text: each paragraph a line, a table's cells split by tabs.
fn paragraphs(doc: &str) -> String {
    let mut out = String::new();
    let mut in_text = false;
    for piece in xml(doc) {
        match piece {
            Xml::Open("t", _) => in_text = true,
            Xml::Close("t") => in_text = false,
            Xml::Text(t) if in_text => unescape(t, &mut out),
            Xml::Open("tab", _) | Xml::Close("tc") => out.push('\t'),
            Xml::Open("br", _) | Xml::Close("p") | Xml::Close("tr") => out.push('\n'),
            _ => {}
        }
        if out.len() > TEXT_MAX {
            break;
        }
    }
    out
}

/// A deck's slides in order, each under its number.
fn slides(zip: &Zip) -> String {
    let mut numbers: Vec<u32> = zip
        .names()
        .filter_map(|n| {
            n.strip_prefix("ppt/slides/slide")?
                .strip_suffix(".xml")?
                .parse()
                .ok()
        })
        .collect();
    numbers.sort_unstable();
    let mut out = String::new();
    for n in numbers {
        let Some(doc) = zip.read(&format!("ppt/slides/slide{n}.xml")) else {
            continue;
        };
        out.push_str(&format!(
            "## Slide {n}\n\n{}\n\n",
            paragraphs(&doc).trim_end()
        ));
        if out.len() > TEXT_MAX {
            break;
        }
    }
    out
}

/// A cell's column from its reference (`C7` is 2), counting from 0.
fn column(reference: &str) -> usize {
    reference
        .chars()
        .take_while(char::is_ascii_alphabetic)
        .fold(0, |n, c| {
            n * 26 + (c.to_ascii_uppercase() as usize - 'A' as usize + 1)
        })
        .saturating_sub(1)
}

fn csv_cell(cell: &str) -> String {
    if cell.contains([',', '"', '\n', '\r']) {
        format!("\"{}\"", cell.replace('"', "\"\""))
    } else {
        cell.to_owned()
    }
}

/// A workbook's sheets in its own order, each under its name as CSV.
fn sheets(zip: &Zip) -> String {
    // The shared strings, which most text cells name by index.
    let mut shared: Vec<String> = Vec::new();
    if let Some(doc) = zip.read("xl/sharedStrings.xml") {
        let mut in_text = false;
        for piece in xml(&doc) {
            match piece {
                Xml::Open("si", _) => shared.push(String::new()),
                Xml::Open("t", _) => in_text = true,
                Xml::Close("t") => in_text = false,
                Xml::Text(t) if in_text => {
                    if let Some(s) = shared.last_mut() {
                        unescape(t, s);
                    }
                }
                _ => {}
            }
        }
    }
    // Each sheet's name and file, by the workbook and its relationships.
    let rels: Vec<(String, String)> = zip
        .read("xl/_rels/workbook.xml.rels")
        .map(|doc| {
            xml(&doc)
                .filter_map(|p| match p {
                    Xml::Open("Relationship", a) => {
                        Some((attr(a, "Id")?.to_owned(), attr(a, "Target")?.to_owned()))
                    }
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    let listed: Vec<(String, String)> = zip
        .read("xl/workbook.xml")
        .map(|doc| {
            xml(&doc)
                .filter_map(|p| match p {
                    Xml::Open("sheet", a) => {
                        let id = attr(a, "r:id").or_else(|| attr(a, "id"))?;
                        let target = &rels.iter().find(|(r, _)| r == id)?.1;
                        let target = target.trim_start_matches('/').trim_start_matches("xl/");
                        let mut name = String::new();
                        unescape(attr(a, "name")?, &mut name);
                        Some((name, format!("xl/{target}")))
                    }
                    _ => None,
                })
                .collect()
        })
        .unwrap_or_default();
    let mut out = String::new();
    for (name, path) in listed {
        let Some(doc) = zip.read(&path) else { continue };
        out.push_str(&format!("## Sheet: {name}\n\n"));
        let mut row: Vec<String> = Vec::new();
        let (mut col, mut kind, mut value, mut in_value) = (0, String::new(), String::new(), false);
        for piece in xml(&doc) {
            match piece {
                Xml::Open("row", _) => row.clear(),
                Xml::Close("row") => {
                    let line: Vec<String> = row.iter().map(|c| csv_cell(c)).collect();
                    out.push_str(&line.join(","));
                    out.push('\n');
                }
                Xml::Open("c", a) => {
                    col = attr(a, "r").map_or(row.len(), column);
                    kind = attr(a, "t").unwrap_or_default().to_owned();
                    value.clear();
                }
                Xml::Open("v" | "t", _) => in_value = true,
                Xml::Close("v" | "t") => in_value = false,
                Xml::Text(t) if in_value => unescape(t, &mut value),
                Xml::Close("c") => {
                    let cell = match kind.as_str() {
                        "s" => value
                            .trim()
                            .parse::<usize>()
                            .ok()
                            .and_then(|i| shared.get(i))
                            .cloned()
                            .unwrap_or_default(),
                        "b" => (if value == "1" { "TRUE" } else { "FALSE" }).to_owned(),
                        _ => value.clone(),
                    };
                    // Rows hold a few thousand columns at most: one past that is a broken reference.
                    if col < 16_384 {
                        if row.len() <= col {
                            row.resize(col + 1, String::new());
                        }
                        row[col] = cell;
                    }
                }
                _ => {}
            }
            if out.len() > TEXT_MAX {
                return out;
            }
        }
        out.push('\n');
    }
    out
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::io::Write;

    /// A zip archive of `files`, each deflated, as Office writes one.
    pub(crate) fn zip(files: &[(&str, &str)]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut central = Vec::new();
        for (name, body) in files {
            let mut z =
                flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
            z.write_all(body.as_bytes()).unwrap();
            let data = z.finish().unwrap();
            let offset = out.len() as u32;
            let header = |sig: &[u8], central: bool| {
                let mut h = sig.to_vec();
                if central {
                    h.extend_from_slice(&20u16.to_le_bytes());
                }
                h.extend_from_slice(&20u16.to_le_bytes());
                h.extend_from_slice(&0u16.to_le_bytes());
                h.extend_from_slice(&8u16.to_le_bytes());
                h.extend_from_slice(&[0; 8]);
                h.extend_from_slice(&(data.len() as u32).to_le_bytes());
                h.extend_from_slice(&(body.len() as u32).to_le_bytes());
                h.extend_from_slice(&(name.len() as u16).to_le_bytes());
                h.extend_from_slice(&0u16.to_le_bytes());
                if central {
                    h.extend_from_slice(&[0; 10]);
                    h.extend_from_slice(&offset.to_le_bytes());
                }
                h.extend_from_slice(name.as_bytes());
                h
            };
            out.extend(header(b"PK\x03\x04", false));
            out.extend(&data);
            central.extend(header(b"PK\x01\x02", true));
        }
        let at = out.len() as u32;
        out.extend(&central);
        out.extend_from_slice(b"PK\x05\x06\0\0\0\0");
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(central.len() as u32).to_le_bytes());
        out.extend_from_slice(&at.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    pub(crate) fn docx(paragraphs: &[&str]) -> Vec<u8> {
        let body: String = paragraphs
            .iter()
            .map(|p| format!("<w:p><w:r><w:t xml:space=\"preserve\">{p}</w:t></w:r></w:p>"))
            .collect();
        zip(&[
            ("[Content_Types].xml", "<Types/>"),
            (
                "word/document.xml",
                &format!(
                    "<?xml version=\"1.0\"?><w:document xmlns:w=\"x\"><w:body>{body}</w:body></w:document>"
                ),
            ),
        ])
    }

    #[test]
    fn a_word_document_reads_as_its_paragraphs() {
        let file = docx(&[
            "Lease for 12 Rua Augusta",
            "Rent: &#8364;1,200 &amp; deposit",
        ]);
        assert!(AttachmentMime::Docx.fits(&file));
        assert_eq!(
            text(AttachmentMime::Docx, &file).unwrap(),
            "Lease for 12 Rua Augusta\nRent: €1,200 & deposit\n"
        );
        // Not an Office file, or one without its part: no text.
        assert_eq!(text(AttachmentMime::Docx, b"PK\x03\x04 broken"), None);
        assert_eq!(text(AttachmentMime::Xlsx, &file), None);
    }

    #[test]
    fn a_workbook_reads_as_csv_per_sheet_with_its_shared_strings() {
        let file = zip(&[
            (
                "xl/workbook.xml",
                r#"<workbook><sheets><sheet name="Q3 &amp; Q4" sheetId="1" r:id="rId1"/><sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>"#,
            ),
            (
                "xl/_rels/workbook.xml.rels",
                r#"<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>"#,
            ),
            (
                "xl/sharedStrings.xml",
                r#"<sst><si><t>Item</t></si><si><t>Amount</t></si><si><r><t>Coffee,</t></r><r><t> beans</t></r></si></sst>"#,
            ),
            (
                "xl/worksheets/sheet1.xml",
                r#"<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>12.5</v></c></row></sheetData></worksheet>"#,
            ),
            (
                "xl/worksheets/sheet2.xml",
                r#"<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Paid "late"</t></is></c><c r="B1" t="b"><v>1</v></c></row></sheetData></worksheet>"#,
            ),
        ]);
        assert_eq!(
            text(AttachmentMime::Xlsx, &file).unwrap(),
            "## Sheet: Q3 & Q4\n\nItem,Amount\n\"Coffee, beans\",,12.5\n\n## Sheet: Notes\n\n\"Paid \"\"late\"\"\",TRUE\n\n"
        );
    }

    #[test]
    fn a_deck_reads_slide_by_slide_in_order() {
        let slide = |t: &str| {
            format!("<p:sld><p:txBody><a:p><a:r><a:t>{t}</a:t></a:r></a:p></p:txBody></p:sld>")
        };
        let file = zip(&[
            ("ppt/slides/slide10.xml", &slide("Thanks")),
            ("ppt/slides/slide2.xml", &slide("Budget")),
            ("ppt/slides/slide1.xml", &slide("Trip plan")),
        ]);
        assert_eq!(
            text(AttachmentMime::Pptx, &file).unwrap(),
            "## Slide 1\n\nTrip plan\n\n## Slide 2\n\nBudget\n\n## Slide 10\n\nThanks\n\n"
        );
    }
}
