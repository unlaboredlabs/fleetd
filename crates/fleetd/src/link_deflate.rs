//! The node link's negotiated compression (`link_deflate`, fleetd-contracts node_link.rs): RFC 7692 permessage-deflate
//! done above the WebSocket, since neither tungstenite nor axum speaks the extension. Each side keeps one [`Deflater`]
//! for what it sends and one [`Inflater`] for what it receives, for the life of one link: the window carries over
//! between messages, so a frame shaped like the last costs a few bytes. A compressed frame goes as a Binary message; a
//! Text message is plain JSON and never touches either.
use flate2::{Compress, Compression, Decompress, FlushCompress, FlushDecompress, Status};

/// What RFC 7692 drops from each message's end, and the receiver puts back.
const TAIL: [u8; 4] = [0x00, 0x00, 0xff, 0xff];
/// Frames this short go as Text: a heartbeat ack or an empty reply gains nothing from a binary frame.
pub const MIN_DEFLATE_BYTES: usize = 64;

/// One direction's compressor.
pub struct Deflater {
    stream: Compress,
}

impl Default for Deflater {
    fn default() -> Self {
        // Level 3: within a few percent of 6 on JSON, at a fraction of its CPU, on a busy node's every frame.
        Self {
            stream: Compress::new(Compression::new(3), false),
        }
    }
}

impl Deflater {
    /// `text` as one message's deflate data, its sync flush's tail removed.
    pub fn deflate(&mut self, text: &str) -> Vec<u8> {
        let input = text.as_bytes();
        let mut out = Vec::with_capacity(input.len() / 4 + 64);
        let mut read = 0;
        loop {
            if out.len() == out.capacity() {
                out.reserve(out.capacity().max(256));
            }
            let before = self.stream.total_in();
            // Errors only on a misused stream, which this never is.
            let _ = self
                .stream
                .compress_vec(&input[read..], &mut out, FlushCompress::Sync);
            read += (self.stream.total_in() - before) as usize;
            // Done once all input is in and the flush fit: output space left over means nothing is pending.
            if read == input.len() && out.len() < out.capacity() {
                break;
            }
        }
        if out.ends_with(&TAIL) {
            out.truncate(out.len() - TAIL.len());
        }
        out
    }
}

/// One direction's decompressor.
pub struct Inflater {
    stream: Decompress,
}

impl Default for Inflater {
    fn default() -> Self {
        Self {
            stream: Decompress::new(false),
        }
    }
}

impl Inflater {
    /// One message's JSON text, or why it can't be read: corrupt data, not UTF-8, or past `max` bytes (the link's
    /// frame cap, so a small frame can't inflate to fill the receiver's memory). Any error ends the link: the stream's
    /// window is lost with it.
    pub fn inflate(&mut self, data: &[u8], max: usize) -> Result<String, String> {
        let mut input = Vec::with_capacity(data.len() + TAIL.len());
        input.extend_from_slice(data);
        input.extend_from_slice(&TAIL);
        let mut out = Vec::with_capacity((data.len() * 4).clamp(256, max.max(256)));
        let mut read = 0;
        loop {
            if out.len() == out.capacity() {
                if out.len() >= max {
                    return Err(format!("a compressed frame inflates past {max} bytes"));
                }
                out.reserve(out.capacity().min(max - out.len()).max(256));
            }
            let before = self.stream.total_in();
            let status = self
                .stream
                .decompress_vec(&input[read..], &mut out, FlushDecompress::Sync)
                .map_err(|e| format!("a compressed frame does not inflate: {e}"))?;
            read += (self.stream.total_in() - before) as usize;
            if out.len() > max {
                return Err(format!("a compressed frame inflates past {max} bytes"));
            }
            match status {
                Status::StreamEnd => break,
                _ if read == input.len() && out.len() < out.capacity() => break,
                Status::BufError if read == input.len() => break,
                _ => {}
            }
        }
        String::from_utf8(out).map_err(|_| "a compressed frame is not UTF-8".to_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What one side deflates, the other inflates, message after message on the same streams.
    #[test]
    fn frames_round_trip_on_one_stream() {
        let (mut d, mut i) = (Deflater::default(), Inflater::default());
        let frames = [
            r#"{"t":"hb","at":"2026-11-07T10:00:00Z"}"#.to_owned(),
            String::new(),
            "é∂🙂".repeat(5000),
            serde_json::json!({ "t": "thread_event", "event": { "item": "x".repeat(300_000) } })
                .to_string(),
            r#"{"t":"hb","at":"2026-11-07T10:00:15Z"}"#.to_owned(),
        ];
        for frame in &frames {
            let data = d.deflate(frame);
            assert!(!data.ends_with(&TAIL));
            assert_eq!(&i.inflate(&data, 1 << 20).unwrap(), frame);
        }
    }

    /// The window carries over: a frame shaped like the last costs a fraction of its first send.
    #[test]
    fn a_repeated_frame_costs_a_few_bytes() {
        let mut d = Deflater::default();
        let frame = serde_json::json!({ "t": "heartbeat", "at": "2026-11-07T10:00:00Z",
            "load": { "cpu": 0.31, "memory": 0.52, "disk": 0.4, "agents": 3, "limits": [] } })
        .to_string();
        let first = d.deflate(&frame).len();
        let second = d.deflate(&frame).len();
        assert!(first < frame.len(), "{first} of {}", frame.len());
        assert!(second * 4 < first, "{second} bytes for a repeat of {first}");
    }

    /// It is the RFC's own framing: a frame from a stock permessage-deflate stream (flate2's raw writer, sync-flushed,
    /// tail removed) inflates here, so either side may use any conforming deflater.
    #[test]
    fn a_frame_from_another_deflate_stream_inflates() {
        use std::io::Write;
        let mut w = flate2::write::DeflateEncoder::new(Vec::new(), Compression::best());
        w.write_all(br#"{"t":"spans_ack","upto":7}"#).unwrap();
        w.flush().unwrap();
        let mut data = w.get_ref().clone();
        assert!(data.ends_with(&TAIL));
        data.truncate(data.len() - TAIL.len());
        assert_eq!(
            Inflater::default().inflate(&data, 1024).unwrap(),
            r#"{"t":"spans_ack","upto":7}"#
        );
    }

    /// A small frame that inflates past the cap, or isn't deflate at all, is refused rather than read.
    #[test]
    fn a_bomb_or_garbage_is_refused() {
        let bomb = Deflater::default().deflate(&"a".repeat(10 << 20));
        assert!(bomb.len() < 64 << 10);
        let err = Inflater::default().inflate(&bomb, 1 << 20).unwrap_err();
        assert!(err.contains("past"), "{err}");
        assert!(Inflater::default().inflate(&[0xff; 32], 1024).is_err());
    }
}
