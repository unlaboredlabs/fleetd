//! Android and iOS sessions' live view and takeover, as browser sessions have them: the hub's `browser_watch`,
//! `browser_input` and `browser_control` for a session reach [`Router::from_hub`], which hands a browser session's to
//! its broker, an Android session's to [`Devices`] and an iOS one's to [`Simulators`]. A watched device's screen goes
//! out through a pump that turns each new frame (scrcpy's, or the simulator's screenshot loop) into a `browser_frame`
//! in the link's frame slot (newest only, as a browser's); a person's mouse and keys become one finger, a scroll, a key
//! or text.
use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::browser::{
    BrowserControl, BrowserControlTo, BrowserFrame, BrowserInput, BrowserSessionId, KeyAction,
    MouseAction, MouseButton,
};
use fleetd_contracts::node_link::{HubToNode, NodeToHub};
use fleetd_contracts::prim::{Int, NonEmpty};
use tokio::sync::watch;

use super::ios::Simulators;
use super::scrcpy::{Frame, Input, TouchAction};
use super::{Devices, Router};
use crate::node::browser::FrameSlot;
use crate::node::util::AbortOnDrop;
use crate::node::wire::to_json;

/// What live view needs of a kind of device session: Android's ([`Devices`]) and iOS's ([`Simulators`]).
pub trait Screens: Send + Sync {
    /// Whether a session of this id is live here.
    fn holds(&self, session: &str) -> bool;
    /// Its screen, as JPEG frames.
    fn frames(&self, session: &str) -> Option<watch::Receiver<Option<Frame>>>;
    /// Who drives it.
    fn control(&self, session: &str) -> Option<BrowserControl>;
    /// A person's input, while they have control.
    fn input(&self, session: &str, input: &Input) -> bool;
    /// Hands it to a person or back to the agent.
    fn set_control(
        &self,
        session: &str,
        control: BrowserControl,
        by: &str,
    ) -> Option<BrowserControl>;
}

macro_rules! screens {
    ($kind:ty) => {
        impl Screens for $kind {
            fn holds(&self, session: &str) -> bool {
                <$kind>::holds(self, session)
            }
            fn frames(&self, session: &str) -> Option<watch::Receiver<Option<Frame>>> {
                <$kind>::frames(self, session)
            }
            fn control(&self, session: &str) -> Option<BrowserControl> {
                <$kind>::control(self, session)
            }
            fn input(&self, session: &str, input: &Input) -> bool {
                <$kind>::input(self, session, input)
            }
            fn set_control(
                &self,
                session: &str,
                control: BrowserControl,
                by: &str,
            ) -> Option<BrowserControl> {
                <$kind>::set_control(self, session, control, by)
            }
        }
    };
}
screens!(Devices);
screens!(Simulators);

/// What the Router keeps for Android and iOS sessions' live view: the pump of each watched session, and which sessions
/// have a finger down (a move counts as a drag only then).
#[derive(Default)]
pub struct DeviceLive {
    pumps: Mutex<HashMap<String, AbortOnDrop>>,
    pressed: Mutex<HashSet<String>>,
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A device's screen frame as the hub's live view takes it.
pub fn browser_frame(
    session: &BrowserSessionId,
    frame: &Frame,
    control: BrowserControl,
) -> BrowserFrame {
    BrowserFrame {
        session_id: session.clone(),
        seq: frame.seq,
        jpeg_b64: NonEmpty::unchecked(B64.encode(frame.jpeg.as_slice())),
        width: Int::unchecked(i64::from(frame.width.max(1))),
        height: Int::unchecked(i64::from(frame.height.max(1))),
        url: None,
        control,
    }
}

/// Puts each new frame of `frames` into `slot` (the newest so far at once), until the session's stream ends.
pub async fn pump(
    session: BrowserSessionId,
    mut frames: watch::Receiver<Option<Frame>>,
    control: impl Fn() -> BrowserControl,
    slot: Arc<FrameSlot>,
) {
    loop {
        let frame = frames.borrow_and_update().clone();
        if let Some(frame) = frame {
            let out = browser_frame(&session, &frame, control());
            slot.replace(session.as_str(), to_json(&NodeToHub::BrowserFrame(out)));
        }
        if frames.changed().await.is_err() {
            return;
        }
    }
}

/// A person's input as the device takes it; None for what a touch screen has no use for (hovering, other buttons).
/// `pressed` says whether this session has a finger down, and changes with a press or a release.
pub fn device_input(input: &BrowserInput, pressed: &mut bool) -> Option<Input> {
    match input {
        BrowserInput::Mouse {
            action,
            x,
            y,
            button,
            delta_x,
            delta_y,
            ..
        } => {
            let (x, y) = (*x, *y);
            match action {
                MouseAction::Pressed if *button == MouseButton::Left => {
                    *pressed = true;
                    Some(Input::Touch {
                        action: TouchAction::Down,
                        x,
                        y,
                    })
                }
                MouseAction::Released if *pressed => {
                    *pressed = false;
                    Some(Input::Touch {
                        action: TouchAction::Up,
                        x,
                        y,
                    })
                }
                MouseAction::Moved if *pressed => Some(Input::Touch {
                    action: TouchAction::Move,
                    x,
                    y,
                }),
                MouseAction::Wheel => Some(Input::Scroll {
                    x,
                    y,
                    dx: *delta_x,
                    dy: *delta_y,
                }),
                _ => None,
            }
        }
        BrowserInput::Key {
            action,
            key,
            text,
            modifiers,
            ..
        } => {
            // A key that types goes as its text, once; its release then says nothing more.
            let typed = text.as_ref().map(|t| t.to_string()).or_else(|| {
                let one = key.as_str();
                (one.chars().count() == 1).then(|| one.to_owned())
            });
            let ctrl_or_meta = modifiers.get() & (2 | 4) != 0;
            match (typed, action) {
                (Some(typed), KeyAction::Down) if !ctrl_or_meta => Some(Input::Text(typed)),
                (Some(_), KeyAction::Up) if !ctrl_or_meta => None,
                _ => Some(Input::Key {
                    down: *action == KeyAction::Down,
                    key: key.to_string(),
                    modifiers: modifiers.get() as u32,
                }),
            }
        }
        BrowserInput::Text { text } => Some(Input::Text(text.to_string())),
    }
}

impl Router {
    /// A frame from the hub for a session: to the desktop sessions for a desktop one, to the browser broker for a
    /// browser session, to [`Devices`] for an Android one, to [`Simulators`] for an iOS one. Never blocks the link's
    /// loop.
    pub fn from_hub(&self, frame: HubToNode, slot: &Arc<FrameSlot>) {
        if self
            .desktops
            .as_ref()
            .is_some_and(|d| d.from_hub(&frame, slot))
        {
            return;
        }
        let session = match &frame {
            HubToNode::BrowserWatch(f) => f.session_id.clone(),
            HubToNode::BrowserInput(f) => f.session_id.clone(),
            HubToNode::BrowserControl(f) => f.session_id.clone(),
            _ => return,
        };
        if let Some(broker) = self.browser.as_ref().filter(|b| b.holds(&session)) {
            broker.from_hub(frame, slot);
            return;
        }
        let android = self
            .devices
            .clone()
            .map(|d| d as Arc<dyn Screens>)
            .filter(|d| d.holds(session.as_str()));
        let ios = || {
            self.ios
                .clone()
                .map(|i| i as Arc<dyn Screens>)
                .filter(|i| i.holds(session.as_str()))
        };
        let Some(devices) = android.or_else(ios) else {
            return;
        };
        let devices = &devices;
        match frame {
            HubToNode::BrowserWatch(watch) => {
                self.watch_device(devices, &session, watch.on.then(|| slot.clone()))
            }
            HubToNode::BrowserInput(input) => {
                let mut pressed = lock(&self.live.pressed);
                let mut down = pressed.contains(session.as_str());
                if let Some(input) = device_input(&input.input, &mut down)
                    && !devices.input(session.as_str(), &input)
                {
                    tracing::debug!(session = %session, "device input not delivered");
                }
                if down {
                    pressed.insert(session.to_string());
                } else {
                    pressed.remove(session.as_str());
                }
            }
            HubToNode::BrowserControl(control) => {
                let next = match (control.control, devices.control(session.as_str())) {
                    (BrowserControlTo::Human, _) => BrowserControl::Human,
                    (BrowserControlTo::Agent, Some(BrowserControl::Human)) => {
                        BrowserControl::HandingBack
                    }
                    // Already the agent's (or handing back): say so again, for the hub waiting on it.
                    (BrowserControlTo::Agent, Some(now)) => now,
                    (BrowserControlTo::Agent, None) => return,
                };
                lock(&self.live.pressed).remove(session.as_str());
                devices.set_control(session.as_str(), next, control.by.as_str());
            }
            _ => {}
        }
    }

    /// Starts or stops sending a device session's screen to the hub.
    fn watch_device(
        &self,
        devices: &Arc<dyn Screens>,
        session: &BrowserSessionId,
        slot: Option<Arc<FrameSlot>>,
    ) {
        let mut pumps = lock(&self.live.pumps);
        pumps.remove(session.as_str());
        let (Some(slot), Some(frames)) = (slot, devices.frames(session.as_str())) else {
            return;
        };
        let control = {
            let devices = Arc::downgrade(devices);
            let session = session.to_string();
            move || {
                devices
                    .upgrade()
                    .and_then(|d| d.control(&session))
                    .unwrap_or_default()
            }
        };
        pumps.insert(
            session.to_string(),
            AbortOnDrop(tokio::spawn(pump(session.clone(), frames, control, slot))),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    use std::time::Duration;

    fn input(value: Value) -> BrowserInput {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn the_mouse_is_one_finger_the_wheel_a_scroll_and_keys_keys_or_text() {
        let mut down = false;
        let mouse = |action: &str, button: &str| {
            input(
                json!({ "kind": "mouse", "action": action, "x": 10.0, "y": 20.0, "button": button }),
            )
        };
        assert_eq!(
            device_input(&mouse("moved", "none"), &mut down),
            None,
            "hovering is nothing on a touch screen"
        );
        assert_eq!(device_input(&mouse("pressed", "right"), &mut down), None);
        assert_eq!(
            device_input(&mouse("pressed", "left"), &mut down),
            Some(Input::Touch {
                action: TouchAction::Down,
                x: 10.0,
                y: 20.0
            })
        );
        assert!(down);
        assert_eq!(
            device_input(&mouse("moved", "left"), &mut down),
            Some(Input::Touch {
                action: TouchAction::Move,
                x: 10.0,
                y: 20.0
            })
        );
        assert_eq!(
            device_input(&mouse("released", "left"), &mut down),
            Some(Input::Touch {
                action: TouchAction::Up,
                x: 10.0,
                y: 20.0
            })
        );
        assert!(!down);
        assert_eq!(
            device_input(&mouse("released", "left"), &mut down),
            None,
            "no finger to lift"
        );
        let wheel = input(
            json!({ "kind": "mouse", "action": "wheel", "x": 5.0, "y": 6.0, "deltaY": 120.0 }),
        );
        assert_eq!(
            device_input(&wheel, &mut down),
            Some(Input::Scroll {
                x: 5.0,
                y: 6.0,
                dx: 0.0,
                dy: 120.0
            })
        );

        let key = |action: &str, key: &str, text: Option<&str>, modifiers: i64| {
            let mut v =
                json!({ "kind": "key", "action": action, "key": key, "modifiers": modifiers });
            if let Some(text) = text {
                v["text"] = text.into();
            }
            input(v)
        };
        assert_eq!(
            device_input(&key("down", "a", Some("a"), 0), &mut down),
            Some(Input::Text("a".into()))
        );
        assert_eq!(
            device_input(&key("up", "a", None, 0), &mut down),
            None,
            "typed once"
        );
        assert_eq!(
            device_input(&key("down", "Enter", None, 0), &mut down),
            Some(Input::Key {
                down: true,
                key: "Enter".into(),
                modifiers: 0
            })
        );
        assert_eq!(
            device_input(&key("up", "BrowserBack", None, 0), &mut down),
            Some(Input::Key {
                down: false,
                key: "BrowserBack".into(),
                modifiers: 0
            })
        );
        assert_eq!(
            device_input(&key("down", "a", None, 2), &mut down),
            Some(Input::Key {
                down: true,
                key: "a".into(),
                modifiers: 2
            }),
            "Ctrl+A is a key, not text"
        );
        let pasted = input(json!({ "kind": "text", "text": "hello there" }));
        assert_eq!(
            device_input(&pasted, &mut down),
            Some(Input::Text("hello there".into()))
        );
    }

    fn frame(seq: u64) -> Frame {
        Frame {
            seq,
            jpeg: Arc::new(vec![0xff, 0xd8, seq as u8]),
            width: 1080,
            height: 2400,
            at: Duration::from_millis(seq * 40),
        }
    }

    #[tokio::test]
    async fn a_watched_devices_screen_goes_to_the_link_newest_only_until_its_stream_ends() {
        let session = BrowserSessionId::unchecked("B0123456789abcdef0123456789abcdef");
        let (tx, rx) = watch::channel(Some(frame(1)));
        let slot = Arc::new(FrameSlot::default());
        let pumping = tokio::spawn(pump(
            session.clone(),
            rx,
            || BrowserControl::Human,
            slot.clone(),
        ));
        // The newest at once, as a browser session's watch starts.
        let first = tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if let Some(line) = slot.take().pop() {
                    return line;
                }
                slot.notify.notified().await;
            }
        })
        .await
        .unwrap();
        let first: Value = serde_json::from_str(&first).unwrap();
        assert_eq!(first["t"], "browser_frame");
        assert_eq!(first["sessionId"], session.as_str());
        assert_eq!(
            (
                first["seq"].as_u64(),
                first["width"].as_u64(),
                first["height"].as_u64()
            ),
            (Some(1), Some(1080), Some(2400))
        );
        assert_eq!(first["control"], "human");
        assert_eq!(
            B64.decode(first["jpegB64"].as_str().unwrap()).unwrap(),
            vec![0xff, 0xd8, 1]
        );
        // A link that falls behind holds only the newest.
        for seq in 2..=50 {
            tx.send(Some(frame(seq))).unwrap();
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
        let waiting = slot.take();
        assert_eq!(waiting.len(), 1);
        let newest: Value = serde_json::from_str(&waiting[0]).unwrap();
        assert_eq!(newest["seq"], 50);
        // The session went: its stream ends, and so does the pump.
        drop(tx);
        tokio::time::timeout(Duration::from_secs(5), pumping)
            .await
            .unwrap()
            .unwrap();
    }
}
