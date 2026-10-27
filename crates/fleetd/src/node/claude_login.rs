//! Claude Code's login from the app (Administration › Machines, W105). `node_action` `claude_login` starts `claude auth
//! login` on a terminal of its own, with the runner's environment so the login lands where sessions read it, and
//! answers with the sign-in URL it prints. The person signs in on their own device; the page shows a code, which
//! `claude_login_code` types into the waiting login. Claude Code keeps the token it gets in its own config here:
//! nothing of it is read or sent. One login at a time: a new one ends the last, and one nobody finishes ends after
//! 10 minutes.
use std::io::{Read, Write};
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use regex::Regex;

/// How long the login gets to print its URL.
const URL_WAIT: Duration = Duration::from_secs(30);
/// How long it gets to end once it has the code.
const CODE_WAIT: Duration = Duration::from_secs(60);
/// A login nobody finished ends after this.
const ABANDONED: Duration = Duration::from_secs(600);
/// What is kept of its output, at most.
const OUTPUT_MAX: usize = 64 * 1024;

/// The node's one login; tests make their own.
pub static LOGINS: LazyLock<Logins> = LazyLock::new(Logins::default);

#[derive(Default)]
pub struct Logins(Mutex<Option<Waiting>>);

/// A `claude auth login` waiting for its code.
struct Waiting {
    child: std::process::Child,
    /// The terminal's other end: the code is typed here.
    tty: std::fs::File,
    output: Arc<Mutex<String>>,
    /// Reads its output until its side of the terminal closes.
    reader: std::thread::JoinHandle<()>,
    started: Instant,
}

impl Waiting {
    /// Once it exited: its output read to the end, or for a second at most (a child of its own may hold the
    /// terminal open).
    async fn drained(&self) {
        for _ in 0..20 {
            if self.reader.is_finished() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    }
}

impl Drop for Waiting {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Logins {
    /// Starts `binary auth login` and answers the URL it prints; the last login, if any, ends.
    pub async fn start(&self, binary: &Path, env: &[(String, String)]) -> Result<String, String> {
        self.0.lock().unwrap().take();
        let waiting = spawn(binary, env)?;
        let output = waiting.output.clone();
        *self.0.lock().unwrap() = Some(waiting);
        let until = Instant::now() + URL_WAIT;
        loop {
            if let Some(url) = sign_in_url(&output.lock().unwrap()) {
                return Ok(url);
            }
            let exited = match self.0.lock().unwrap().as_mut() {
                Some(w) => w.child.try_wait().ok().flatten().map(|_| ()),
                None => Some(()),
            };
            if exited.is_some() || Instant::now() >= until {
                let ended = self.0.lock().unwrap().take();
                if let (Some(w), Some(())) = (&ended, exited) {
                    w.drained().await;
                }
                let said = last_words(&output.lock().unwrap());
                return Err(match exited {
                    Some(()) => format!("claude auth login ended without a sign-in URL: {said}"),
                    None => format!("claude auth login printed no sign-in URL in 30 s: {said}"),
                });
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Types `code` into the waiting login and answers its last words once it ended well. The terminal echoes the
    /// code; its words never repeat it.
    pub async fn finish(&self, code: &str) -> Result<String, String> {
        let code = code.trim();
        let said = |output: &Mutex<String>| last_words(&output.lock().unwrap().replace(code, ""));
        let output = {
            let mut slot = self.0.lock().unwrap();
            let Some(w) = slot.as_mut().filter(|w| w.started.elapsed() < ABANDONED) else {
                slot.take();
                return Err("no login is waiting for a code: start it again".into());
            };
            let typed = w
                .tty
                .write_all(format!("{code}\r").as_bytes())
                .and_then(|()| w.tty.flush());
            if let Err(e) = typed {
                slot.take();
                return Err(format!("couldn't give the login its code: {e}"));
            }
            w.output.clone()
        };
        let until = Instant::now() + CODE_WAIT;
        loop {
            let status = match self.0.lock().unwrap().as_mut() {
                Some(w) => w.child.try_wait().ok().flatten(),
                None => return Err("the login was replaced by a new one".into()),
            };
            if let Some(status) = status {
                let ended = self.0.lock().unwrap().take();
                if let Some(w) = &ended {
                    w.drained().await;
                }
                return if status.success() {
                    Ok(said(&output))
                } else {
                    Err(format!("claude auth login failed: {}", said(&output)))
                };
            }
            if Instant::now() >= until {
                self.0.lock().unwrap().take();
                return Err(format!(
                    "claude auth login didn't end within a minute of its code: {}",
                    said(&output)
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

/// `binary auth login` on a terminal wide enough that its URL is one line, with no browser to open here: the person
/// signs in on their own device.
fn spawn(binary: &Path, env: &[(String, String)]) -> Result<Waiting, String> {
    let size = nix::pty::Winsize {
        ws_row: 40,
        ws_col: 2000,
        ws_xpixel: 0,
        ws_ypixel: 0,
    };
    let pty =
        nix::pty::openpty(&size, None).map_err(|e| format!("no terminal for the login: {e}"))?;
    let tty = std::fs::File::from(pty.master);
    let side = std::fs::File::from(pty.slave);
    let io = || side.try_clone().map(std::process::Stdio::from);
    let child = std::process::Command::new(binary)
        .args(["auth", "login"])
        .env_clear()
        .envs(env.iter().map(|(k, v)| (k, v)))
        .env("BROWSER", "true")
        .env("TERM", "dumb")
        .env("NO_COLOR", "1")
        .stdin(io().map_err(|e| e.to_string())?)
        .stdout(io().map_err(|e| e.to_string())?)
        .stderr(io().map_err(|e| e.to_string())?)
        .spawn()
        .map_err(|e| format!("couldn't start {} auth login: {e}", binary.display()))?;
    drop(side);
    let output = Arc::new(Mutex::new(String::new()));
    let mut reader = tty.try_clone().map_err(|e| e.to_string())?;
    let into = output.clone();
    let reader = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        // Ends when the login has exited and its side of the terminal is closed.
        while let Ok(n) = reader.read(&mut buf) {
            if n == 0 {
                break;
            }
            let mut out = into.lock().unwrap();
            if out.len() < OUTPUT_MAX {
                out.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
        }
    });
    Ok(Waiting {
        child,
        tty,
        output,
        reader,
        started: Instant::now(),
    })
}

/// A terminal's colour and cursor sequences.
static CSI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").expect("csi"));
static URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"https://[^\s\x07\x1b"'<>]+"#).expect("url"));

/// The URL to sign in at: the first that names OAuth, else the first.
pub fn sign_in_url(output: &str) -> Option<String> {
    let text = CSI.replace_all(output, "");
    let urls: Vec<&str> = URL.find_iter(&text).map(|m| m.as_str()).collect();
    urls.iter()
        .find(|u| u.contains("oauth"))
        .or(urls.first())
        .map(|u| (*u).to_owned())
}

/// Its last line with words, without terminal sequences: what it said as it ended.
pub fn last_words(output: &str) -> String {
    let text = CSI.replace_all(output, "");
    text.lines()
        .map(|l| l.trim_matches(|c: char| c.is_whitespace() || c.is_control()))
        .rfind(|l| !l.is_empty())
        .unwrap_or("it printed nothing")
        .chars()
        .take(300)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_the_oauth_url_among_the_terminal_sequences() {
        let out = "\x1b[2K\x1b[1GOpening https://claude.ai in your browser\r\n\x1b[33mBrowser didn't open? Use the url below to sign in:\x1b[39m\r\n\r\nhttps://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz\r\n\r\nPaste code here if prompted > ";
        assert_eq!(
            sign_in_url(out).as_deref(),
            Some("https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz")
        );
        assert_eq!(sign_in_url("Logging in…"), None);
        assert_eq!(last_words(out), "Paste code here if prompted >");
        assert_eq!(last_words(""), "it printed nothing");
    }

    /// A pretend claude: prints its URL, reads the code from its terminal, and logs in only with the right one.
    fn fake_claude(dir: &Path) -> std::path::PathBuf {
        let bin = dir.join("claude");
        std::fs::write(
            &bin,
            "#!/bin/sh\n[ \"$1 $2\" = 'auth login' ] || exit 2\n[ -t 0 ] || { echo 'not a terminal'; exit 3; }\n\
             echo 'Visit https://claude.ai/oauth/authorize?state=s1 to sign in'\nprintf 'Paste code here > '\n\
             read code\n[ \"$code\" = 'abc#s1' ] && echo 'Login successful.' && exit 0\necho 'Invalid code'; exit 1\n",
        )
        .unwrap();
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&bin, std::fs::Permissions::from_mode(0o755)).unwrap();
        bin
    }

    fn env() -> Vec<(String, String)> {
        vec![("PATH".into(), "/usr/bin:/bin".into())]
    }

    #[tokio::test]
    async fn a_login_answers_its_url_on_a_terminal_then_takes_the_code() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_claude(dir.path());
        let logins = Logins::default();
        let url = logins.start(&bin, &env()).await.unwrap();
        assert_eq!(url, "https://claude.ai/oauth/authorize?state=s1");
        assert_eq!(
            logins.finish(" abc#s1\n").await.unwrap(),
            "Login successful."
        );
        // Used up: a second code has nothing to go to.
        assert!(
            logins
                .finish("abc#s1")
                .await
                .unwrap_err()
                .starts_with("no login is waiting")
        );
    }

    #[tokio::test]
    async fn a_wrong_code_says_what_claude_said() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_claude(dir.path());
        let logins = Logins::default();
        logins.start(&bin, &env()).await.unwrap();
        let e = logins.finish("nope").await.unwrap_err();
        assert_eq!(e, "claude auth login failed: Invalid code");
    }

    #[tokio::test]
    async fn a_login_without_claude_says_so() {
        let e = Logins::default()
            .start(Path::new("/nonexistent/claude"), &env())
            .await
            .unwrap_err();
        assert!(
            e.starts_with("couldn't start /nonexistent/claude auth login"),
            "{e}"
        );
    }
}
