//! A watched screen's frames to one app connection (`browser_frame`s of `browser_watch`). The newest waits in a
//! one-frame slot, so a frame the socket hasn't taken is replaced, never queued. A client that acks them (`frame_acks`)
//! is also paced: the socket and the network buffer whatever they are given, so without acks a 1 Mbit/s link holds
//! seconds of old screens between the hub and the person. With them the hub keeps about two round trips of frames in
//! flight (at least one frame, so one bigger than that goes alone), timing the round trip with a ping sent while
//! nothing is in flight and the link's rate from the acks. When frames have to wait for room it tells the screen's node
//! what the link carries (`browser_watch`'s `kbps`), so its encoder sends less. A link that
//! stops waiting is offered half again as much every [`PROBE_EVERY`], until it is no limit at all. A client that draws
//! only so many frames a second (`browser_watch`'s `fps`, the phone's 12) is sent no more than it draws.
use std::collections::VecDeque;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tokio::sync::Notify;

/// One `browser_frame`, ready for the socket.
pub struct Outgoing {
    pub text: String,
    pub seq: u64,
    /// The frame's JPEG bytes: what the encoder makes, and what a budget is counted in.
    pub bytes: usize,
}

/// The newest frame waiting for the socket.
#[derive(Default)]
pub struct ScreenSlot {
    frame: Mutex<Option<Outgoing>>,
    pub notify: Notify,
}

impl ScreenSlot {
    fn lock(&self) -> std::sync::MutexGuard<'_, Option<Outgoing>> {
        self.frame
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn pending(&self) -> bool {
        self.lock().is_some()
    }

    pub fn take(&self) -> Option<Outgoing> {
        self.lock().take()
    }

    /// Puts a frame in the slot in place of one not yet sent: only the newest goes out.
    pub fn replace(&self, frame: Outgoing) {
        *self.lock() = Some(frame);
        self.notify.notify_one();
    }

    /// Drops a frame of a watch that was replaced.
    pub fn clear(&self) {
        self.lock().take();
    }
}

/// The next frame goes once the link has this many round trips' worth left of those in flight: it arrives as they
/// end, so the link stays busy and a frame waits behind at most this much of others. Two, not one, as the rate is
/// measured from what the screen sends, which may be less than the link could carry.
const ROUND_TRIPS: u32 = 2;
/// The link's rate is the best of the samples this recent, its round trip the least.
const RATE_WINDOW: Duration = Duration::from_secs(10);
/// A frame waited for room this recently: the link is full.
const FULL_FOR: Duration = Duration::from_secs(2);
/// A limit with no frame waiting for this long is raised by [`PROBE_GAIN`].
pub const PROBE_EVERY: Duration = Duration::from_secs(10);
const PROBE_GAIN: f64 = 1.5;
/// A limit above this is no limit.
const CEILING_KBPS: f64 = 50_000.0;
/// An unacked frame this old: the client stopped acking (or the link is gone), so the window opens again.
const STALL: Duration = Duration::from_secs(15);
/// The least time between round trip pings.
const PING_EVERY: Duration = Duration::from_secs(1);
/// The payload of the hub's round trip ping, which every WebSocket client answers with a pong.
pub const PING: &[u8] = b"pace";

struct Sent {
    seq: u64,
    at: Instant,
    bytes: usize,
    /// Bytes acked when it went out, and since when the link was busy with what was in flight then (its own going out,
    /// if nothing was): what is delivered by its ack, over the time since, is a rate sample.
    delivered: u64,
    busy_since: Instant,
    /// `busy_since` is an ack's time, not a frame's going out: no round trip lies between it and the next ack.
    from_ack: bool,
}

/// One connection's pacing of an acked watch.
#[derive(Default)]
pub struct Pace {
    in_flight: VecDeque<Sent>,
    delivered: u64,
    /// Rate samples, bytes per second, and round trips, each with when it was taken.
    rates: VecDeque<(Instant, f64)>,
    rtts: VecDeque<(Instant, Duration)>,
    /// The round trip ping on its way, sent with nothing in flight: its pong times the link's own round trip.
    ping_at: Option<Instant>,
    pinged: Option<Instant>,
    waited_at: Option<Instant>,
    acked_at: Option<Instant>,
    /// The link's limit as last told, bytes per second, and when it was set or raised.
    limit: Option<(f64, Instant)>,
    /// The least time between frames, as the client draws them, and when the last went.
    gap: Option<Duration>,
    last: Option<Instant>,
}

fn trim<T>(samples: &mut VecDeque<(Instant, T)>, now: Instant) {
    while samples.len() > 1
        && samples
            .front()
            .is_some_and(|(at, _)| now.duration_since(*at) > RATE_WINDOW)
    {
        samples.pop_front();
    }
}

impl Pace {
    /// A watch whose client draws at most `fps` frames a second, if it says.
    pub fn new(fps: Option<u32>) -> Self {
        Self {
            gap: fps.map(|f| Duration::from_secs(1) / f.max(1)),
            ..Self::default()
        }
    }

    /// When the next frame may go, if not now: the client draws no more often.
    pub fn not_before(&self, now: Instant) -> Option<Instant> {
        let next = self.last? + self.gap?;
        (next > now).then_some(next)
    }

    fn rate(&self) -> f64 {
        self.rates.iter().map(|(_, r)| *r).fold(0.0, f64::max)
    }

    fn rtt(&self) -> Option<Duration> {
        self.rtts.iter().map(|(_, r)| *r).min()
    }

    /// Whether a frame may go now: `Ok`, or not before `Err(Some(at))` (or an ack), or `Err(None)` not before an ack.
    /// The next frame goes as the link has [`ROUND_TRIPS`] round trips' worth left of those in flight.
    pub fn room(&mut self, now: Instant) -> Result<(), Option<Instant>> {
        if self
            .in_flight
            .front()
            .is_some_and(|s| now.duration_since(s.at) > STALL)
        {
            self.in_flight.clear();
        }
        let Some(oldest) = self.in_flight.front() else {
            return Ok(());
        };
        let rate = self.rate();
        let Some(rtt) = self.rtt().filter(|_| rate > 0.0) else {
            // Until the first pong and ack, one more: a far link's first round trip isn't spent on one frame.
            return if self.in_flight.len() < 2 {
                Ok(())
            } else {
                Err(None)
            };
        };
        let (busy_since, _) = self.busy_since().unwrap_or((oldest.at, false));
        let in_flight: usize = self.in_flight.iter().map(|s| s.bytes).sum();
        let work = Duration::from_secs_f64(in_flight as f64 / rate);
        let at = busy_since + work.saturating_sub(rtt * ROUND_TRIPS);
        if at <= now { Ok(()) } else { Err(Some(at)) }
    }

    /// A frame is ready and [`Self::room`] said no. Before the link's round trip and rate are known, that says nothing
    /// of it.
    pub fn waited(&mut self, now: Instant) {
        if self.rtt().is_some() && self.rate() > 0.0 {
            self.waited_at = Some(now);
        }
    }

    /// Whether to send a round trip ping ([`PING`]) before the next frame: nothing is in flight, so its pong comes back
    /// in a bare round trip.
    pub fn ping(&mut self, now: Instant) -> bool {
        let due = self.in_flight.is_empty()
            && self.ping_at.is_none()
            && self
                .pinged
                .is_none_or(|p| now.duration_since(p) >= PING_EVERY);
        if due {
            self.ping_at = Some(now);
            self.pinged = Some(now);
        }
        due
    }

    /// The pong of [`Self::ping`]'s ping.
    pub fn pong(&mut self, now: Instant) {
        if let Some(at) = self.ping_at.take() {
            self.rtts.push_back((now, now.duration_since(at)));
            trim(&mut self.rtts, now);
        }
    }

    pub fn sent(&mut self, seq: u64, bytes: usize, now: Instant) {
        self.last = Some(now);
        let (busy_since, from_ack) = self.busy_since().unwrap_or((now, false));
        self.in_flight.push_back(Sent {
            seq,
            at: now,
            bytes,
            delivered: self.delivered,
            busy_since,
            from_ack,
        });
    }

    /// Since when the link has been busy with what is in flight: the oldest's going out, or the last ack if later (and
    /// whether it was the ack).
    fn busy_since(&self) -> Option<(Instant, bool)> {
        let oldest = self.in_flight.front()?.at;
        Some(match self.acked_at {
            Some(a) if a > oldest => (a, true),
            _ => (oldest, false),
        })
    }

    /// The client got frame `seq`, and so every frame sent before it.
    pub fn acked(&mut self, seq: u64, now: Instant) {
        let Some(at) = self.in_flight.iter().position(|s| s.seq == seq) else {
            return;
        };
        let rtt = self.rtt().unwrap_or_default();
        self.acked_at = Some(now);
        for sent in self.in_flight.drain(..=at) {
            self.delivered += sent.bytes as u64;
            // What was delivered since it went, over the time the link was busy with it: the link's rate. Timed from a
            // frame's going out, that time holds a round trip too, which isn't the link's; at most a quarter of it is
            // counted as round trip, so a jittery one can't make a slow link look fast.
            let took = now.duration_since(sent.busy_since);
            let moving = if sent.from_ack {
                took
            } else {
                took.saturating_sub(rtt).max(took / 4)
            };
            let sample = (self.delivered - sent.delivered) as f64 / moving.as_secs_f64().max(0.001);
            self.rates.push_back((now, sample));
        }
        trim(&mut self.rates, now);
        let rate = self.rate();
        let full = self
            .waited_at
            .is_some_and(|w| now.duration_since(w) < FULL_FOR);
        if full {
            self.limit = (rate * 8.0 / 1000.0 < CEILING_KBPS).then_some((rate, now));
        } else if let Some((limit, since)) = self.limit
            && now.duration_since(since) >= PROBE_EVERY
        {
            let raised = limit * PROBE_GAIN;
            self.limit = (raised * 8.0 / 1000.0 < CEILING_KBPS).then_some((raised, now));
        }
    }

    /// What the link carries, in kbit/s of JPEG, while frames have had to wait for it; `None` while it keeps up.
    pub fn kbps(&self) -> Option<u32> {
        self.limit
            .map(|(rate, _)| (rate * 8.0 / 1000.0).round().max(1.0) as u32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME: usize = 100_000;

    /// A link of `bytes_per_sec` and `rtt`, fed a frame every `every` for `secs`: the frames that went, the oldest a
    /// frame was when acked after the first 5 s, and the limit at the end.
    fn run(
        bytes_per_sec: f64,
        rtt: Duration,
        every: Duration,
        secs: u64,
    ) -> (usize, Duration, Option<u32>) {
        run_with(bytes_per_sec, rtt, every, secs, FRAME)
    }

    fn run_with(
        bytes_per_sec: f64,
        rtt: Duration,
        every: Duration,
        secs: u64,
        frame: usize,
    ) -> (usize, Duration, Option<u32>) {
        let start = Instant::now();
        let mut pace = Pace::default();
        let mut now = start;
        let mut wire_free = start;
        // Acks (and the pong, seq 0), as they reach the hub, with when their frame was made.
        let mut acks: Vec<(Instant, u64, Instant)> = Vec::new();
        let mut next_frame = start;
        let mut waiting: Option<(u64, Instant)> = None;
        let (mut seq, mut went, mut oldest) = (0, 0, Duration::ZERO);
        let tick = Duration::from_millis(5);
        while now < start + Duration::from_secs(secs) {
            acks.sort_by_key(|a| a.0);
            while acks.first().is_some_and(|(at, _, _)| *at <= now) {
                let (_, s, made) = acks.remove(0);
                if s == 0 {
                    pace.pong(now);
                    continue;
                }
                pace.acked(s, now);
                if now > start + Duration::from_secs(5) {
                    oldest = oldest.max(now - made);
                }
            }
            if now >= next_frame {
                seq += 1;
                waiting = Some((seq, now));
                next_frame += every;
            }
            if let Some((s, made)) = waiting {
                if pace.room(now).is_ok() {
                    if pace.ping(now) {
                        acks.push((wire_free.max(now) + rtt, 0, now));
                    }
                    pace.sent(s, frame, now);
                    wire_free =
                        wire_free.max(now) + Duration::from_secs_f64(frame as f64 / bytes_per_sec);
                    acks.push((wire_free + rtt, s, made));
                    waiting = None;
                    went += 1;
                } else {
                    pace.waited(now);
                }
            }
            now += tick;
        }
        (went, oldest, pace.kbps())
    }

    #[test]
    fn a_slow_link_sends_a_big_frame_alone_and_says_what_it_carries() {
        // 1 Mbit/s, 300 ms: a 100 KB frame takes 0.8 s; 10 frames a second are offered.
        let (went, oldest, kbps) = run(
            125_000.0,
            Duration::from_millis(300),
            Duration::from_millis(100),
            30,
        );
        assert!((32..=40).contains(&went), "what the link carries: {went}");
        assert!(
            oldest < Duration::from_millis(1700),
            "a frame's time and two round trips, not two frames': {oldest:?}"
        );
        let kbps = kbps.expect("a full link has a limit");
        assert!((800..=1100).contains(&kbps), "about 1000 kbit/s: {kbps}");
    }

    #[test]
    fn a_normal_link_stays_busy_with_little_queued() {
        // 20 Mbit/s, 40 ms, 240 KB frames offered 30 a second: about 10 a second fit.
        let (went, oldest, kbps) = run_with(
            2_500_000.0,
            Duration::from_millis(40),
            Duration::from_millis(33),
            30,
            240_000,
        );
        assert!(went >= 280, "the link's worth: {went}");
        assert!(oldest < Duration::from_millis(300), "{oldest:?}");
        let kbps = kbps.expect("a full link has a limit");
        assert!(
            (16_000..=22_000).contains(&kbps),
            "about 20000 kbit/s: {kbps}"
        );
    }

    #[test]
    fn a_fast_far_link_fills_its_round_trips_and_sets_no_limit() {
        // 100 Mbit/s, 300 ms, 10 frames a second: the window grows past two to keep up.
        let (went, oldest, kbps) = run(
            12_500_000.0,
            Duration::from_millis(300),
            Duration::from_millis(100),
            30,
        );
        assert!(went >= 295, "every frame goes: {went}");
        assert!(oldest < Duration::from_millis(400), "{oldest:?}");
        assert_eq!(kbps, None);
    }

    #[test]
    fn a_limit_is_raised_once_frames_stop_waiting() {
        let mut pace = Pace::default();
        let t = Instant::now();
        pace.limit = Some((50_000.0, t));
        pace.sent(1, FRAME, t);
        pace.acked(1, t + Duration::from_secs(11));
        assert_eq!(pace.kbps(), Some(600), "half again as much");
    }

    #[test]
    fn a_client_that_draws_12_a_second_is_sent_no_more() {
        let mut pace = Pace::new(Some(12));
        let t = Instant::now();
        assert_eq!(pace.not_before(t), None);
        pace.sent(1, FRAME, t);
        pace.acked(1, t + Duration::from_millis(10));
        let gap = Duration::from_secs(1) / 12;
        assert_eq!(
            pace.not_before(t + Duration::from_millis(20)),
            Some(t + gap)
        );
        assert_eq!(pace.not_before(t + gap), None);
        assert_eq!(Pace::new(None).not_before(t), None);
    }

    #[test]
    fn a_round_trip_is_timed_only_with_nothing_in_flight_and_its_pong_alone() {
        let mut pace = Pace::default();
        let t = Instant::now();
        assert!(pace.ping(t));
        pace.sent(1, FRAME, t);
        // Another ping is not due while one is out, nor with a frame in flight.
        assert!(!pace.ping(t + Duration::from_secs(2)));
        pace.pong(t + Duration::from_millis(300));
        pace.pong(t + Duration::from_millis(900));
        assert_eq!(pace.rtt(), Some(Duration::from_millis(300)));
        assert!(
            !pace.ping(t + Duration::from_secs(2)),
            "a frame is in flight"
        );
        pace.acked(1, t + Duration::from_millis(1100));
        assert!(
            !pace.ping(t + Duration::from_millis(1100) - Duration::from_millis(200)),
            "not again within a second"
        );
        assert!(pace.ping(t + Duration::from_secs(2)));
    }

    #[test]
    fn a_client_that_stops_acking_is_not_waited_on_for_ever() {
        let mut pace = Pace::default();
        let t = Instant::now();
        pace.sent(1, FRAME, t);
        pace.sent(2, FRAME, t);
        assert_eq!(
            pace.room(t + Duration::from_secs(1)),
            Err(None),
            "two in flight before a round trip is known"
        );
        assert_eq!(pace.room(t + STALL + Duration::from_secs(1)), Ok(()));
    }

    #[test]
    fn an_ack_covers_the_frames_before_it_and_an_unknown_one_nothing() {
        let mut pace = Pace::default();
        let t = Instant::now();
        pace.sent(4, FRAME, t);
        pace.sent(5, FRAME, t);
        pace.acked(9, t);
        assert_eq!(pace.in_flight.len(), 2);
        pace.acked(5, t + Duration::from_millis(50));
        assert!(pace.in_flight.is_empty());
    }
}
