//! The Screens page's pictures (`screen_thumbs`): while an app shows the page, every [`THUMB_EVERY_SECS`] the hub
//! takes one frame of each live screen and makes it small. It takes no capture of its own: it watches each screen as a
//! person's live view does, and its node answers a watch at once with the screen's newest frame, so the watch ends as
//! that frame lands. Each picture is made once, at most [`THUMB_SIDE`] pixels a side, and goes to every app showing the
//! page whose key may watch its screen. Nobody showing the page: no watch, nothing made.
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::STANDARD as B64;
use fleetd_contracts::browser::{
    BrowserFrame, BrowserSession, BrowserSessionId, ScreenThumb, THUMB_EVERY_SECS, THUMB_SIDE,
};
use fleetd_contracts::ids::{ProjectRef, Timestamp};
use fleetd_contracts::node_link::CAP_BROWSER;
use fleetd_contracts::prim::{Int, NonEmpty};
use futures_util::StreamExt;
use futures_util::stream::FuturesUnordered;
use tokio::sync::{broadcast, oneshot, watch};

use crate::hub::api::{Caller, Hub, allows};
use crate::hub::app_ws::outbox::Outbox;
use crate::hub::store::{StoreError, iso_ms, now_ms};
use fleetd_contracts::auth::Role;

/// How long a round waits for a screen's frame before it gives that screen up until the next.
const FRAME_WAIT: Duration = Duration::from_secs(5);
/// The pictures' JPEG quality.
const QUALITY: u8 = 70;
/// Pictures in flight to every app together; one this far behind gets each screen's next.
const PICTURES: usize = 32;

/// A picture, with the project its screen is for: who may see it.
#[derive(Clone, Debug)]
pub struct Picture {
    pub project_ref: ProjectRef,
    pub thumb: ScreenThumb,
}

pub struct Thumbs {
    /// App connections showing the page now.
    viewers: watch::Sender<usize>,
    /// Each live screen's newest picture.
    kept: Mutex<HashMap<BrowserSessionId, Arc<Picture>>>,
    /// The screens a round waits on, each for its next frame.
    wanted: Mutex<HashMap<BrowserSessionId, oneshot::Sender<BrowserFrame>>>,
    made: broadcast::Sender<Arc<Picture>>,
}

impl Default for Thumbs {
    fn default() -> Self {
        Self {
            viewers: watch::channel(0).0,
            kept: Mutex::default(),
            wanted: Mutex::default(),
            made: broadcast::channel(PICTURES).0,
        }
    }
}

/// One app's showing of the page; dropping it ends it.
pub struct Viewer {
    thumbs: std::sync::Weak<Thumbs>,
    pub pictures: broadcast::Receiver<Arc<Picture>>,
}

impl Drop for Viewer {
    fn drop(&mut self) {
        if let Some(thumbs) = self.thumbs.upgrade() {
            thumbs.viewers.send_modify(|n| *n = n.saturating_sub(1));
        }
    }
}

fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(std::sync::PoisonError::into_inner)
}

impl Thumbs {
    /// An app shows the page: the pictures there are now, and each new one from here on.
    pub fn view(self: &Arc<Self>) -> (Viewer, Vec<Arc<Picture>>) {
        let pictures = self.made.subscribe();
        self.viewers.send_modify(|n| *n += 1);
        let now = lock(&self.kept).values().cloned().collect();
        (
            Viewer {
                thumbs: Arc::downgrade(self),
                pictures,
            },
            now,
        )
    }

    pub fn viewers(&self) -> usize {
        *self.viewers.borrow()
    }

    /// A screen's frame as it reaches its watchers: the one a round waits for, if it does.
    pub fn offer(&self, frame: &BrowserFrame) {
        if let Some(wants) = lock(&self.wanted).remove(&frame.session_id) {
            let _ = wants.send(frame.clone());
        }
    }

    fn want(&self, id: &BrowserSessionId) -> oneshot::Receiver<BrowserFrame> {
        let (tx, rx) = oneshot::channel();
        lock(&self.wanted).insert(id.clone(), tx);
        rx
    }

    fn keep(&self, picture: Picture) {
        let picture = Arc::new(picture);
        lock(&self.kept).insert(picture.thumb.session_id.clone(), picture.clone());
        let _ = self.made.send(picture);
    }

    /// Forgets the pictures of screens no longer live.
    fn retain(&self, live: &[BrowserSession]) {
        lock(&self.kept).retain(|id, _| live.iter().any(|s| &s.session_id == id));
    }

    pub fn kept(&self, id: &BrowserSessionId) -> Option<Arc<Picture>> {
        lock(&self.kept).get(id).cloned()
    }
}

/// Every live screen.
pub fn live_sessions(hub: &Hub) -> Result<Vec<BrowserSession>, StoreError> {
    hub.db.with(|c| {
        let mut stmt = c.prepare("SELECT data FROM browser_sessions WHERE state = 'live'")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(0))?;
        let mut out = Vec::new();
        for data in rows {
            out.push(serde_json::from_str(&data?)?);
        }
        Ok(out)
    })
}

/// A frame made small: at most [`THUMB_SIDE`] a side, as a JPEG. None for one that doesn't decode.
pub fn shrink(frame: &BrowserFrame) -> Option<(Vec<u8>, u32, u32)> {
    let bytes = B64.decode(frame.jpeg_b64.as_str()).ok()?;
    let image = image::load_from_memory_with_format(&bytes, image::ImageFormat::Jpeg).ok()?;
    let small = if image.width() > THUMB_SIDE || image.height() > THUMB_SIDE {
        image.thumbnail(THUMB_SIDE, THUMB_SIDE)
    } else {
        image
    };
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, QUALITY)
        .encode_image(&small.to_rgb8())
        .ok()?;
    Some((out, small.width(), small.height()))
}

/// One round: a short watch of each live screen whose node can send its frames, each ended by its frame or by
/// [`FRAME_WAIT`], and the pictures made from them. Returns how many it made.
pub async fn round(hub: &Arc<Hub>) -> Result<usize, StoreError> {
    let thumbs = &hub.link.browser_live.thumbs;
    let live = live_sessions(hub)?;
    thumbs.retain(&live);
    let mut pending = FuturesUnordered::new();
    for session in live {
        let Ok(machine) = super::live::runs_on(hub, &session) else {
            continue;
        };
        if !hub.link.node_can(&machine, CAP_BROWSER) {
            continue;
        }
        let id = session.session_id.clone();
        let frame = thumbs.want(&id);
        let watching = hub.link.browser_live.watch(&hub.link, &machine, &id);
        let gave_up = hub.clock.sleep(FRAME_WAIT);
        pending.push(async move {
            let frame = tokio::select! {
                frame = frame => frame.ok(),
                () = gave_up => None,
            };
            // The watch ends here, with its frame: the node stops sending.
            drop(watching);
            frame.map(|f| (session.project_ref, f))
        });
    }
    let mut made = 0;
    while let Some(got) = pending.next().await {
        let Some((project_ref, frame)) = got else {
            continue;
        };
        let small = tokio::task::spawn_blocking(move || shrink(&frame).map(|s| (frame, s))).await;
        let Ok(Some((frame, (jpeg, width, height)))) = small else {
            continue;
        };
        thumbs.keep(Picture {
            project_ref,
            thumb: ScreenThumb {
                session_id: frame.session_id,
                jpeg_b64: NonEmpty::unchecked(B64.encode(jpeg)),
                width: Int::unchecked(i64::from(width)),
                height: Int::unchecked(i64::from(height)),
                at: Timestamp(iso_ms(now_ms(hub.clock.as_ref()))),
            },
        });
        made += 1;
    }
    lock(&thumbs.wanted).clear();
    Ok(made)
}

/// Whether `caller` may see a screen of `project`'s: it reads the project's machine, and another person's Navi's
/// screens are theirs alone (D215).
pub fn may_see(hub: &Hub, caller: &Caller, project: &ProjectRef) -> bool {
    allows(caller, Role::Read, Some(&project.machine_id))
        && crate::hub::navi::owner::may_use(&hub.db, caller, project).unwrap_or(false)
}

/// One app connection's showing of the page, until it is aborted: the pictures there are, then each new one, of the
/// screens `caller` may see, as `screen_thumb` frames.
pub async fn forward(hub: Arc<Hub>, caller: Caller, out: Outbox) {
    let (mut viewer, now) = hub.link.browser_live.thumbs.view();
    let mut seen: HashMap<ProjectRef, bool> = HashMap::new();
    let mut send = |picture: &Picture| -> bool {
        let ok = *seen
            .entry(picture.project_ref.clone())
            .or_insert_with(|| may_see(&hub, &caller, &picture.project_ref));
        if !ok {
            return true;
        }
        let mut frame = serde_json::to_value(&picture.thumb).unwrap_or_default();
        frame["t"] = "screen_thumb".into();
        out.push(frame.to_string())
    };
    for picture in &now {
        if !send(picture) {
            return;
        }
    }
    loop {
        match viewer.pictures.recv().await {
            Ok(picture) => {
                if !send(&picture) {
                    return;
                }
            }
            // Behind: each screen's next picture comes in its turn.
            Err(broadcast::error::RecvError::Lagged(_)) => {}
            Err(broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// A round every [`THUMB_EVERY_SECS`] while an app shows the page, none while none does; until the hub stops.
pub async fn run(hub: Arc<Hub>) {
    let mut viewers = hub.link.browser_live.thumbs.viewers.subscribe();
    loop {
        tokio::select! {
            () = hub.shutdown.wait() => return,
            shown = viewers.wait_for(|n| *n > 0) => if shown.is_err() { return },
        }
        if let Err(e) = round(&hub).await {
            tracing::warn!(error = %e, "screens' pictures not taken");
        }
        tokio::select! {
            () = hub.shutdown.wait() => return,
            () = hub.clock.sleep(Duration::from_secs(THUMB_EVERY_SECS)) => {}
        }
    }
}
