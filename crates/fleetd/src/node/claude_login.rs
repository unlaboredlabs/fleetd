//! Claude Code's login from the app (Settings › Hub › Machines, W105). `node_action` `claude_login` starts `claude auth
//! login` on a terminal of its own, with the runner's environment so the login lands where sessions read it, and
//! answers with the sign-in URL it prints. The person signs in on their own device; the page shows a code, which
//! `claude_login_code` types into the waiting login. Claude Code keeps the token it gets in its own config here:
//! nothing of it is read or sent. One login at a time: a new one ends the last, and one nobody finishes ends after
//! 10 minutes.
use std::io::{Read, Write};
use std::os::fd::AsFd;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
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
/// Between the code and its Enter, as a person types them: a terminal app in raw mode (Ink) takes one write holding
/// both as pasted text, Enter and all, and never submits it.
const ENTER_AFTER: Duration = Duration::from_millis(300);
/// How often the reader looks up from the terminal to see whether the login has ended.
const READ_POLL_MS: u16 = 200;

/// The node's one login; tests make their own.
pub static LOGINS: LazyLock<Logins> = LazyLock::new(Logins::default);

pub struct Logins {
    slot: Mutex<Option<Waiting>>,
    code_wait: Duration,
}

impl Default for Logins {
    fn default() -> Self {
        Self {
            slot: Mutex::default(),
            code_wait: CODE_WAIT,
        }
    }
}

/// A `claude auth login` waiting for its code.
struct Waiting {
    /// None once it is ended and handed to its reaper.
    child: Option<std::process::Child>,
    /// The terminal's other end: the code is typed here.
    tty: std::fs::File,
    output: Arc<Mutex<String>>,
    /// Set as the login ends: the reader stops within a poll's wait, even while a child of claude's holds the
    /// terminal open.
    stop: Arc<AtomicBool>,
    /// Reads its output until its side of the terminal closes, or `stop`.
    reader: std::thread::JoinHandle<()>,
    started: Instant,
}

impl Waiting {
    fn exited(&mut self) -> Option<std::process::ExitStatus> {
        self.child.as_mut()?.try_wait().ok().flatten()
    }

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

/// Ends it without waiting on whoever drops it (an async task, often under the lock): its whole process group is
/// killed, claude and whatever it started, even once claude itself has exited, and claude is reaped on a thread of its
/// own. The group's id can't be another's while anything is left in it, and a login is dropped moments after claude
/// is seen to exit, far too soon for its id to come round again.
impl Drop for Waiting {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        let Some(mut child) = self.child.take() else {
            return;
        };
        if let Ok(pid) = i32::try_from(child.id()) {
            let _ = nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(pid),
                nix::sys::signal::Signal::SIGKILL,
            );
        }
        if matches!(child.try_wait(), Ok(None)) {
            let _ = child.kill();
        }
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

impl Logins {
    #[cfg(test)]
    fn with_code_wait(code_wait: Duration) -> Self {
        Self {
            slot: Mutex::default(),
            code_wait,
        }
    }

    /// Takes the login out of its slot, to drop it outside the lock.
    fn take(&self) -> Option<Waiting> {
        self.slot.lock().unwrap().take()
    }

    /// Starts `binary auth login` and answers the URL it prints; the last login, if any, ends.
    pub async fn start(&self, binary: &Path, env: &[(String, String)]) -> Result<String, String> {
        drop(self.take());
        let waiting = spawn(binary, env)?;
        let output = waiting.output.clone();
        *self.slot.lock().unwrap() = Some(waiting);
        let until = Instant::now() + URL_WAIT;
        loop {
            if let Some(url) = sign_in_url(&output.lock().unwrap()) {
                return Ok(url);
            }
            let exited = match self.slot.lock().unwrap().as_mut() {
                Some(w) => w.exited().map(|_| ()),
                None => Some(()),
            };
            if exited.is_some() || Instant::now() >= until {
                let ended = self.take();
                if let (Some(w), Some(())) = (&ended, exited) {
                    w.drained().await;
                }
                drop(ended);
                let said = last_words(&output.lock().unwrap());
                return Err(match exited {
                    Some(()) => format!("claude auth login ended without a sign-in URL: {said}"),
                    None => format!("claude auth login printed no sign-in URL in 30 s: {said}"),
                });
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }

    /// Types `code` into the waiting login, then Enter a moment later, and answers its last words once it ended well.
    /// The terminal may echo the code; its words never repeat it.
    pub async fn finish(&self, code: &str) -> Result<String, String> {
        let code = code.trim();
        let said = |output: &Mutex<String>| last_words(&output.lock().unwrap().replace(code, ""));
        let (mut tty, output) = {
            let mut slot = self.slot.lock().unwrap();
            let waiting = slot
                .as_ref()
                .filter(|w| w.started.elapsed() < ABANDONED)
                .map(|w| (w.tty.try_clone(), w.output.clone()));
            match waiting {
                Some((Ok(tty), output)) => (tty, output),
                Some((Err(e), _)) => {
                    let ended = slot.take();
                    drop(slot);
                    drop(ended);
                    return Err(format!("couldn't give the login its code: {e}"));
                }
                None => {
                    let ended = slot.take();
                    drop(slot);
                    drop(ended);
                    return Err("no login is waiting for a code: start it again".into());
                }
            }
        };
        let typed = match tty.write_all(code.as_bytes()).and_then(|()| tty.flush()) {
            Ok(()) => {
                tokio::time::sleep(ENTER_AFTER).await;
                tty.write_all(b"\r").and_then(|()| tty.flush())
            }
            Err(e) => Err(e),
        };
        if let Err(e) = typed {
            drop(self.take());
            return Err(format!("couldn't give the login its code: {e}"));
        }
        let until = Instant::now() + self.code_wait;
        loop {
            let status = match self.slot.lock().unwrap().as_mut() {
                Some(w) => w.exited(),
                None => return Err("the login was replaced by a new one".into()),
            };
            if let Some(status) = status {
                let ended = self.take();
                if let Some(w) = &ended {
                    w.drained().await;
                }
                drop(ended);
                return if status.success() {
                    Ok(said(&output))
                } else {
                    Err(format!("claude auth login failed: {}", said(&output)))
                };
            }
            if Instant::now() >= until {
                drop(self.take());
                return Err(format!(
                    "claude auth login didn't end within {} s of its code: {}",
                    self.code_wait.as_secs(),
                    said(&output)
                ));
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    }
}

/// `binary auth login` on a terminal wide enough that its URL is one line, with no browser to open here: the person
/// signs in on their own device. It leads a process group of its own, so ending it ends what it started.
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
        .process_group(0)
        .stdin(io().map_err(|e| e.to_string())?)
        .stdout(io().map_err(|e| e.to_string())?)
        .stderr(io().map_err(|e| e.to_string())?)
        .spawn()
        .map_err(|e| format!("couldn't start {} auth login: {e}", binary.display()))?;
    drop(side);
    let output = Arc::new(Mutex::new(String::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let mut reader = tty.try_clone().map_err(|e| e.to_string())?;
    let (into, stopped) = (output.clone(), stop.clone());
    let reader = std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        // Ends when the login's side of the terminal is closed, or once it is told to stop.
        while !stopped.load(Ordering::Relaxed) {
            let mut fds = [nix::poll::PollFd::new(
                reader.as_fd(),
                nix::poll::PollFlags::POLLIN,
            )];
            match nix::poll::poll(&mut fds, READ_POLL_MS) {
                Ok(0) | Err(nix::errno::Errno::EINTR) => continue,
                Err(_) => break,
                Ok(_) => {}
            }
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    let mut out = into.lock().unwrap();
                    if out.len() < OUTPUT_MAX {
                        out.push_str(&String::from_utf8_lossy(&buf[..n]));
                    }
                }
            }
        }
    });
    Ok(Waiting {
        child: Some(child),
        tty,
        output,
        stop,
        reader,
        started: Instant::now(),
    })
}

/// A terminal's colour and cursor sequences.
static CSI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\x1b\[[0-9;?]*[ -/]*[@-~]").expect("csi"));
static URL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"https://[^\s\x07\x1b"'<>]+"#).expect("url"));

/// The URL to sign in at: the first that names OAuth, else the first. Only a whole one, with something after it: the
/// output comes in as the terminal gives it, and its last read may have cut a URL short.
pub fn sign_in_url(output: &str) -> Option<String> {
    let text = CSI.replace_all(output, "");
    let urls: Vec<&str> = URL
        .find_iter(&text)
        .filter(|m| m.end() < text.len())
        .map(|m| m.as_str())
        .collect();
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

    #[test]
    fn takes_no_url_a_read_may_have_cut_short() {
        assert_eq!(sign_in_url("Visit https://claude.ai/oauth/author"), None);
        assert_eq!(
            sign_in_url("Visit https://claude.ai/oauth/authorize?state=s1\r\n").as_deref(),
            Some("https://claude.ai/oauth/authorize?state=s1")
        );
    }

    /// A pretend claude that reads its terminal raw, as Claude Code's Ink does: it prints its URL, takes a read that
    /// is Enter alone as Enter, and one with more in it as pasted text, its Enter included, which submits nothing. It
    /// logs in only with the right code. `before` runs first (a child of its own, say).
    fn fake_claude(dir: &Path, before: &str) -> std::path::PathBuf {
        let bin = dir.join("claude");
        std::fs::write(
            &bin,
            format!(
                "#!/bin/sh\n[ \"$1 $2\" = 'auth login' ] || exit 2\n[ -t 0 ] || {{ echo 'not a terminal'; exit 3; }}\n{before}\n\
                 stty raw -echo\nprintf 'Visit https://claude.ai/oauth/authorize?state=s1 to sign in\\r\\nPaste code here > '\n\
                 code=''\nwhile :; do\n  chunk=$(dd bs=256 count=1 2>/dev/null | od -An -tx1 | tr -d ' \\n')\n\
                 [ -n \"$chunk\" ] || exit 4\n  [ \"$chunk\" = 0d ] && break\n  code=\"$code$chunk\"\ndone\n\
                 [ \"$code\" = 616263237331 ] && printf '\\r\\nLogin successful.\\r\\n' && exit 0\nprintf '\\r\\nInvalid code\\r\\n'; exit 1\n"
            ),
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
        let bin = fake_claude(dir.path(), "");
        // A code typed with its Enter in one write would be pasted text: the login would never end.
        let logins = Logins::with_code_wait(Duration::from_secs(5));
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
        let bin = fake_claude(dir.path(), "");
        let logins = Logins::with_code_wait(Duration::from_secs(5));
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

    /// claude may start a child that holds the terminal open: ending the login neither waits for it nor leaves the
    /// reader behind.
    #[tokio::test]
    async fn an_ended_login_leaves_no_reader_or_wait_behind() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_claude(dir.path(), "sleep 30 &");
        let waiting = spawn(&bin, &env()).unwrap();
        let output = waiting.output.clone();
        for _ in 0..50 {
            if sign_in_url(&output.lock().unwrap()).is_some() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        let at = Instant::now();
        drop(waiting);
        assert!(
            at.elapsed() < Duration::from_millis(200),
            "{:?}",
            at.elapsed()
        );
        // The reader holds the output while it runs.
        for _ in 0..30 {
            if Arc::strong_count(&output) == 1 {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("the reader is still running");
    }

    /// Gone, or a zombie its new parent hasn't reaped yet.
    fn gone(pid: i32) -> bool {
        let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).unwrap_or_default();
        nix::sys::signal::kill(nix::unistd::Pid::from_raw(pid), None).is_err()
            || stat
                .split(") ")
                .nth(1)
                .is_some_and(|rest| rest.starts_with('Z'))
    }

    /// claude may leave a child of its own running as it exits: ending the login ends that too.
    #[tokio::test]
    async fn a_login_that_ended_leaves_nothing_it_started_running() {
        let dir = tempfile::tempdir().unwrap();
        let pid_file = dir.path().join("child.pid");
        let bin = fake_claude(
            dir.path(),
            &format!("sleep 30 & echo $! > '{}'", pid_file.display()),
        );
        let logins = Logins::with_code_wait(Duration::from_secs(5));
        logins.start(&bin, &env()).await.unwrap();
        let child: i32 = std::fs::read_to_string(&pid_file)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        assert!(
            !gone(child),
            "the stand-in's child should run until the login ends"
        );
        // claude exits once it has the code; its child would go on.
        assert_eq!(logins.finish("abc#s1").await.unwrap(), "Login successful.");
        for _ in 0..30 {
            if gone(child) {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("claude's child {child} is still running");
    }
}
