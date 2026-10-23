//! Node's `util.parseArgs` in strict mode, which older releases of the CLI used everywhere: the same tokens, the same
//! errors in the same words, so scripts and leads written against them see no difference. clap would change both.

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Str,
    Bool,
    /// A string option that may repeat (`--step`, `--secret-env`).
    Multi,
}

pub struct Spec<'a> {
    pub options: &'a [(&'a str, Kind)],
    pub positionals: bool,
}

#[derive(Debug, Clone)]
enum Value {
    Str(String),
    Bool,
    Multi(Vec<String>),
}

#[derive(Debug, Default)]
pub struct Parsed {
    /// In the order each option was first given, as `Object.keys(values)` lists them.
    values: Vec<(String, Value)>,
    pub positionals: Vec<String>,
}

impl Parsed {
    pub fn str(&self, name: &str) -> Option<&str> {
        self.values
            .iter()
            .find(|(key, _)| key == name)
            .and_then(|(_, value)| match value {
                Value::Str(s) => Some(s.as_str()),
                _ => None,
            })
    }
    pub fn string(&self, name: &str) -> Option<String> {
        self.str(name).map(str::to_owned)
    }
    pub fn flag(&self, name: &str) -> bool {
        self.values
            .iter()
            .any(|(key, value)| key == name && matches!(value, Value::Bool))
    }
    pub fn multi(&self, name: &str) -> Vec<String> {
        self.values
            .iter()
            .find_map(|(key, value)| match value {
                Value::Multi(items) if key == name => Some(items.clone()),
                _ => None,
            })
            .unwrap_or_default()
    }
    pub fn keys(&self) -> impl Iterator<Item = &str> {
        self.values.iter().map(|(key, _)| key.as_str())
    }
    fn set(&mut self, name: &str, value: Value) {
        if let Some(slot) = self.values.iter_mut().find(|(key, _)| key == name) {
            match (&mut slot.1, value) {
                (Value::Multi(items), Value::Multi(more)) => items.extend(more),
                (old, new) => *old = new,
            }
        } else {
            self.values.push((name.to_owned(), value));
        }
    }
}

pub fn parse(args: &[String], spec: &Spec) -> Result<Parsed, String> {
    let kind = |name: &str| {
        spec.options
            .iter()
            .find(|(key, _)| *key == name)
            .map(|(_, kind)| *kind)
    };
    let unknown = |raw: &str| {
        if spec.positionals {
            // Node's message really does lack the closing quote.
            format!(
                "Unknown option '{raw}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"{raw}\""
            )
        } else {
            format!("Unknown option '{raw}'")
        }
    };
    let mut parsed = Parsed::default();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        index += 1;
        if arg == "--" {
            if !spec.positionals
                && let Some(first) = args.get(index)
            {
                return Err(unexpected(first));
            }
            parsed.positionals.extend(args[index..].iter().cloned());
            break;
        }
        if let Some(body) = arg.strip_prefix("--") {
            let (name, inline) = match body.split_once('=') {
                Some((name, value)) => (name, Some(value.to_owned())),
                None => (body, None),
            };
            let raw = format!("--{name}");
            let Some(kind) = kind(name) else {
                return Err(unknown(&raw));
            };
            match kind {
                Kind::Bool => {
                    if inline.is_some() {
                        return Err(format!("Option '{raw}' does not take an argument"));
                    }
                    parsed.set(name, Value::Bool);
                }
                Kind::Str | Kind::Multi => {
                    let value = match inline {
                        Some(value) => value,
                        None => {
                            let Some(next) = args.get(index) else {
                                return Err(format!("Option '{raw} <value>' argument missing"));
                            };
                            index += 1;
                            if next.len() > 1 && next.starts_with('-') {
                                return Err(format!(
                                    "Option '{raw}' argument is ambiguous.\nDid you forget to specify the option argument for '{raw}'?\nTo specify an option argument starting with a dash use '{raw}=-XYZ'."
                                ));
                            }
                            next.clone()
                        }
                    };
                    parsed.set(
                        name,
                        if kind == Kind::Multi {
                            Value::Multi(vec![value])
                        } else {
                            Value::Str(value)
                        },
                    );
                }
            }
            continue;
        }
        if arg.len() > 1 && arg.starts_with('-') {
            // No command has short options, so `-x` and every letter of `-xyz` is unknown.
            let first: String = arg.chars().skip(1).take(1).collect();
            return Err(unknown(&format!("-{first}")));
        }
        if !spec.positionals {
            return Err(unexpected(arg));
        }
        parsed.positionals.push(arg.clone());
    }
    Ok(parsed)
}

fn unexpected(arg: &str) -> String {
    format!("Unexpected argument '{arg}'. This command does not take positional arguments")
}

#[cfg(test)]
mod tests {
    use super::*;

    const SPEC: Spec = Spec {
        options: &[("x", Kind::Str), ("b", Kind::Bool), ("m", Kind::Multi)],
        positionals: true,
    };

    fn run(args: &[&str]) -> Result<Parsed, String> {
        parse(
            &args.iter().map(|s| s.to_string()).collect::<Vec<_>>(),
            &SPEC,
        )
    }

    #[test]
    fn parses_strictly() {
        let parsed = run(&[
            "--x", "a", "pos", "--x=b", "--m", "1", "--m=2", "--b", "--", "--b",
        ])
        .unwrap();
        assert_eq!(parsed.str("x"), Some("b"));
        assert_eq!(parsed.multi("m"), ["1", "2"]);
        assert!(parsed.flag("b"));
        assert_eq!(parsed.positionals, ["pos", "--b"]);
        assert_eq!(parsed.keys().collect::<Vec<_>>(), ["x", "m", "b"]);
        assert_eq!(run(&["--x", "-"]).unwrap().str("x"), Some("-"));
        assert_eq!(run(&["--x=-1"]).unwrap().str("x"), Some("-1"));
        for refused in [
            &["--x"][..],
            &["--x", "-1"],
            &["--b=1"],
            &["--bogus"],
            &["-ab"],
        ] {
            assert!(run(refused).is_err(), "{refused:?}");
        }
        let strict = Spec {
            options: &[],
            positionals: false,
        };
        assert!(parse(&["pos".to_string()], &strict).is_err());
        assert!(parse(&["--bogus".to_string()], &strict).is_err());
    }
}
