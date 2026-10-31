//! Logins from 1Password, filled without the agent seeing them (`fill_credential`). The node resolves an `op://`
//! reference with the 1Password SDK (`@1password/sdk`, pinned, run under Node.js by a small helper the node writes)
//! and a service account token: the project's or order's secret variable `OP_SERVICE_ACCOUNT_TOKEN`, else the token
//! the person whose work it is saved in Settings › Your accounts (onepassword_tokens.rs). The node keeps it out of
//! every agent's environment. Each session keeps what it resolved (not one-time codes, which change every 30 s) and
//! backs off when 1Password rate-limits the token. The same helper lists a token's vaults for its Test, and its
//! Credit Card items for a Navi's card picker; it reads a card's details for an approved purchase only (cards.rs).
use std::collections::HashMap;
use std::future::Future;
use std::path::{Path, PathBuf};
use std::pin::Pin;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use zeroize::Zeroizing;

/// The project secret variable holding the service account token.
pub const TOKEN_ENV: &str = "OP_SERVICE_ACCOUNT_TOKEN";
/// The SDK release the node installs.
pub const SDK_VERSION: &str = "0.5.0";
/// Tries after a rate limit, and the first wait (doubled each time).
const RATE_LIMIT_TRIES: u32 = 3;
const RATE_LIMIT_WAIT: Duration = Duration::from_secs(2);
/// One resolve's longest wait.
const RESOLVE_TIMEOUT: Duration = Duration::from_secs(30);
/// After the tries ran out on a rate limit, the session asks 1Password nothing for this long: a loop of fills must not
/// use up the account's daily reads, which every machine shares.
const RATE_LIMIT_COOLDOWN: Duration = Duration::from_secs(5 * 60);

/// A resolved reference: its value, and the item's websites for the origin check.
#[derive(Clone)]
pub struct Credential {
    pub value: Zeroizing<String>,
    pub urls: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct CredError {
    /// Plain words, never the value.
    pub message: String,
    pub rate_limited: bool,
}

pub type CredFuture = Pin<Box<dyn Future<Output = Result<Credential, CredError>> + Send>>;

/// A Credit Card item's details, wiped when dropped. `month` is two digits, `year` four.
pub struct Card {
    pub number: Zeroizing<String>,
    pub month: Zeroizing<String>,
    pub year: Zeroizing<String>,
    pub cvc: Zeroizing<String>,
    pub name: Zeroizing<String>,
}

pub type CardFuture = Pin<Box<dyn Future<Output = Result<Card, CredError>> + Send>>;

/// Where values come from: 1Password, or a test's fake vault.
pub trait Vault: Send + Sync + 'static {
    fn resolve(&self, reference: &str) -> CredFuture;
    /// A field of an Identity, Passport, Driver License or Social Security item, which has no website to check: for an
    /// approved secure input only.
    fn identity(&self, reference: &str) -> CredFuture {
        let reference = reference.to_owned();
        Box::pin(async move {
            Err(CredError {
                message: format!("{reference} can't be read as an identity here"),
                rate_limited: false,
            })
        })
    }

    /// A Credit Card item's details, by its `op://vault/item` reference.
    fn card(&self, reference: &str) -> CardFuture {
        let reference = reference.to_owned();
        Box::pin(async move {
            Err(CredError {
                message: format!("{reference} can't be read as a card here"),
                rate_limited: false,
            })
        })
    }
}

/// A card's expiry as 1Password keeps it (`MM/YYYY`, `MM/YY`, `YYYYMM`, `MMYYYY`), as a two-digit month and a
/// four-digit year.
pub fn expiry(value: &str) -> Option<(String, String)> {
    let digits: String = value.chars().filter(char::is_ascii_digit).collect();
    let (month, year) = match (value.contains('/'), digits.len()) {
        (true, _) => {
            let (m, y) = value.split_once('/')?;
            (m.trim().to_owned(), y.trim().to_owned())
        }
        (false, 6) if digits.starts_with("20") => (digits[4..].to_owned(), digits[..4].to_owned()),
        (false, 6) => (digits[..2].to_owned(), digits[2..].to_owned()),
        (false, 4) => (digits[..2].to_owned(), digits[2..].to_owned()),
        _ => return None,
    };
    let month: u32 = month.parse().ok().filter(|m| (1..=12).contains(m))?;
    let year = match year.len() {
        2 => format!("20{year}"),
        4 => year,
        _ => return None,
    };
    year.parse::<u32>().ok()?;
    Some((format!("{month:02}"), year))
}

/// Makes a vault from the token; the node's makes the SDK helper's.
pub type VaultFor = Arc<dyn Fn(Zeroizing<String>) -> Arc<dyn Vault> + Send + Sync>;

/// Whether a reference asks for a one-time code, which is never kept.
pub fn is_otp(reference: &str) -> bool {
    reference.ends_with("?attribute=otp") || reference.ends_with("?attribute=totp")
}

/// A session's resolved references, wiped when it goes, and until when it waits out a rate limit.
#[derive(Default)]
pub struct Cache(
    Mutex<HashMap<String, Credential>>,
    Mutex<Option<tokio::time::Instant>>,
);

impl Cache {
    /// The reference's credential: kept, or resolved now (retrying after a rate limit).
    pub async fn get(&self, vault: &dyn Vault, reference: &str) -> Result<Credential, CredError> {
        if let Some(kept) = self.lock().get(reference) {
            return Ok(kept.clone());
        }
        let cooling = *self
            .1
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(until) = cooling.filter(|u| *u > tokio::time::Instant::now()) {
            return Err(CredError {
                message: format!(
                    "1Password rate-limited this machine's service account; this session asks again in {} s",
                    (until - tokio::time::Instant::now()).as_secs() + 1
                ),
                rate_limited: true,
            });
        }
        let mut wait = RATE_LIMIT_WAIT;
        let mut tries = 0;
        let credential = loop {
            match vault.resolve(reference).await {
                Ok(credential) => break credential,
                Err(e) if e.rate_limited && tries + 1 < RATE_LIMIT_TRIES => {
                    tries += 1;
                    tokio::time::sleep(wait).await;
                    wait *= 2;
                }
                Err(e) if e.rate_limited => {
                    *self
                        .1
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner) =
                        Some(tokio::time::Instant::now() + RATE_LIMIT_COOLDOWN);
                    return Err(CredError {
                        message: format!(
                            "1Password is rate-limiting this machine's service account ({}); try again in a few \
                             minutes",
                            e.message
                        ),
                        rate_limited: true,
                    });
                }
                Err(e) => return Err(e),
            }
        };
        // Not one-time codes, nor an item without a website, which a person may yet give one.
        if !is_otp(reference) && !credential.urls.is_empty() {
            self.lock().insert(reference.to_owned(), credential.clone());
        }
        Ok(credential)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Credential>> {
        self.0
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// The host of a URL, without a port: `https://shop.example.com:8443/x` → `shop.example.com`.
pub fn host_of(url: &str) -> Option<String> {
    let rest = url.split_once("://").map_or(url, |(_, r)| r);
    let authority = rest.split(['/', '?', '#']).next()?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    let host = match host.strip_prefix('[') {
        Some(v6) => v6.split(']').next()?,
        None => host.split(':').next()?,
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

/// Whether the page at `page` is on one of the item's sites: the same host, or a subdomain of it.
pub fn origin_allowed(page: &str, urls: &[String]) -> bool {
    let Some(page) = host_of(page) else {
        return false;
    };
    urls.iter().filter_map(|u| host_of(u)).any(|site| {
        page == site
            || page
                .strip_suffix(site.as_str())
                .is_some_and(|rest| rest.ends_with('.'))
    })
}

/// The helper the node runs under Node.js: the token as its first line in, then one JSON line in per reference (or
/// `{"vaults":true}` for the names of the vaults the token reads, `{"cards":true}` for its Credit Card items,
/// `{"card":"op://vault/item"}` for one's details, `{"identity": ref}` for an Identity item's field), one out, over a
/// client made once.
pub const HELPER: &str = r#"// fleetd's 1Password helper: resolves op:// references with the SDK and a service account token. The token is the
// first line on stdin, not in the environment, where the user's other processes could read it.
import { createClient, RateLimitExceededError } from "@1password/sdk";
import { createInterface } from "node:readline";

let token;
// Made at the first reference, so a token 1Password refuses is said in each answer.
let client;
// The account's vaults, and each vault's items, listed once: a session's fills read 1Password as little as they can.
let vaults;
const items = new Map();

// The one in `list` a reference's segment names: by its ID, else by its title, which no other may share.
function named(list, segment, what) {
  const byId = list.find((x) => x.id === segment);
  if (byId) return byId;
  const titled = list.filter((x) => x.title === segment);
  if (titled.length === 1) return titled[0];
  throw new Error(
    titled.length
      ? `${titled.length} ${what}s are named ${segment}; put the ${what}'s ID in the reference`
      : `no ${what} ${segment} that this service account can read`,
  );
}

// op://vault/item[/section]/field[?attribute=...]: the websites of exactly the item the reference names, for the
// origin check.
async function websites(reference) {
  const [vaultName, itemName] = reference.slice("op://".length).split("?")[0].split("/");
  vaults ??= await client.vaults.list();
  const vault = named(vaults, vaultName, "vault");
  if (!items.has(vault.id)) items.set(vault.id, await client.items.list(vault.id));
  const item = named(items.get(vault.id), itemName, "item");
  return (item.websites ?? []).map((w) => w.url).filter(Boolean);
}

// op://vault/item: a Credit Card item's details, for an approved purchase's fill only.
async function card(reference) {
  const [vaultName, itemName] = reference.slice("op://".length).split("?")[0].split("/");
  vaults ??= await client.vaults.list();
  const vault = named(vaults, vaultName, "vault");
  if (!items.has(vault.id)) items.set(vault.id, await client.items.list(vault.id));
  const overview = named(items.get(vault.id), itemName, "item");
  if (overview.category !== "CreditCard") throw new Error(`${itemName} is not a Credit Card item`);
  const item = await client.items.get(vault.id, overview.id);
  const fields = item.fields ?? [];
  const field = (ids, types, titles) =>
    (fields.find((f) => ids.includes(f.id)) ??
      fields.find((f) => types.includes(f.fieldType)) ??
      fields.find((f) => titles.test(f.title ?? "")))?.value ?? "";
  return {
    number: field(["ccnum", "number"], ["CreditCardNumber"], /number/i),
    expiry: field(["expiry"], ["MonthYear"], /expir/i),
    cvc: field(["cvv"], [], /verification|cvv|cvc|security code/i),
    name: field(["cardholder"], [], /cardholder|name on card/i),
  };
}

// A field of an Identity, Passport, Driver License or Social Security item, for an approved secure input only.
const IDENTITIES = ["Identity", "Passport", "DriverLicense", "SocialSecurityNumber"];
async function identity(reference) {
  const [vaultName, itemName] = reference.slice("op://".length).split("?")[0].split("/");
  vaults ??= await client.vaults.list();
  const vault = named(vaults, vaultName, "vault");
  if (!items.has(vault.id)) items.set(vault.id, await client.items.list(vault.id));
  const overview = named(items.get(vault.id), itemName, "item");
  if (!IDENTITIES.includes(overview.category)) {
    throw new Error(`${itemName} is not an Identity, Passport, Driver License or Social Security item`);
  }
  return await client.secrets.resolve(reference);
}

// Every Credit Card item the token reads: names and references only.
async function cards() {
  vaults ??= await client.vaults.list();
  const out = [];
  for (const vault of vaults) {
    if (!items.has(vault.id)) items.set(vault.id, await client.items.list(vault.id));
    const all = items.get(vault.id);
    for (const item of all.filter((i) => i.category === "CreditCard")) {
      const plain = (s) => !/[/?\r\n]/.test(s);
      const vaultPart = plain(vault.title) && vaults.filter((v) => v.title === vault.title).length === 1 ? vault.title : vault.id;
      const itemPart = plain(item.title) && all.filter((i) => i.title === item.title).length === 1 ? item.title : item.id;
      out.push({ ref: `op://${vaultPart}/${itemPart}`, title: item.title, vault: vault.title });
    }
  }
  return out;
}

for await (const line of createInterface({ input: process.stdin })) {
  if (token === undefined) {
    token = JSON.parse(line).token ?? "";
    continue;
  }
  let answer;
  try {
    client ??= await createClient({ auth: token, integrationName: "fleetd", integrationVersion: "1" });
    const { ref, vaults: list, card: cardRef, cards: listCards, identity: identityRef } = JSON.parse(line);
    if (list) {
      vaults ??= await client.vaults.list();
      answer = { vaults: vaults.map((v) => v.title) };
    } else if (listCards) {
      answer = { cards: await cards() };
    } else if (cardRef) {
      answer = { card: await card(cardRef) };
    } else if (identityRef) {
      answer = { value: await identity(identityRef), urls: [] };
    } else {
      const urls = await websites(ref);
      // An item without a website fills nowhere, so its value isn't read.
      answer = urls.length ? { value: await client.secrets.resolve(ref), urls } : { urls };
    }
  } catch (e) {
    const message = String(e?.message ?? e).slice(0, 300);
    const rateLimited = e instanceof RateLimitExceededError || /rate.?limit|too many requests|429/i.test(message);
    answer = { error: message, rateLimited };
  }
  process.stdout.write(JSON.stringify(answer) + "\n");
}
"#;

pub fn install_dir(home: &Path) -> PathBuf {
    home.join("browser").join("onepassword")
}

/// The longest the SDK's install may take: past it, npm is stopped and the fill fails, so it doesn't hang.
const INSTALL_TIMEOUT: Duration = Duration::from_secs(180);

/// One install at a time: two sessions' first fills don't run npm into the same directory at once.
static INSTALLING: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// The pinned SDK and the helper beside it; installed on the first fill.
pub async fn install(home: &Path) -> Result<PathBuf, String> {
    let _one = INSTALLING.lock().await;
    let dir = install_dir(home);
    let helper = dir.join("resolve.mjs");
    let pinned = dir.join("node_modules/@1password/sdk/package.json");
    let have = std::fs::read_to_string(&pinned)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .is_some_and(|p| p["version"] == SDK_VERSION);
    if !have {
        std::fs::create_dir_all(&dir).map_err(|e| format!("cannot make {}: {e}", dir.display()))?;
        let npm = tokio::process::Command::new("npm")
            .args([
                "install",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                "--prefix",
            ])
            .arg(&dir)
            .arg(format!("@1password/sdk@{SDK_VERSION}"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status();
        let failed = match tokio::time::timeout(INSTALL_TIMEOUT, npm).await {
            Ok(Ok(status)) if status.success() => None,
            Ok(Ok(_)) => Some("installing the 1Password SDK failed".to_owned()),
            Ok(Err(e)) => Some(format!(
                "cannot run npm (Node.js) to install the 1Password SDK: {e}"
            )),
            Err(_) => Some(format!(
                "installing the 1Password SDK took over {} s",
                INSTALL_TIMEOUT.as_secs()
            )),
        };
        if let Some(why) = failed {
            // Half an install is none: the next fill starts again.
            let _ = std::fs::remove_dir_all(dir.join("node_modules"));
            return Err(why);
        }
    }
    std::fs::write(&helper, HELPER)
        .map_err(|e| format!("cannot write {}: {e}", helper.display()))?;
    Ok(helper)
}

/// The helper's first line: `{"token": …}`, borrowing the token.
fn json_token(token: &str) -> impl serde::Serialize + '_ {
    #[derive(serde::Serialize)]
    struct First<'a> {
        token: &'a str,
    }
    First { token }
}

/// The SDK helper, one process per session's vault, started on its first resolve.
pub struct OnePassword {
    home: PathBuf,
    token: Zeroizing<String>,
    process: tokio::sync::Mutex<Option<Helper>>,
}

struct Helper {
    child: tokio::process::Child,
    stdin: tokio::process::ChildStdin,
    lines: tokio::io::Lines<BufReader<tokio::process::ChildStdout>>,
}

impl OnePassword {
    pub fn new(home: &Path, token: Zeroizing<String>) -> Arc<Self> {
        Arc::new(Self {
            home: home.to_owned(),
            token,
            process: tokio::sync::Mutex::new(None),
        })
    }

    async fn start(&self) -> Result<Helper, CredError> {
        let fail = |message: String| CredError {
            message,
            rate_limited: false,
        };
        let helper = install(&self.home).await.map_err(fail)?;
        let mut child = tokio::process::Command::new("node")
            .arg(&helper)
            .current_dir(install_dir(&self.home))
            .env_remove(TOKEN_ENV)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| fail(format!("cannot start Node.js for the 1Password SDK: {e}")))?;
        let mut stdin = child.stdin.take().expect("piped stdin");
        // Written straight into a buffer big enough for any escaping, so no copy of the token is left behind.
        let mut first = Zeroizing::new(Vec::with_capacity(6 * self.token.len() + 16));
        serde_json::to_writer(&mut *first, &json_token(&self.token))
            .map_err(|e| fail(e.to_string()))?;
        first.push(b'\n');
        stdin
            .write_all(&first)
            .await
            .map_err(|e| fail(format!("cannot hand the 1Password helper its token: {e}")))?;
        let lines = BufReader::new(child.stdout.take().expect("piped stdout")).lines();
        Ok(Helper {
            child,
            stdin,
            lines,
        })
    }

    /// One line to the helper and its answer, parsed; its error as a [`CredError`].
    async fn exchange(&self, request: Value) -> Result<Value, CredError> {
        let fail = |message: &str| CredError {
            message: message.to_owned(),
            rate_limited: false,
        };
        let mut process = self.process.lock().await;
        if process.is_none() {
            *process = Some(self.start().await?);
        }
        let helper = process.as_mut().expect("started");
        let line = format!("{request}\n");
        if helper.stdin.write_all(line.as_bytes()).await.is_err() {
            *process = None;
            return Err(fail("the 1Password helper stopped"));
        }
        let answer = tokio::time::timeout(RESOLVE_TIMEOUT, helper.lines.next_line()).await;
        let Ok(Ok(Some(answer))) = answer else {
            if let Some(mut gone) = process.take() {
                let _ = gone.child.start_kill();
            }
            return Err(fail("1Password did not answer in 30 s"));
        };
        let answer = Zeroizing::new(answer);
        let parsed: Value = serde_json::from_str(&answer)
            .map_err(|_| fail("the 1Password helper said nothing readable"))?;
        if let Some(error) = parsed["error"].as_str() {
            return Err(CredError {
                message: format!("1Password: {error}"),
                rate_limited: parsed["rateLimited"] == true,
            });
        }
        Ok(parsed)
    }

    /// The names of the vaults the token reads: a token's Test.
    pub async fn vault_names(&self) -> Result<Vec<String>, CredError> {
        let parsed = self.exchange(json!({ "vaults": true })).await?;
        Ok(parsed["vaults"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v.as_str().map(str::to_owned))
            .collect())
    }

    /// The Credit Card items the token reads: a Navi's card picker.
    pub async fn cards(
        &self,
    ) -> Result<Vec<fleetd_contracts::purchase::OnePasswordCard>, CredError> {
        let parsed = self.exchange(json!({ "cards": true })).await?;
        Ok(parsed["cards"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| serde_json::from_value(c.clone()).ok())
            .collect())
    }

    async fn identity(&self, reference: &str) -> Result<Credential, CredError> {
        let mut parsed = self.exchange(json!({ "identity": reference })).await?;
        match parsed.get_mut("value").map(Value::take) {
            Some(Value::String(value)) if !value.is_empty() => Ok(Credential {
                value: Zeroizing::new(value),
                urls: Vec::new(),
            }),
            _ => Err(CredError {
                message: "1Password returned no value".into(),
                rate_limited: false,
            }),
        }
    }

    async fn card(&self, reference: &str) -> Result<Card, CredError> {
        let fail = |message: &str| CredError {
            message: message.to_owned(),
            rate_limited: false,
        };
        let mut parsed = self.exchange(json!({ "card": reference })).await?;
        let mut take = |key: &str| match parsed["card"].get_mut(key).map(Value::take) {
            Some(Value::String(value)) => Zeroizing::new(value),
            _ => Zeroizing::new(String::new()),
        };
        let (number, expires, cvc, name) =
            (take("number"), take("expiry"), take("cvc"), take("name"));
        let number = Zeroizing::new(
            number
                .chars()
                .filter(char::is_ascii_digit)
                .collect::<String>(),
        );
        if number.len() < 12 {
            return Err(fail("the item has no card number"));
        }
        let (month, year) =
            expiry(&expires).ok_or_else(|| fail("the item has no expiry date fleetd can read"))?;
        Ok(Card {
            number,
            month: Zeroizing::new(month),
            year: Zeroizing::new(year),
            cvc,
            name,
        })
    }

    async fn ask(&self, reference: &str) -> Result<Credential, CredError> {
        let fail = |message: &str| CredError {
            message: message.to_owned(),
            rate_limited: false,
        };
        let mut parsed = self.exchange(json!({ "ref": reference })).await?;
        let urls: Vec<String> = parsed["urls"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|u| u.as_str().map(str::to_owned))
            .collect();
        let value = match parsed.get_mut("value").map(Value::take) {
            Some(Value::String(value)) => Zeroizing::new(value),
            // An item without a website: the helper didn't read its value, as nothing fills it.
            None if urls.is_empty() => Zeroizing::new(String::new()),
            _ => return Err(fail("1Password returned no value")),
        };
        Ok(Credential { value, urls })
    }
}

/// The SDK helper as a session's vault.
pub struct OnePasswordVault(pub Arc<OnePassword>);

impl Vault for OnePasswordVault {
    fn resolve(&self, reference: &str) -> CredFuture {
        let (helper, reference) = (self.0.clone(), reference.to_owned());
        Box::pin(async move { helper.ask(&reference).await })
    }

    fn card(&self, reference: &str) -> CardFuture {
        let (helper, reference) = (self.0.clone(), reference.to_owned());
        Box::pin(async move { helper.card(&reference).await })
    }

    fn identity(&self, reference: &str) -> CredFuture {
        let (helper, reference) = (self.0.clone(), reference.to_owned());
        Box::pin(async move { helper.identity(&reference).await })
    }
}

/// The node's vaults: the SDK helper with the session's token.
pub fn vault_for(home: &Path) -> VaultFor {
    let home = home.to_owned();
    Arc::new(move |token| {
        Arc::new(OnePasswordVault(OnePassword::new(&home, token))) as Arc<dyn Vault>
    })
}

/// The service account token the fake SDK takes.
#[cfg(test)]
pub const FAKE_TOKEN: &str = "ops_devbox-fake-service-account";

/// A fake `@1password/sdk` at the pinned version in `home`'s install, so the node runs its real helper against it
/// with no npm and no 1Password: it takes [`FAKE_TOKEN`] only, refuses any other in an error that echoes it, reads
/// vaults Agents and Shared, in Agents an item Shop on https://shop.devbox.test and in Shared a Credit Card item Visa
/// and a Passport.
/// None without Node.js.
#[cfg(test)]
pub fn fake_sdk(home: &Path) -> Option<()> {
    std::process::Command::new("node")
        .arg("--version")
        .output()
        .ok()
        .filter(|o| o.status.success())?;
    let sdk = install_dir(home).join("node_modules/@1password/sdk");
    std::fs::create_dir_all(&sdk).unwrap();
    std::fs::write(
        sdk.join("package.json"),
        json!({ "name": "@1password/sdk", "version": SDK_VERSION, "type": "module", "main": "index.js" })
            .to_string(),
    )
    .unwrap();
    let index = r#"export class RateLimitExceededError extends Error {}
export async function createClient({ auth }) {
  if (auth !== "{token}") throw new Error(`invalid service account token ${auth}`);
  if (process.env.OP_SERVICE_ACCOUNT_TOKEN !== undefined) throw new Error("the token is in the environment");
  return {
    vaults: { list: async () => [{ id: "v1", title: "Agents" }, { id: "v2", title: "Shared" }] },
    items: {
      list: async (vault) =>
        vault === "v1"
          ? [{ id: "i1", title: "Shop", category: "Login", websites: [{ url: "https://shop.devbox.test/login" }] }]
          : [
              { id: "i2", title: "Visa", category: "CreditCard", websites: [] },
              { id: "i3", title: "Passport", category: "Passport", websites: [] },
            ],
      get: async (vault, item) => ({
        id: item,
        fields: [
          { id: "cardholder", title: "cardholder name", fieldType: "Text", value: "Ada Devbox" },
          { id: "ccnum", title: "number", fieldType: "CreditCardNumber", value: "4242 4242 4242 4242" },
          { id: "cvv", title: "verification number", fieldType: "Concealed", value: "737" },
          { id: "expiry", title: "expiry date", fieldType: "MonthYear", value: "03/2030" },
        ],
      }),
    },
    secrets: { resolve: async (ref) => `pw-${ref.split("/").at(-1)}` },
  };
}
"#;
    std::fs::write(sdk.join("index.js"), index.replace("{token}", FAKE_TOKEN)).unwrap();
    Some(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn the_helper_takes_its_token_on_stdin_lists_its_vaults_and_resolves() {
        let home = tempfile::tempdir().unwrap();
        if fake_sdk(home.path()).is_none() {
            eprintln!("no Node.js here: the helper isn't tried");
            return;
        }
        let helper = OnePassword::new(home.path(), Zeroizing::new(FAKE_TOKEN.into()));
        assert_eq!(helper.vault_names().await.unwrap(), ["Agents", "Shared"]);
        let shop = helper.ask("op://Agents/Shop/password").await.unwrap();
        assert_eq!(shop.value.as_str(), "pw-password");
        assert_eq!(shop.urls, ["https://shop.devbox.test/login"]);
        let cards = helper.cards().await.unwrap();
        assert_eq!(cards.len(), 1);
        assert_eq!(cards[0].reference.as_str(), "op://Shared/Visa");
        assert_eq!(
            (cards[0].title.as_str(), cards[0].vault.as_str()),
            ("Visa", "Shared")
        );
        let card = helper.card("op://Shared/Visa").await.unwrap();
        assert_eq!(card.number.as_str(), "4242424242424242");
        assert_eq!((card.month.as_str(), card.year.as_str()), ("03", "2030"));
        assert_eq!(
            (card.cvc.as_str(), card.name.as_str()),
            ("737", "Ada Devbox")
        );
        let passport = helper
            .identity("op://Shared/Passport/number")
            .await
            .unwrap();
        assert_eq!(passport.value.as_str(), "pw-number");
        let not_identity = helper
            .identity("op://Shared/Visa/number")
            .await
            .err()
            .unwrap();
        assert!(
            not_identity.message.contains("is not an Identity"),
            "{not_identity:?}"
        );
        let login = helper.card("op://Agents/Shop").await.err().unwrap();
        assert_eq!(login.message, "1Password: Shop is not a Credit Card item");
        let refused = OnePassword::new(home.path(), Zeroizing::new("ops_wrong".into()))
            .vault_names()
            .await
            .unwrap_err();
        assert_eq!(
            refused.message,
            "1Password: invalid service account token ops_wrong"
        );
    }

    #[test]
    fn an_expiry_reads_in_each_way_1password_keeps_it() {
        for (kept, month, year) in [
            ("03/2030", "03", "2030"),
            ("3/30", "03", "2030"),
            ("203003", "03", "2030"),
            ("032030", "03", "2030"),
            ("0330", "03", "2030"),
        ] {
            assert_eq!(expiry(kept), Some((month.into(), year.into())), "{kept}");
        }
        for bad in ["", "13/2030", "march", "03/203"] {
            assert_eq!(expiry(bad), None, "{bad}");
        }
    }

    #[test]
    fn a_page_is_on_the_items_site_by_its_host_or_a_subdomain() {
        let urls = vec!["https://shop.example.com/login".to_owned()];
        assert!(origin_allowed("https://shop.example.com/account", &urls));
        assert!(origin_allowed("https://eu.shop.example.com:8443/", &urls));
        assert!(
            !origin_allowed("https://example.com/", &urls),
            "a parent domain isn't the site"
        );
        assert!(!origin_allowed(
            "https://shop.example.com.evil.test/",
            &urls
        ));
        assert!(!origin_allowed("https://evilshop.example.com/", &urls));
        assert!(!origin_allowed("about:blank", &urls));
        assert!(
            !origin_allowed("https://shop.example.com/", &[]),
            "an item without a website fills nowhere"
        );
        assert_eq!(
            host_of("http://user@127.0.0.1:9/x").as_deref(),
            Some("127.0.0.1")
        );
    }

    struct Flaky {
        calls: Mutex<u32>,
        limited: u32,
    }

    impl Vault for Arc<Flaky> {
        fn resolve(&self, reference: &str) -> CredFuture {
            let (this, reference) = (self.clone(), reference.to_owned());
            Box::pin(async move {
                let mut calls = this.calls.lock().unwrap();
                *calls += 1;
                if *calls <= this.limited {
                    return Err(CredError {
                        message: "429 Too Many Requests".into(),
                        rate_limited: true,
                    });
                }
                Ok(Credential {
                    value: Zeroizing::new(format!("v-{reference}-{calls}")),
                    urls: vec!["https://shop.example.com/".into()],
                })
            })
        }
    }

    #[tokio::test(start_paused = true)]
    async fn a_session_keeps_what_it_resolved_but_one_time_codes_and_backs_off_a_rate_limit() {
        let vault = Arc::new(Flaky {
            calls: Mutex::new(0),
            limited: 2,
        });
        let cache = Cache::default();
        let first = cache.get(&vault, "op://Team/Shop/password").await.unwrap();
        assert_eq!(
            *vault.calls.lock().unwrap(),
            3,
            "two rate limits, then the value"
        );
        let again = cache.get(&vault, "op://Team/Shop/password").await.unwrap();
        assert_eq!(first.value.as_str(), again.value.as_str());
        assert_eq!(*vault.calls.lock().unwrap(), 3, "kept");
        let otp = "op://Team/Shop/one-time password?attribute=otp";
        cache.get(&vault, otp).await.unwrap();
        cache.get(&vault, otp).await.unwrap();
        assert_eq!(
            *vault.calls.lock().unwrap(),
            5,
            "a one-time code is read every time"
        );

        let stuck = Arc::new(Flaky {
            calls: Mutex::new(0),
            limited: 10,
        });
        let refused = Cache::default()
            .get(&stuck, "op://Team/Shop/password")
            .await
            .err()
            .unwrap();
        assert!(refused.rate_limited && refused.message.contains("try again in a few minutes"));
        assert_eq!(*stuck.calls.lock().unwrap(), RATE_LIMIT_TRIES);
    }

    #[tokio::test(start_paused = true)]
    async fn after_a_rate_limit_a_session_asks_1password_nothing_until_it_cooled_down() {
        let stuck = Arc::new(Flaky {
            calls: Mutex::new(0),
            limited: RATE_LIMIT_TRIES,
        });
        let cache = Cache::default();
        assert!(cache.get(&stuck, "op://Team/Shop/password").await.is_err());
        let again = cache
            .get(&stuck, "op://Team/Shop/other")
            .await
            .err()
            .unwrap();
        assert!(
            again.rate_limited && again.message.contains("asks again in"),
            "{again:?}"
        );
        assert_eq!(*stuck.calls.lock().unwrap(), RATE_LIMIT_TRIES, "not asked");
        tokio::time::advance(RATE_LIMIT_COOLDOWN).await;
        assert!(cache.get(&stuck, "op://Team/Shop/password").await.is_ok());
    }
}
