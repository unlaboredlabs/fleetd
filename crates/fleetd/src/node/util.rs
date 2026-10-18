//! Small helpers shared by the node's modules: the scrubbed child environment, errno names as Node prints them,
//! UTF-16 length rules the contracts check, and ISO timestamps.
use std::path::PathBuf;

/// Children get only these variables, so the `CLAUDE*` ones of whatever started the node never leak into T3.
pub fn scrubbed_env() -> Vec<(String, String)> {
    ["HOME", "PATH", "USER", "LANG"]
        .into_iter()
        .filter_map(|key| std::env::var(key).ok().map(|value| (key.to_owned(), value)))
        .collect()
}

pub fn home_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/"))
}

/// `new Date().toISOString()`.
pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}

/// The errno name Node puts in `error.code` (`ENOENT`, `EACCES`, ...).
pub fn errno_name(error: &std::io::Error) -> Option<String> {
    let errno = nix::errno::Errno::from_raw(error.raw_os_error()?);
    (errno != nix::errno::Errno::UnknownErrno).then(|| format!("{errno:?}"))
}

/// The last `max` UTF-16 code units of `text` (JS `slice(-max)`), never splitting a character.
pub fn tail_utf16(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices().rev() {
        units += ch.len_utf16();
        if units > max {
            return &text[index + ch.len_utf8()..];
        }
    }
    text
}

/// The first `max` UTF-16 code units of `text` (JS `slice(0, max)`), never splitting a character.
pub fn head_utf16(text: &str, max: usize) -> &str {
    let mut units = 0;
    for (index, ch) in text.char_indices() {
        units += ch.len_utf16();
        if units > max {
            return &text[..index];
        }
    }
    text
}

/// Decodes one output stream chunk by chunk like Node's `setEncoding("utf8")`: a character split across chunks is
/// held back until it completes, invalid bytes become U+FFFD.
#[derive(Default)]
pub struct Utf8Stream {
    pending: Vec<u8>,
}

impl Utf8Stream {
    pub fn push(&mut self, chunk: &[u8]) -> String {
        self.pending.extend_from_slice(chunk);
        let mut out = String::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    out.push_str(text);
                    self.pending.clear();
                    return out;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    out.push_str(std::str::from_utf8(&self.pending[..valid]).unwrap_or_default());
                    match error.error_len() {
                        None => {
                            self.pending.drain(..valid);
                            return out;
                        }
                        Some(bad) => {
                            out.push('\u{FFFD}');
                            self.pending.drain(..valid + bad);
                        }
                    }
                }
            }
        }
    }

    pub fn finish(&mut self) -> String {
        let rest = String::from_utf8_lossy(&self.pending).into_owned();
        self.pending.clear();
        rest
    }
}

/// Aborts the task when dropped, so a task lives exactly as long as whatever holds it.
pub struct AbortOnDrop(pub tokio::task::JoinHandle<()>);

impl Drop for AbortOnDrop {
    fn drop(&mut self) {
        self.0.abort();
    }
}
