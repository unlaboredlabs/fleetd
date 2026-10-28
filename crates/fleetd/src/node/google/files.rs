//! The files a Navi's email attaches: each from its own folder only (D188). A path is resolved inside the folder, and
//! one that leads out of it (`..`, an absolute path elsewhere, a link to a file outside) is refused, as is anything but
//! a regular file. The node reads them twice: for the approval card (`GoogleCall::MailFiles`), which lists each by name,
//! size and type and pins its SHA-256 in the approved input; and when the tool runs, which sends a file only while it
//! still has those bytes. Together they may hold at most Gmail's 25 MB.
use std::io::Read;
use std::path::{Path, PathBuf};

use fleetd_contracts::google::{MAIL_FILES_MAX, MAIL_FILES_MAX_BYTES, MailFile};
use sha2::{Digest, Sha256};

/// A file read whole for an email.
pub struct File {
    pub name: String,
    pub mime: &'static str,
    pub bytes: Vec<u8>,
    pub sha256: String,
}

/// "25 MB", "1.2 MB", "800 KB".
fn mb(bytes: u64) -> String {
    if bytes >= 1_000_000 {
        format!("{:.1} MB", bytes as f64 / 1_000_000.0)
    } else {
        format!("{} KB", bytes.div_ceil(1000))
    }
}

fn too_large(total: u64) -> String {
    format!(
        "These files add up to {}, and Gmail sends at most {} MB of attachments in one email. Attach fewer or \
         smaller files, or send them in several emails.",
        mb(total),
        MAIL_FILES_MAX_BYTES / 1_000_000
    )
}

/// `path` inside `folder`, through any link, or why it can't be attached.
pub fn resolve(folder: &Path, path: &str) -> Result<PathBuf, String> {
    if path.trim().is_empty() || path.contains('\0') {
        return Err("an attachment's path is empty".into());
    }
    let root = folder
        .canonicalize()
        .map_err(|e| format!("the Navi's folder can't be read: {e}"))?;
    let real = root
        .join(path)
        .canonicalize()
        .map_err(|_| format!("{path}: there's no such file in your folder"))?;
    if !real.starts_with(&root) {
        return Err(format!(
            "{path} is outside your folder, or a link out of it: a Navi attaches only files in its own folder"
        ));
    }
    if !real.is_file() {
        return Err(format!("{path} isn't a file"));
    }
    Ok(real)
}

/// The type an email names a file by, from its name; `application/octet-stream` for one it doesn't know.
pub fn mime_of(name: &str) -> &'static str {
    let ext = name
        .rsplit_once('.')
        .map(|(_, e)| e.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "pdf" => "application/pdf",
        "txt" | "log" => "text/plain",
        "md" | "markdown" => "text/markdown",
        "csv" => "text/csv",
        "tsv" => "text/tab-separated-values",
        "html" | "htm" => "text/html",
        "ics" => "text/calendar",
        "vcf" => "text/vcard",
        "json" => "application/json",
        "xml" => "application/xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "heic" => "image/heic",
        "zip" => "application/zip",
        "gz" => "application/gzip",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ods" => "application/vnd.oasis.opendocument.spreadsheet",
        "rtf" => "application/rtf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "m4a" => "audio/mp4",
        "mp4" => "video/mp4",
        "mov" => "video/quicktime",
        "eml" => "message/rfc822",
        _ => "application/octet-stream",
    }
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// One file, read whole: no more than `left` bytes, what the email still has room for.
fn read_one(folder: &Path, path: &str, left: u64, total: u64) -> Result<File, String> {
    let real = resolve(folder, path)?;
    let file = std::fs::File::open(&real).map_err(|e| format!("{path} can't be read: {e}"))?;
    let mut bytes = Vec::new();
    // One byte past the room left tells a file grown too large without reading all of it.
    file.take(left + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| format!("{path} can't be read: {e}"))?;
    if bytes.len() as u64 > left {
        let size = std::fs::metadata(&real).map_or(bytes.len() as u64, |m| m.len());
        return Err(too_large(total + size));
    }
    // The name the Navi gave it, not where a link inside the folder leads.
    let name = Path::new(path)
        .file_name()
        .or_else(|| real.file_name())
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "file".into());
    Ok(File {
        mime: mime_of(&name),
        sha256: sha256_hex(&bytes),
        name,
        bytes,
    })
}

/// Every file an email attaches, in order, or why one can't be: outside the folder, missing, or past Gmail's size.
pub fn read_all(folder: &Path, paths: &[&str]) -> Result<Vec<File>, String> {
    if paths.len() > MAIL_FILES_MAX {
        return Err(format!(
            "An email attaches at most {MAIL_FILES_MAX} files: zip them, or send several emails."
        ));
    }
    let mut files = Vec::new();
    let mut total = 0;
    for path in paths {
        let f = read_one(folder, path, MAIL_FILES_MAX_BYTES - total, total)?;
        total += f.bytes.len() as u64;
        files.push(f);
    }
    Ok(files)
}

/// `GoogleCall::MailFiles`: each file as its approval card lists it, and the hash that pins it.
pub fn inspect(folder: &Path, paths: &[String]) -> Result<Vec<MailFile>, String> {
    let paths: Vec<&str> = paths.iter().map(String::as_str).collect();
    Ok(read_all(folder, &paths)?
        .into_iter()
        .zip(&paths)
        .map(|(f, path)| MailFile {
            path: (*path).to_owned(),
            credential: crate::hub::integrations::policy::file_holds_credential(&f.bytes),
            bytes: f.bytes.len() as u64,
            mime: f.mime.to_owned(),
            name: f.name,
            sha256: f.sha256,
        })
        .collect())
}
