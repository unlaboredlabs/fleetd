//! Webhook subscriptions and their delivery. One task per active subscription walks the event log from the
//! subscription's cursor and posts each matching event in seq order, retrying the same event until it gets a 2xx
//! (at least once, never skipping ahead). The cursor is persisted after every acknowledged event, so a hub restart
//! resumes where delivery stopped.
pub mod secret_box;
pub mod signing;
pub mod tools;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rand::RngCore;
use rusqlite::{named_params, params};
use serde::Serialize;
use serde_json::json;
use tokio::task::JoinHandle;

use crate::clock::Clock;
use crate::hub::auth::{Auth, allows};
use crate::hub::queue::ports::{BoxFuture, DbRun, emit, is_admin, now_ms};
use crate::hub::store::{EventLog, HubDb, NewEvent, WaitInput};
use crate::hub::wakes::schedule::iso;
use fleetd_contracts::auth::{AgentKeyInfo, Role};
use fleetd_contracts::events::{HubEvent, HubEventType};
use fleetd_contracts::ids::EventSeq;
use fleetd_contracts::prim::NonEmpty;
use fleetd_contracts::subscriptions::{
    Subscription, SubscriptionMachines, SubscriptionState, SubscriptionTypes, WebhookKind,
    WebhookUrl,
};
pub use secret_box::SecretBox;

/// Seconds before each retry of the same event: 1 s, 5 s, 30 s, 2 min, 10 min, then hourly.
pub const RETRY_DELAYS_SEC: [u64; 5] = [1, 5, 30, 120, 600];
const RETRY_AFTER_SEC: u64 = 3600;
const FAILING_AFTER_MS: i64 = 60 * 60 * 1000;
const POST_TIMEOUT: Duration = Duration::from_secs(15);
const WAIT_TIMEOUT_SEC: u64 = 50;

#[derive(Clone, Debug)]
pub struct WebhookRequest {
    pub url: String,
    pub headers: Vec<(&'static str, String)>,
    pub body: String,
}

/// Sends one request. Ok is the HTTP status; Err is a short reason that never includes the URL.
pub trait Post: Send + Sync {
    fn post(&self, request: WebhookRequest) -> BoxFuture<'_, Result<u16, String>>;
}

/// reqwest with no redirects followed: anything but a 2xx is a failed attempt.
pub struct HttpPost(reqwest::Client);

impl HttpPost {
    pub fn new() -> Self {
        Self(
            reqwest::Client::builder()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(POST_TIMEOUT)
                .build()
                .expect("http client"),
        )
    }
}

impl Default for HttpPost {
    fn default() -> Self {
        Self::new()
    }
}

impl Post for HttpPost {
    fn post(&self, request: WebhookRequest) -> BoxFuture<'_, Result<u16, String>> {
        Box::pin(async move {
            let mut builder = self.0.post(&request.url).body(request.body);
            for (name, value) in request.headers {
                builder = builder.header(name, value);
            }
            match builder.send().await {
                Ok(response) => Ok(response.status().as_u16()),
                // reqwest's error text includes the URL, so only its kind is kept.
                Err(e) if e.is_timeout() => Err("timeout".into()),
                Err(e) if e.is_connect() => Err("connect failed".into()),
                Err(_) => Err("request failed".into()),
            }
        })
    }
}

/// subscription_set's input (contracts SubscriptionSetInput).
#[derive(Clone, Debug)]
pub struct CreateInput {
    pub url: WebhookUrl,
    pub types: SubscriptionTypes,
    pub machines: SubscriptionMachines,
    pub client_request_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Created {
    pub subscription_id: String,
    pub secret: String,
}

#[derive(Clone, Debug)]
struct Row {
    subscription_id: String,
    created_by: String,
    url: String,
    types: SubscriptionTypes,
    machines: SubscriptionMachines,
    sealed: String,
    state: SubscriptionState,
    last_delivered_seq: i64,
    failing_since_ms: Option<i64>,
}

fn to_row(r: &rusqlite::Row<'_>) -> rusqlite::Result<Row> {
    fn json<T: serde::de::DeserializeOwned>(
        r: &rusqlite::Row<'_>,
        col: &str,
    ) -> rusqlite::Result<T> {
        let text: String = r.get(col)?;
        serde_json::from_str(&text).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
        })
    }
    let state: String = r.get("state")?;
    Ok(Row {
        subscription_id: r.get("subscription_id")?,
        created_by: r.get("created_by")?,
        url: r.get("url")?,
        types: json(r, "types")?,
        machines: json(r, "machines")?,
        sealed: r.get("secret")?,
        state: if state == "disabled" {
            SubscriptionState::Disabled
        } else {
            SubscriptionState::Active
        },
        last_delivered_seq: r.get("last_delivered_seq")?,
        failing_since_ms: r.get("failing_since_ms")?,
    })
}

fn to_subscription(row: Row) -> Subscription {
    Subscription {
        subscription_id: NonEmpty::unchecked(row.subscription_id),
        kind: WebhookKind::Value,
        url: WebhookUrl::unchecked(row.url),
        types: row.types,
        machines: row.machines,
        created_by: row.created_by,
        state: row.state,
        last_delivered_seq: EventSeq::new(row.last_delivered_seq).ok(),
        failing_since: row.failing_since_ms.map(|ms| iso(ms).into()),
    }
}

/// Logged instead of the URL, whose path or query may carry a token.
fn origin(url: &str) -> String {
    url::Url::parse(url).map_or_else(
        |_| "(invalid url)".into(),
        |u| u.origin().ascii_serialization(),
    )
}

pub struct Webhooks {
    db: Arc<HubDb>,
    events: Arc<EventLog>,
    auth: Arc<Auth>,
    secret_box: SecretBox,
    post: Arc<dyn Post>,
    clock: Arc<dyn Clock>,
    tasks: Mutex<HashMap<String, JoinHandle<()>>>,
}

impl Webhooks {
    pub fn new(
        db: Arc<HubDb>,
        events: Arc<EventLog>,
        auth: Arc<Auth>,
        secret_box: SecretBox,
        post: Arc<dyn Post>,
        clock: Arc<dyn Clock>,
    ) -> Arc<Self> {
        Arc::new(Self {
            db,
            events,
            auth,
            secret_box,
            post,
            clock,
            tasks: Mutex::new(HashMap::new()),
        })
    }

    /// Webhooks for the hub in `home`, sealing secrets with `<home>/webhook.key` (created 0600 on first start).
    pub fn for_home(
        home: &Path,
        db: Arc<HubDb>,
        events: Arc<EventLog>,
        auth: Arc<Auth>,
        clock: Arc<dyn Clock>,
    ) -> Result<Arc<Self>, secret_box::SecretBoxError> {
        let secret_box = SecretBox::from_key_file(&home.join("webhook.key"))?;
        Ok(Self::new(
            db,
            events,
            auth,
            secret_box,
            Arc::new(HttpPost::new()),
            clock,
        ))
    }

    /// Starts delivery for every active subscription.
    pub fn start(self: &Arc<Self>) {
        let rows: Vec<Row> = self.query("SELECT * FROM subscriptions WHERE state = 'active'", []);
        for row in rows {
            self.start_one(row);
        }
    }

    pub fn stop(&self) {
        for (_, h) in self.tasks.lock().expect("lock").drain() {
            h.abort();
        }
    }

    fn query<P: rusqlite::Params>(&self, sql: &str, params: P) -> Vec<Row> {
        self.db.run(|db| {
            let mut stmt = db.prepare(sql).expect("sql");
            stmt.query_map(params, to_row)
                .expect("sql")
                .filter_map(Result::ok)
                .collect()
        })
    }

    fn exec<P: rusqlite::Params>(&self, sql: &str, params: P) -> usize {
        self.db.run(|db| db.execute(sql, params).expect("sql"))
    }

    fn start_one(self: &Arc<Self>, row: Row) {
        let mut tasks = self.tasks.lock().expect("lock");
        if tasks
            .get(&row.subscription_id)
            .is_some_and(|h| !h.is_finished())
        {
            return;
        }
        let me = self.clone();
        tasks.insert(
            row.subscription_id.clone(),
            tokio::spawn(async move { me.run(row).await }),
        );
    }

    /// Delivers events appended from now on. A retry with the same clientRequestId returns the same subscription.
    pub fn create(self: &Arc<Self>, caller: &AgentKeyInfo, input: CreateInput) -> Created {
        let now = now_ms(&*self.clock);
        let mut id = [0u8; 8];
        rand::thread_rng().fill_bytes(&mut id);
        let id: String = id.iter().map(|b| format!("{b:02x}")).collect();
        self.exec(
            "INSERT INTO subscriptions (subscription_id, created_by, client_request_id, url, types, machines, secret, state, created_ms, last_delivered_seq)
             VALUES (:id, :created_by, :client_request_id, :url, :types, :machines, :secret, 'active', :now, :seq)
             ON CONFLICT (created_by, client_request_id) DO NOTHING",
            named_params! {
                ":id": format!("sub_{id}"),
                ":created_by": caller.key_id.as_str(),
                ":client_request_id": input.client_request_id,
                ":url": input.url.as_str(),
                ":types": serde_json::to_string(&input.types).expect("json"),
                ":machines": serde_json::to_string(&input.machines).expect("json"),
                ":secret": self.secret_box.seal(&signing::new_secret()),
                ":now": now,
                ":seq": self.events.head(),
            },
        );
        let row = self
            .query(
                "SELECT * FROM subscriptions WHERE created_by = ? AND client_request_id = ?",
                params![caller.key_id.as_str(), input.client_request_id],
            )
            .remove(0);
        let secret = self
            .secret_box
            .open(&row.sealed)
            .expect("a secret this hub just sealed opens");
        let created = Created {
            subscription_id: row.subscription_id.clone(),
            secret,
        };
        self.start_one(row);
        created
    }

    /// The caller's own subscriptions; an admin key sees all. Never includes secrets.
    pub fn list(&self, caller: &AgentKeyInfo) -> Vec<Subscription> {
        self.query(
            "SELECT * FROM subscriptions ORDER BY created_ms, subscription_id",
            [],
        )
        .into_iter()
        .filter(|row| is_admin(caller) || row.created_by == caller.key_id.as_str())
        .map(to_subscription)
        .collect()
    }

    /// False when there is no such subscription the caller may delete.
    pub fn remove(&self, caller: &AgentKeyInfo, subscription_id: &str) -> bool {
        let found = self.query(
            "SELECT * FROM subscriptions WHERE subscription_id = ?",
            [subscription_id],
        );
        let Some(row) = found.first() else {
            return false;
        };
        if !(is_admin(caller) || row.created_by == caller.key_id.as_str()) {
            return false;
        }
        if let Some(h) = self.tasks.lock().expect("lock").remove(subscription_id) {
            h.abort();
        }
        self.exec(
            "DELETE FROM subscriptions WHERE subscription_id = ?",
            [subscription_id],
        );
        true
    }

    /// Emits webhook.failing once per failing spell for each subscription failing over an hour. Safe to call from a
    /// sweep.
    pub fn check_failing(&self) {
        let now = now_ms(&*self.clock);
        let overdue = self.query(
            "SELECT * FROM subscriptions WHERE state = 'active' AND failing_reported = 0 AND failing_since_ms IS NOT NULL AND failing_since_ms <= ?",
            [now - FAILING_AFTER_MS],
        );
        for row in overdue {
            // The guarded update makes two concurrent checks emit once.
            if self.exec(
                "UPDATE subscriptions SET failing_reported = 1 WHERE subscription_id = ? AND failing_reported = 0",
                [&row.subscription_id],
            ) == 0
            {
                continue;
            }
            let since = iso(row.failing_since_ms.unwrap_or(now));
            emit(
                &self.events,
                NewEvent {
                    at: iso(now).into(),
                    r#type: HubEventType::WebhookFailing,
                    machine_id: None,
                    project_id: None,
                    thread_id: None,
                    summary: format!(
                        "Webhook {} to {} has been failing since {since}",
                        row.subscription_id,
                        origin(&row.url)
                    ),
                    data: Some(json!({
                        "subscriptionId": row.subscription_id,
                        "failingSince": since,
                        "lastDeliveredSeq": row.last_delivered_seq,
                    })),
                    attention: None,
                },
            );
        }
    }

    /// Whether the subscription's filters and its creator's read grants (checked at delivery) let `event` through.
    fn matches(&self, row: &Row, creator: Option<&AgentKeyInfo>, event: &HubEvent) -> bool {
        let Some(creator) = creator else { return false };
        let machine_ok = match &row.machines {
            SubscriptionMachines::All(_) => true,
            SubscriptionMachines::Only(list) => {
                event.machine_id.as_ref().is_some_and(|m| list.contains(m))
            }
        };
        creator.revoked_at.is_none()
            && machine_ok
            && allows(creator, Role::Read, event.machine_id.as_ref())
    }

    /// Posts `event` until a 2xx, following RETRY_DELAYS_SEC; reports webhook.failing as the spell crosses one hour.
    async fn deliver(&self, row: &Row, secret: &str, event: &HubEvent) {
        let body = serde_json::to_string(event).expect("event encodes");
        let id = format!("{}_{}", row.subscription_id, event.seq.get());
        // From the row as loaded when delivery started.
        let mut failing_since = row.failing_since_ms;
        let mut attempt = 0usize;
        loop {
            let now = now_ms(&*self.clock);
            let timestamp = now.div_euclid(1000);
            let outcome = self
                .post
                .post(WebhookRequest {
                    url: row.url.clone(),
                    body: body.clone(),
                    headers: vec![
                        ("content-type", "application/json".into()),
                        (
                            "user-agent",
                            format!("fleetd/{}", env!("CARGO_PKG_VERSION")),
                        ),
                        ("webhook-id", id.clone()),
                        ("webhook-timestamp", timestamp.to_string()),
                        (
                            "webhook-signature",
                            signing::sign(secret, &id, timestamp, &body),
                        ),
                    ],
                })
                .await;
            if matches!(outcome, Ok(status) if (200..300).contains(&status)) {
                if failing_since.is_some() {
                    self.exec(
                        "UPDATE subscriptions SET failing_since_ms = NULL, failing_reported = 0 WHERE subscription_id = ?",
                        [&row.subscription_id],
                    );
                }
                return;
            }
            let since = *failing_since.get_or_insert_with(|| {
                self.exec(
                    "UPDATE subscriptions SET failing_since_ms = COALESCE(failing_since_ms, ?) WHERE subscription_id = ?",
                    params![now, row.subscription_id],
                );
                now
            });
            let delay_ms = RETRY_DELAYS_SEC
                .get(attempt)
                .copied()
                .unwrap_or(RETRY_AFTER_SEC) as i64
                * 1000;
            let error = match &outcome {
                Ok(status) => format!("HTTP {status}"),
                Err(reason) => reason.clone(),
            };
            tracing::warn!(
                subscription_id = %row.subscription_id,
                to = %origin(&row.url),
                seq = event.seq.get(),
                error = %error,
                retry_in_sec = delay_ms / 1000,
                "webhook delivery failed"
            );
            let report_at = since + FAILING_AFTER_MS;
            let ms = |n: i64| Duration::from_millis(n.max(0) as u64);
            if report_at > now && report_at < now + delay_ms {
                self.clock.sleep(ms(report_at - now)).await;
                self.check_failing();
                self.clock.sleep(ms(now + delay_ms - report_at)).await;
            } else {
                if report_at <= now {
                    self.check_failing();
                }
                self.clock.sleep(ms(delay_ms)).await;
            }
            attempt += 1;
        }
    }

    async fn run(self: Arc<Self>, row: Row) {
        let Ok(secret) = self.secret_box.open(&row.sealed) else {
            self.exec(
                "UPDATE subscriptions SET state = 'disabled' WHERE subscription_id = ?",
                [&row.subscription_id],
            );
            tracing::error!(
                subscription_id = %row.subscription_id,
                fix = "delete it and create it again",
                "webhook subscription disabled: its secret no longer decrypts (was webhook.key replaced?)"
            );
            return;
        };
        let types = match &row.types {
            SubscriptionTypes::All(_) => None,
            SubscriptionTypes::Only(t) => Some(t.clone()),
        };
        let mut cursor = row.last_delivered_seq.max(0);
        let advance = |seq: i64| {
            self.exec(
                "UPDATE subscriptions SET last_delivered_seq = ?1 WHERE subscription_id = ?2 AND last_delivered_seq < ?1",
                params![seq, row.subscription_id],
            );
        };
        loop {
            let page = match self
                .events
                .wait(WaitInput {
                    cursor: Some(cursor),
                    types: types.clone(),
                    machine_id: None,
                    timeout_sec: WAIT_TIMEOUT_SEC,
                })
                .await
            {
                Ok(page) => page,
                Err(error) => {
                    tracing::error!(subscription_id = %row.subscription_id, error = %error, "webhook delivery: event log read failed");
                    self.clock.sleep(Duration::from_secs(1)).await;
                    continue;
                }
            };
            let creator = if page.events.is_empty() {
                None
            } else {
                self.auth.list().ok().and_then(|keys| {
                    keys.into_iter()
                        .find(|k| k.key_id.as_str() == row.created_by)
                })
            };
            for event in &page.events {
                if self.matches(&row, creator.as_ref(), event) {
                    self.deliver(&row, &secret, event).await;
                }
                let seq = event.seq.get();
                advance(seq);
                cursor = seq;
            }
            if page.cursor > cursor {
                advance(page.cursor);
                cursor = page.cursor;
            }
        }
    }

    #[cfg(test)]
    fn raw_rows(&self) -> String {
        self.db.run(|db| {
            let mut stmt = db.prepare("SELECT * FROM subscriptions").expect("sql");
            let cols = stmt.column_count();
            let rows: Vec<String> = stmt
                .query_map([], |r| {
                    Ok((0..cols)
                        .map(|i| format!("{:?}", r.get_ref(i).map(|v| v.as_str().unwrap_or(""))))
                        .collect::<String>())
                })
                .expect("sql")
                .filter_map(Result::ok)
                .collect();
            rows.join("\n")
        })
    }

    #[cfg(test)]
    fn stored(&self, subscription_id: &str) -> Option<i64> {
        use rusqlite::OptionalExtension;
        self.db.run(|db| {
            db.query_row(
                "SELECT last_delivered_seq FROM subscriptions WHERE subscription_id = ?",
                [subscription_id],
                |r| r.get(0),
            )
            .optional()
            .expect("sql")
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hub::queue::test_kit::*;
    use fleetd_contracts::auth::{Grant, KeyKind};
    use fleetd_contracts::ids::MachineId;
    use fleetd_contracts::subscriptions::Star;
    use std::collections::HashSet;

    /// A key with one grant; `machines` is `"*"` or a JSON list of machine ids.
    fn key(auth: &Auth, name: &str, role: &str, machines: serde_json::Value) -> AgentKeyInfo {
        let grant: Grant =
            serde_json::from_value(json!({ "role": role, "machines": machines })).unwrap();
        auth.create_key(name, &[grant], KeyKind::Agent)
            .unwrap()
            .info
    }

    #[derive(Clone)]
    struct Attempt {
        at_sec: i64,
        seq: i64,
        request: WebhookRequest,
    }

    /// A receiver that answers each attempt with the next scripted status (then 200), recording when it was called.
    struct Receiver {
        clock: Arc<TestClock>,
        script: Mutex<Vec<Option<u16>>>,
        attempts: Mutex<Vec<Attempt>>,
    }

    impl Receiver {
        fn new(clock: Arc<TestClock>, script: Vec<Option<u16>>) -> Arc<Self> {
            Arc::new(Self {
                clock,
                script: Mutex::new(script),
                attempts: Mutex::new(vec![]),
            })
        }
        fn attempts(&self) -> Vec<Attempt> {
            self.attempts.lock().unwrap().clone()
        }
    }

    impl Post for Receiver {
        fn post(&self, request: WebhookRequest) -> BoxFuture<'_, Result<u16, String>> {
            let at_sec = now_ms(&*self.clock) / 1000;
            let seq = serde_json::from_str::<serde_json::Value>(&request.body).unwrap()["seq"]
                .as_i64()
                .unwrap();
            self.attempts.lock().unwrap().push(Attempt {
                at_sec,
                seq,
                request,
            });
            let mut script = self.script.lock().unwrap();
            let next = if script.is_empty() {
                Some(200)
            } else {
                script.remove(0)
            };
            Box::pin(async move { next.ok_or_else(|| "ECONNREFUSED".to_string()) })
        }
    }

    fn header<'a>(r: &'a WebhookRequest, name: &str) -> &'a str {
        &r.headers.iter().find(|(n, _)| *n == name).unwrap().1
    }

    fn verified(secret: &str, r: &WebhookRequest, now_sec: i64) -> bool {
        signing::verify(
            secret,
            header(r, "webhook-id"),
            header(r, "webhook-timestamp"),
            header(r, "webhook-signature"),
            &r.body,
            now_sec,
            300,
        )
    }

    use HubEventType::{MachineOffline, MachineOnline, ThreadCompleted, ThreadStarted};

    fn event(kind: HubEventType, machine: Option<&str>) -> NewEvent {
        NewEvent {
            at: "2026-10-17T10:00:00.000Z".into(),
            r#type: kind,
            machine_id: machine.map(MachineId::unchecked),
            project_id: None,
            thread_id: None,
            summary: "an event".into(),
            data: None,
            attention: None,
        }
    }

    fn any_type() -> SubscriptionTypes {
        SubscriptionTypes::All(Star::Value)
    }
    fn any_machine() -> SubscriptionMachines {
        SubscriptionMachines::All(Star::Value)
    }
    fn input(
        types: SubscriptionTypes,
        machines: SubscriptionMachines,
        client_request_id: &str,
    ) -> CreateInput {
        CreateInput {
            url: WebhookUrl::new("https://example.test/hook?token=t").unwrap(),
            types,
            machines,
            client_request_id: client_request_id.into(),
        }
    }
    fn seq(e: Result<HubEvent, crate::hub::store::StoreError>) -> i64 {
        e.unwrap().seq.get()
    }

    struct Setup {
        kit: Kit,
        auth: Arc<Auth>,
    }

    impl Setup {
        fn new() -> Self {
            let kit = Kit::at(0);
            let auth = Arc::new(Auth::new(kit.db.clone(), kit.clock.clone()));
            Self { kit, auth }
        }
        fn webhooks(&self, post: Arc<dyn Post>, secret_box: SecretBox) -> Arc<Webhooks> {
            let w = Webhooks::new(
                self.kit.db.clone(),
                self.kit.events.clone(),
                self.auth.clone(),
                secret_box,
                post,
                self.kit.clock.clone(),
            );
            w.start();
            w
        }
    }

    fn random_box() -> SecretBox {
        let mut key = [0u8; 32];
        rand::thread_rng().fill_bytes(&mut key);
        SecretBox::from_key(&key).unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn retries_one_event_on_the_schedule_holding_later_events_back() {
        let s = Setup::new();
        let rx = Receiver::new(
            s.kit.clock.clone(),
            vec![Some(500), None, Some(500), Some(503), Some(500), Some(500)],
        );
        let webhooks = s.webhooks(rx.clone(), random_box());
        let admin = key(&s.auth, "admin", "admin", json!("*"));
        s.kit
            .events
            .append(event(ThreadCompleted, Some("lab-a")))
            .unwrap(); // before the subscription: never delivered
        let created = webhooks.create(
            &admin,
            input(
                SubscriptionTypes::Only(vec![ThreadCompleted]),
                SubscriptionMachines::Only(vec![MachineId::unchecked("lab-a")]),
                "r1",
            ),
        );
        s.kit
            .events
            .append(event(ThreadStarted, Some("lab-a")))
            .unwrap();
        s.kit
            .events
            .append(event(ThreadCompleted, Some("lab-b")))
            .unwrap();
        let first = seq(s.kit.events.append(event(ThreadCompleted, Some("lab-a"))));
        let second = seq(s.kit.events.append(event(ThreadCompleted, Some("lab-a"))));
        settle().await;
        assert_eq!(
            rx.attempts()
                .iter()
                .map(|a| (a.at_sec, a.seq))
                .collect::<Vec<_>>(),
            vec![(0, first)]
        );

        s.kit.advance(Duration::from_secs(13 * 60)).await; // through the 10 min retry at 756 s
        assert_eq!(
            rx.attempts().iter().map(|a| a.at_sec).collect::<Vec<_>>(),
            vec![0, 1, 6, 36, 156, 756]
        );
        assert!(rx.attempts().iter().all(|a| a.seq == first));
        let failing = &webhooks.list(&admin)[0];
        assert_eq!(
            (
                failing.failing_since.as_ref().map(|t| t.as_str()),
                failing.last_delivered_seq.map(|s| s.get())
            ),
            (Some(iso(0).as_str()), Some(first - 1))
        );

        // webhook.failing fires once, an hour into the failing spell, between the hourly retries.
        s.kit.advance(Duration::from_secs(46 * 60)).await;
        assert!(s.kit.events.of(HubEventType::WebhookFailing).is_empty());
        s.kit.advance(Duration::from_secs(60)).await;
        let reported = s.kit.events.of(HubEventType::WebhookFailing);
        assert_eq!(reported.len(), 1);
        assert_eq!(reported[0].at.as_str(), iso(3_600_000));
        assert!(reported[0].summary.contains("https://example.test"));
        assert!(!reported[0].summary.contains("token"));

        s.kit.advance(Duration::from_secs(3600)).await;
        let mut expected: Vec<(i64, i64)> = [0, 1, 6, 36, 156, 756]
            .iter()
            .map(|&t| (t, first))
            .collect();
        expected.extend([(756 + 3600, first), (756 + 3600, second)]);
        assert_eq!(
            rx.attempts()
                .iter()
                .map(|a| (a.at_sec, a.seq))
                .collect::<Vec<_>>(),
            expected
        );
        assert_eq!(s.kit.events.of(HubEventType::WebhookFailing).len(), 1);
        let healthy = &webhooks.list(&admin)[0];
        // The cursor also moves past the webhook.failing event the type filter skips.
        assert_eq!(
            (healthy.last_delivered_seq, healthy.failing_since.clone()),
            (Some(reported[0].seq), None)
        );

        // Each attempt is signed afresh with its own timestamp; the id stays the same across retries.
        for a in rx.attempts() {
            assert_eq!(
                header(&a.request, "webhook-timestamp"),
                a.at_sec.to_string()
            );
            assert!(verified(&created.secret, &a.request, a.at_sec));
        }
        let ids: HashSet<_> = rx.attempts()[..7]
            .iter()
            .map(|a| header(&a.request, "webhook-id").to_string())
            .collect();
        assert_eq!(ids.len(), 1);
    }

    #[tokio::test(start_paused = true)]
    async fn delivers_only_what_the_creator_may_read_and_lists_only_own() {
        let s = Setup::new();
        let rx = Receiver::new(s.kit.clock.clone(), vec![]);
        let webhooks = s.webhooks(rx.clone(), random_box());
        let admin = key(&s.auth, "admin", "admin", json!("*"));
        let a_only = key(&s.auth, "a", "operate", json!(["lab-a"]));
        let sub = webhooks.create(&a_only, input(any_type(), any_machine(), "r1"));
        assert_eq!(
            webhooks.create(&a_only, input(any_type(), any_machine(), "r1")),
            sub
        );
        s.kit
            .events
            .append(event(ThreadCompleted, Some("lab-b")))
            .unwrap();
        let on_a = seq(s.kit.events.append(event(ThreadCompleted, Some("lab-a"))));
        settle().await;
        assert_eq!(
            rx.attempts().iter().map(|a| a.seq).collect::<Vec<_>>(),
            vec![on_a]
        );

        let other = webhooks.create(&admin, input(any_type(), any_machine(), "r2"));
        assert_eq!(
            webhooks
                .list(&a_only)
                .iter()
                .map(|s| s.subscription_id.to_string())
                .collect::<Vec<_>>(),
            vec![sub.subscription_id.clone()]
        );
        let mut both: Vec<_> = webhooks
            .list(&admin)
            .into_iter()
            .map(|s| s.subscription_id.to_string())
            .collect();
        both.sort();
        let mut want = vec![sub.subscription_id.clone(), other.subscription_id.clone()];
        want.sort();
        assert_eq!(both, want);
        assert!(
            !serde_json::to_string(&webhooks.list(&admin))
                .unwrap()
                .contains(&sub.secret[6..])
        );
        assert!(!webhooks.remove(&a_only, &other.subscription_id));
        assert!(webhooks.remove(&a_only, &sub.subscription_id));
        let later = seq(s.kit.events.append(event(ThreadCompleted, Some("lab-a"))));
        settle().await;
        // Only the admin's subscription is left to deliver it.
        assert_eq!(
            rx.attempts().iter().map(|a| a.seq).collect::<Vec<_>>(),
            vec![on_a, later]
        );
        assert!(header(&rx.attempts()[1].request, "webhook-id").contains(&other.subscription_id));
    }

    #[tokio::test(start_paused = true)]
    async fn stores_the_secret_sealed_and_resumes_from_its_cursor_after_restart() {
        let s = Setup::new();
        let sealing_key = [9u8; 32];
        let first = Receiver::new(s.kit.clock.clone(), vec![]);
        let webhooks = s.webhooks(first.clone(), SecretBox::from_key(&sealing_key).unwrap());
        let admin = key(&s.auth, "admin", "admin", json!("*"));
        let created = webhooks.create(&admin, input(any_type(), any_machine(), "r1"));
        s.kit
            .events
            .append(event(MachineOnline, Some("lab-a")))
            .unwrap();
        settle().await;
        assert!(!webhooks.raw_rows().contains(&created.secret[6..]));
        assert_eq!(
            first.attempts().iter().map(|a| a.seq).collect::<Vec<_>>(),
            vec![1]
        );
        assert_eq!(webhooks.stored(&created.subscription_id), Some(1));
        webhooks.stop();

        s.kit
            .events
            .append(event(MachineOffline, Some("lab-a")))
            .unwrap();
        let second = Receiver::new(s.kit.clock.clone(), vec![]);
        let _again = s.webhooks(second.clone(), SecretBox::from_key(&sealing_key).unwrap());
        settle().await;
        assert_eq!(
            second.attempts().iter().map(|a| a.seq).collect::<Vec<_>>(),
            vec![2]
        );
        assert!(verified(&created.secret, &second.attempts()[0].request, 0));
    }
}
