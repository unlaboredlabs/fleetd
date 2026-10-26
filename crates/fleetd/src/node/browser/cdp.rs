//! The one Chrome DevTools Protocol connection to a session's browser: Chrome's `--remote-debugging-pipe`, which only
//! the node holds (no debugging port is open). The broker uses it for the screencast, the recording, filling
//! credentials and a person's input; the agent's driver reaches the same browser only through the broker's proxy
//! (proxy.rs), whose commands go out on it under ids of their own.
//!
//! Messages are JSON, each ended by a NUL byte. The router reads every message once: an answer goes to whoever sent
//! the command; an event goes to the broker, and to the proxy unless it belongs to a target session the broker
//! attached itself (the agent never learns those exist).
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot};

use crate::node::util::AbortOnDrop;

/// A command unanswered this long fails; a page busy loading answers well within it.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// One event, from the browser (`session_id` none) or one of its targets.
#[derive(Clone, Debug)]
pub struct Event {
    pub method: String,
    pub params: Value,
    pub session_id: Option<String>,
}

impl Event {
    /// The event as the protocol sends it.
    pub fn to_message(&self) -> Value {
        let mut message = json!({ "method": self.method, "params": self.params });
        if let Some(session) = &self.session_id {
            message["sessionId"] = session.as_str().into();
        }
        message
    }
}

/// Who waits for an answer.
enum Waiter {
    Broker(oneshot::Sender<Result<Value, String>>),
    /// The proxy's client, by the id it gave the command: the answer goes to it in turn with the events.
    Proxy(Value),
    /// The broker's own `Target.attachToTarget`: its session stays the broker's.
    Attach(String, oneshot::Sender<Result<Value, String>>),
}

#[derive(Default)]
struct Routes {
    waiting: HashMap<u64, Waiter>,
    /// Target sessions the broker attached: their events and answers never reach the proxy.
    own: HashSet<String>,
    /// Targets the broker is attaching now, and the attach events held until its answer names its session.
    attaching: HashMap<String, Vec<Event>>,
    broker: Vec<mpsc::UnboundedSender<Event>>,
    /// The proxy's client: the events and answers it may see, as the protocol sends them, in order.
    proxy: Option<mpsc::UnboundedSender<Value>>,
}

pub struct Cdp {
    send: mpsc::UnboundedSender<Vec<u8>>,
    routes: Arc<Mutex<Routes>>,
    next: AtomicU64,
    _reader: AbortOnDrop,
    _writer: AbortOnDrop,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Routes {
    fn event(&mut self, event: Event) {
        self.broker.retain(|tx| tx.send(event.clone()).is_ok());
        if event.method == "Target.attachedToTarget" {
            let target = event.params["targetInfo"]["targetId"]
                .as_str()
                .unwrap_or_default();
            if let Some(held) = self.attaching.get_mut(target) {
                held.push(event);
                return;
            }
        }
        let session = event
            .session_id
            .as_deref()
            .or_else(|| event.params["sessionId"].as_str());
        if session.is_some_and(|s| self.own.contains(s)) {
            return;
        }
        self.send_proxy(event.to_message());
    }

    fn send_proxy(&mut self, message: Value) {
        if let Some(proxy) = &self.proxy
            && proxy.send(message).is_err()
        {
            self.proxy = None;
        }
    }

    /// Stops holding attach events for `target`, and hands the held ones to the proxy.
    fn release(&mut self, target: &str) {
        for held in self.attaching.remove(target).unwrap_or_default() {
            self.send_proxy(held.to_message());
        }
    }

    fn answer(&mut self, id: u64, mut message: Value) {
        let Some(waiter) = self.waiting.remove(&id) else {
            return;
        };
        let result = || match message.get("error") {
            Some(error) => Err(error["message"]
                .as_str()
                .unwrap_or("the browser refused the command")
                .to_owned()),
            None => Ok(message.get("result").cloned().unwrap_or_default()),
        };
        match waiter {
            Waiter::Broker(tx) => {
                let _ = tx.send(result());
            }
            Waiter::Proxy(theirs) => {
                message["id"] = theirs;
                self.send_proxy(message);
            }
            Waiter::Attach(target, tx) => {
                let answer = result();
                let mine = answer
                    .as_ref()
                    .ok()
                    .and_then(|r| r["sessionId"].as_str())
                    .map(str::to_owned);
                if let Some(mine) = &mine {
                    self.own.insert(mine.clone());
                }
                // The attach events held meanwhile that weren't the broker's were the agent's own (auto-attach).
                for held in self.attaching.remove(&target).unwrap_or_default() {
                    if held.params["sessionId"].as_str() != mine.as_deref() {
                        self.send_proxy(held.to_message());
                    }
                }
                let _ = tx.send(answer);
            }
        }
    }
}

impl Cdp {
    /// Talks to a Chrome started with `--remote-debugging-pipe` over its pipe (its fd 3 is `stdin`, its fd 4
    /// `stdout`, as chrome.rs wires them).
    pub fn over_pipe(stdin: ChildStdin, stdout: ChildStdout) -> Arc<Self> {
        let (send, mut outbox) = mpsc::unbounded_channel::<Vec<u8>>();
        let routes: Arc<Mutex<Routes>> = Arc::default();
        let writer = tokio::spawn(async move {
            let mut stdin = stdin;
            while let Some(mut message) = outbox.recv().await {
                message.push(0);
                if stdin.write_all(&message).await.is_err() {
                    break;
                }
            }
        });
        let reader = {
            let routes = routes.clone();
            tokio::spawn(async move {
                let mut reader = BufReader::new(stdout);
                let mut buffer = Vec::new();
                loop {
                    buffer.clear();
                    match reader.read_until(0, &mut buffer).await {
                        Ok(0) | Err(_) => break,
                        Ok(_) => {}
                    }
                    if buffer.last() == Some(&0) {
                        buffer.pop();
                    }
                    let Ok(mut message) = serde_json::from_slice::<Value>(&buffer) else {
                        continue;
                    };
                    let mut routes = lock(&routes);
                    if let Some(id) = message.get("id").and_then(Value::as_u64) {
                        routes.answer(id, message);
                    } else if let Some(method) = message["method"].as_str().map(str::to_owned) {
                        routes.event(Event {
                            method,
                            session_id: message["sessionId"].as_str().map(str::to_owned),
                            params: message
                                .get_mut("params")
                                .map(Value::take)
                                .unwrap_or_default(),
                        });
                    }
                }
                // The browser went: everyone still waiting hears so now rather than at their timeout.
                let mut routes = lock(&routes);
                for (_, waiter) in routes.waiting.drain() {
                    match waiter {
                        Waiter::Broker(tx) | Waiter::Attach(_, tx) => {
                            let _ = tx.send(Err("the browser closed".to_owned()));
                        }
                        Waiter::Proxy(_) => {}
                    }
                }
                routes.broker.clear();
                routes.proxy = None;
            })
        };
        Arc::new(Self {
            send,
            routes,
            next: AtomicU64::new(1),
            _reader: AbortOnDrop(reader),
            _writer: AbortOnDrop(writer),
        })
    }

    /// Every event from now on, for the broker.
    pub fn events(&self) -> mpsc::UnboundedReceiver<Event> {
        let (tx, rx) = mpsc::unbounded_channel();
        lock(&self.routes).broker.push(tx);
        rx
    }

    /// What the agent's driver may see from now on, events and the answers to its commands; a new proxy client
    /// replaces the last.
    pub fn proxy_events(&self) -> mpsc::UnboundedReceiver<Value> {
        let (tx, rx) = mpsc::unbounded_channel();
        lock(&self.routes).proxy = Some(tx);
        rx
    }

    /// Whether a target session is the broker's own.
    pub fn is_own(&self, session: &str) -> bool {
        lock(&self.routes).own.contains(session)
    }

    fn message(id: u64, session: Option<&str>, method: &str, params: Value) -> Vec<u8> {
        let mut message = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            message["sessionId"] = session.into();
        }
        message.to_string().into_bytes()
    }

    async fn wait(
        &self,
        id: u64,
        method: &str,
        rx: oneshot::Receiver<Result<Value, String>>,
    ) -> Result<Value, String> {
        match tokio::time::timeout(CALL_TIMEOUT, rx).await {
            Ok(Ok(answer)) => answer.map_err(|why| format!("{method}: {why}")),
            Ok(Err(_)) => Err("the browser closed".to_owned()),
            Err(_) => {
                lock(&self.routes).waiting.remove(&id);
                Err(format!(
                    "{method}: no answer in {} s",
                    CALL_TIMEOUT.as_secs()
                ))
            }
        }
    }

    /// Sends `method` to the browser (`session` none) or a target session, and waits for its result.
    pub async fn call(
        &self,
        session: Option<&str>,
        method: &str,
        params: Value,
    ) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        lock(&self.routes).waiting.insert(id, Waiter::Broker(tx));
        if self
            .send
            .send(Self::message(id, session, method, params))
            .is_err()
        {
            lock(&self.routes).waiting.remove(&id);
            return Err("the browser closed".to_owned());
        }
        self.wait(id, method, rx).await
    }

    /// Attaches the broker to a target (flattened): the session is its own, hidden from the agent's driver.
    pub async fn attach(&self, target: &str) -> Result<String, String> {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        {
            let mut routes = lock(&self.routes);
            routes.attaching.entry(target.to_owned()).or_default();
            routes
                .waiting
                .insert(id, Waiter::Attach(target.to_owned(), tx));
        }
        let params = json!({ "targetId": target, "flatten": true });
        if self
            .send
            .send(Self::message(id, None, "Target.attachToTarget", params))
            .is_err()
        {
            let mut routes = lock(&self.routes);
            routes.waiting.remove(&id);
            routes.attaching.remove(target);
            return Err("the browser closed".to_owned());
        }
        let answer = match self.wait(id, "Target.attachToTarget", rx).await {
            Ok(answer) => answer,
            Err(why) => {
                // No answer named the broker's session: what was held is the driver's, and later attach events for
                // the page go to it as usual.
                lock(&self.routes).release(target);
                return Err(why);
            }
        };
        answer["sessionId"]
            .as_str()
            .map(str::to_owned)
            .ok_or_else(|| "Target.attachToTarget: no session".to_owned())
    }

    /// Sends `method` without waiting for its answer (a screencast frame's ack).
    pub fn post(&self, session: Option<&str>, method: &str, params: Value) {
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        let _ = self.send.send(Self::message(id, session, method, params));
    }

    /// Forwards one of the proxy client's commands under an id of the connection's own; its answer comes back on
    /// [`Cdp::proxy_events`] under the client's id. False once the browser has gone.
    pub fn forward(&self, mut message: Value) -> bool {
        let theirs = message.get("id").cloned().unwrap_or(Value::Null);
        let id = self.next.fetch_add(1, Ordering::Relaxed);
        message["id"] = id.into();
        lock(&self.routes).waiting.insert(id, Waiter::Proxy(theirs));
        if self.send.send(message.to_string().into_bytes()).is_err() {
            lock(&self.routes).waiting.remove(&id);
            return false;
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attached(target: &str, session: &str) -> Event {
        Event {
            method: "Target.attachedToTarget".into(),
            params: json!({ "sessionId": session, "targetInfo": { "targetId": target, "type": "page" } }),
            session_id: None,
        }
    }

    #[test]
    fn an_attach_that_got_no_answer_hands_what_it_held_to_the_driver_and_holds_nothing_after() {
        let mut routes = Routes::default();
        let (tx, mut proxy) = mpsc::unbounded_channel();
        routes.proxy = Some(tx);
        routes.attaching.insert("T1".into(), Vec::new());
        routes.event(attached("T1", "driver-1"));
        assert!(
            proxy.try_recv().is_err(),
            "held while the broker's attach is pending"
        );
        routes.release("T1");
        assert_eq!(proxy.try_recv().unwrap()["params"]["sessionId"], "driver-1");
        routes.event(attached("T1", "driver-2"));
        assert_eq!(
            proxy.try_recv().unwrap()["params"]["sessionId"],
            "driver-2",
            "not held any more"
        );
    }

    #[test]
    fn the_brokers_own_attach_stays_hidden_and_the_drivers_goes_through() {
        let mut routes = Routes::default();
        let (tx, mut proxy) = mpsc::unbounded_channel();
        routes.proxy = Some(tx);
        let (answer, _wait) = oneshot::channel();
        routes
            .waiting
            .insert(7, Waiter::Attach("T1".into(), answer));
        routes.attaching.insert("T1".into(), Vec::new());
        routes.event(attached("T1", "driver-1"));
        routes.event(attached("T1", "broker-1"));
        routes.answer(7, json!({ "id": 7, "result": { "sessionId": "broker-1" } }));
        assert_eq!(proxy.try_recv().unwrap()["params"]["sessionId"], "driver-1");
        assert!(proxy.try_recv().is_err());
        routes.event(Event {
            method: "Page.screencastFrame".into(),
            params: json!({}),
            session_id: Some("broker-1".into()),
        });
        assert!(
            proxy.try_recv().is_err(),
            "the broker's session's events stay the broker's"
        );
    }
}
