//! Whether the node's own GUI session is the one on the Mac's screen, unlocked: the only state in which macOS gives a
//! session's ScreenCaptureKit frames and takes its CGEvents. A session switched to the background (Fast User
//! Switching) or locked gets black frames and has its input dropped, so a Mac screen starts only while this holds,
//! checked at every start.
//!
//! macOS says it in the IORegistry's root (`ioreg -n Root -d1 -a`, a property list): `IOConsoleUsers` lists each
//! logged-in session with its uid, `kCGSSessionOnConsoleKey` while it is the one on the screen, and
//! `CGSSessionScreenIsLocked` while its screen is locked.

/// One logged-in GUI session, as the IORegistry lists it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConsoleUser {
    pub uid: u32,
    pub name: String,
    pub on_console: bool,
    pub locked: bool,
}

/// Where the node's own session is.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Console {
    /// On the screen, unlocked: frames and input work.
    OnScreen,
    /// On the screen, locked.
    Locked,
    /// Logged in, but another session has the screen (`who`, when one does, else the login window).
    Background { who: Option<String> },
    /// Not logged in at all: the node runs without a GUI session.
    NotLoggedIn,
}

impl Console {
    /// Why a Mac screen can't start, and what a person does about it, in plain words; None while it can.
    pub fn blocked(&self, user: &str) -> Option<String> {
        match self {
            Self::OnScreen => None,
            Self::Locked => Some(format!(
                "the Mac's screen is locked: unlock it at the Mac as {user}, and turn the screen lock off for {user} \
                 (System Settings › Lock Screen › Require password: Never), since a locked screen gives black frames"
            )),
            Self::Background { who: Some(who) } => Some(format!(
                "{who} has the Mac's screen, and {user}'s session runs in the background, which gets black frames and \
                 no input: switch the Mac's screen to {user} (a Mac set aside for agents keeps {user} on it)"
            )),
            Self::Background { who: None } => Some(format!(
                "the Mac shows its login window, and {user}'s session runs in the background: log in as {user} at the \
                 Mac"
            )),
            Self::NotLoggedIn => Some(format!(
                "{user} isn't logged in to the Mac's screen: log in as {user} at the Mac, and keep that session on \
                 the screen"
            )),
        }
    }
}

/// Where session `uid` is among `users`.
pub fn state(uid: u32, users: &[ConsoleUser]) -> Console {
    let Some(me) = users.iter().find(|u| u.uid == uid) else {
        return Console::NotLoggedIn;
    };
    match (me.on_console, me.locked) {
        (true, false) => Console::OnScreen,
        (true, true) => Console::Locked,
        (false, _) => Console::Background {
            who: users
                .iter()
                .find(|u| u.on_console && u.uid != uid)
                .map(|u| u.name.clone()),
        },
    }
}

/// The sessions in `ioreg -n Root -d1 -a`'s output.
pub fn parse(xml: &str) -> Result<Vec<ConsoleUser>, String> {
    let mut tokens = Tokens::new(xml);
    let root = loop {
        match tokens.next() {
            Some(Token::Open(tag)) if tag == "dict" || tag == "array" => {
                break value_after(&mut tokens, Token::Open(tag))?;
            }
            Some(_) => {}
            None => return Err("ioreg printed no property list".into()),
        }
    };
    let root = match root {
        // `-d1` prints the root entry itself, or an array of it.
        Value::Array(items) => items.into_iter().next().unwrap_or(Value::Other),
        other => other,
    };
    let Some(Value::Array(users)) = root.get("IOConsoleUsers") else {
        // No one logged in to a GUI session (or a Mac still at its login window after a restart).
        return Ok(Vec::new());
    };
    Ok(users
        .iter()
        .filter_map(|user| {
            Some(ConsoleUser {
                uid: match user.get("kCGSSessionUserIDKey")? {
                    Value::Int(n) => u32::try_from(*n).ok()?,
                    _ => return None,
                },
                name: match user.get("kCGSSessionUserNameKey") {
                    Some(Value::Str(name)) => name.clone(),
                    _ => String::new(),
                },
                on_console: matches!(user.get("kCGSSessionOnConsoleKey"), Some(Value::Bool(true))),
                locked: matches!(
                    user.get("CGSSessionScreenIsLocked"),
                    Some(Value::Bool(true))
                ),
            })
        })
        .collect())
}

/// Reads the IORegistry now (blocking, tens of milliseconds).
#[cfg(target_os = "macos")]
pub fn read() -> Result<Vec<ConsoleUser>, String> {
    let out = std::process::Command::new("/usr/sbin/ioreg")
        .args(["-n", "Root", "-d1", "-a"])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("cannot run ioreg: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ioreg failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    parse(&String::from_utf8_lossy(&out.stdout))
}

/// A property list value, as much of one as the console's state needs.
#[derive(Debug)]
enum Value {
    Dict(Vec<(String, Value)>),
    Array(Vec<Value>),
    Str(String),
    Int(i64),
    Bool(bool),
    Other,
}

impl Value {
    fn get(&self, key: &str) -> Option<&Value> {
        match self {
            Self::Dict(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq)]
enum Token {
    Open(String),
    Close(String),
    /// `<true/>`, `<false/>`, `<dict/>`, ...
    Empty(String),
    Text(String),
}

struct Tokens<'a> {
    rest: &'a str,
}

impl<'a> Tokens<'a> {
    fn new(xml: &'a str) -> Self {
        Self { rest: xml }
    }
}

impl Iterator for Tokens<'_> {
    type Item = Token;

    fn next(&mut self) -> Option<Token> {
        loop {
            if self.rest.is_empty() {
                return None;
            }
            if let Some(after) = self.rest.strip_prefix('<') {
                let end = after.find('>')?;
                let tag = &after[..end];
                self.rest = &after[end + 1..];
                // The XML declaration, the doctype and comments.
                if tag.starts_with('?') || tag.starts_with('!') {
                    continue;
                }
                let name = |t: &str| {
                    t.split_whitespace()
                        .next()
                        .unwrap_or_default()
                        .trim_end_matches('/')
                        .to_owned()
                };
                return Some(if let Some(closing) = tag.strip_prefix('/') {
                    Token::Close(name(closing))
                } else if tag.ends_with('/') {
                    Token::Empty(name(tag))
                } else {
                    Token::Open(name(tag))
                });
            }
            let end = self.rest.find('<').unwrap_or(self.rest.len());
            let text = &self.rest[..end];
            self.rest = &self.rest[end..];
            if !text.trim().is_empty() {
                return Some(Token::Text(unescape(text)));
            }
        }
    }
}

fn unescape(text: &str) -> String {
    text.replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// The value that `first` opens, up to its closing tag.
fn value_after(tokens: &mut Tokens<'_>, first: Token) -> Result<Value, String> {
    match first {
        Token::Empty(tag) => Ok(match tag.as_str() {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            "dict" => Value::Dict(Vec::new()),
            "array" => Value::Array(Vec::new()),
            "string" => Value::Str(String::new()),
            _ => Value::Other,
        }),
        Token::Open(tag) => match tag.as_str() {
            "dict" => {
                let mut entries = Vec::new();
                loop {
                    match tokens.next() {
                        Some(Token::Close(t)) if t == "dict" => return Ok(Value::Dict(entries)),
                        Some(Token::Open(t)) if t == "key" => {
                            let key = text_until(tokens, "key")?;
                            let next = tokens.next().ok_or("a key with no value")?;
                            entries.push((key, value_after(tokens, next)?));
                        }
                        Some(other) => return Err(format!("unexpected {other:?} in a dict")),
                        None => return Err("a dict that doesn't end".into()),
                    }
                }
            }
            "array" => {
                let mut items = Vec::new();
                loop {
                    match tokens.next() {
                        Some(Token::Close(t)) if t == "array" => return Ok(Value::Array(items)),
                        Some(next) => items.push(value_after(tokens, next)?),
                        None => return Err("an array that doesn't end".into()),
                    }
                }
            }
            "string" => Ok(Value::Str(text_until(tokens, "string")?)),
            "integer" => {
                let text = text_until(tokens, "integer")?;
                Ok(text.trim().parse().map(Value::Int).unwrap_or(Value::Other))
            }
            other => {
                text_until(tokens, other)?;
                Ok(Value::Other)
            }
        },
        other => Err(format!("unexpected {other:?}")),
    }
}

/// The text inside an element whose opening tag was just read, through its closing tag.
fn text_until(tokens: &mut Tokens<'_>, tag: &str) -> Result<String, String> {
    let mut text = String::new();
    loop {
        match tokens.next() {
            Some(Token::Close(t)) if t == tag => return Ok(text),
            Some(Token::Text(t)) => text.push_str(&t),
            Some(other) => return Err(format!("unexpected {other:?} in <{tag}>")),
            None => return Err(format!("<{tag}> doesn't end")),
        }
    }
}
