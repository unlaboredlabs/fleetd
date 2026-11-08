//! A node link frame from the other end that doesn't decode (a newer peer's field, a value out of range): either end
//! refuses that frame alone, logs it by its tag, id, size and serde's error (never its payload), answers it when it
//! was a request, and keeps the link. One bad frame closing the whole link blipped every agent's stream on the
//! machine. Only a flood of them ([`BadFrames`]) ends the link: a peer that sends that much it can't be read is broken.

/// Undecodable frames one link takes within a minute; the next one ends it.
pub const BAD_FRAMES_PER_MINUTE: u32 = 20;

/// A link's undecodable frames, counted per minute.
#[derive(Debug, Default)]
pub struct BadFrames {
    since_ms: i64,
    count: u32,
}

impl BadFrames {
    /// Counts one at `now_ms` (any clock that doesn't go back): false once the minute's count is past the limit.
    pub fn take(&mut self, now_ms: i64) -> bool {
        if self.count == 0 || now_ms.saturating_sub(self.since_ms) >= 60_000 {
            self.since_ms = now_ms;
            self.count = 0;
        }
        self.count += 1;
        self.count <= BAD_FRAMES_PER_MINUTE
    }
}

/// What a frame that doesn't decode is logged and answered by: its `t`, its `id` and serde's error, each cut short.
#[derive(Debug, PartialEq, Eq)]
pub struct Undecodable {
    pub tag: String,
    /// A request's id, to answer it by; absent when it has none or one too long to be ours.
    pub id: Option<String>,
    pub error: String,
}

impl Undecodable {
    pub fn of(text: &str, error: &serde_json::Error) -> Self {
        let value = serde_json::from_str::<serde_json::Value>(text).ok();
        let field = |name: &str| value.as_ref()?.get(name)?.as_str().map(str::to_owned);
        Self {
            tag: field("t").map_or_else(|| "(none)".into(), |t| cut(&t, 64)),
            id: field("id").filter(|id| !id.is_empty() && id.len() <= 128),
            error: cut(&error.to_string(), 300),
        }
    }
}

fn cut(s: &str, max: usize) -> String {
    let mut end = s.len().min(max);
    while !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A frame that doesn't decode is known by its tag, its id and serde's words, never its payload.
    #[test]
    fn an_undecodable_frame_is_known_by_its_tag_id_and_error() {
        let text =
            r#"{"t":"machine_event","id":"r1","seq":"not a number","event":{"secret":"s3cret"}}"#;
        let e = serde_json::from_str::<fleetd_contracts::node_link::NodeToHub>(text).unwrap_err();
        let bad = Undecodable::of(text, &e);
        assert_eq!(bad.tag, "machine_event");
        assert_eq!(bad.id.as_deref(), Some("r1"));
        assert!(!bad.error.is_empty() && !bad.error.contains("s3cret"));
        let none = Undecodable::of("not json", &e);
        assert_eq!((none.tag.as_str(), none.id), ("(none)", None));
        let long = format!(
            r#"{{"t":"{}","id":"{}"}}"#,
            "x".repeat(500),
            "i".repeat(500)
        );
        let long = Undecodable::of(&long, &e);
        assert_eq!((long.tag.len(), long.id), (64, None));
    }

    /// Up to the limit a minute, each is refused alone; one more within the minute ends the link, and a new minute
    /// starts the count again.
    #[test]
    fn only_a_flood_of_bad_frames_within_a_minute_ends_the_link() {
        let mut bad = BadFrames::default();
        for i in 0..BAD_FRAMES_PER_MINUTE {
            assert!(bad.take(1_000 + i64::from(i)), "the {i}th bad frame");
        }
        assert!(!bad.take(30_000));
        let mut bad = BadFrames::default();
        for minute in 0..5 {
            for _ in 0..BAD_FRAMES_PER_MINUTE {
                assert!(bad.take(minute * 60_000));
            }
        }
    }
}
