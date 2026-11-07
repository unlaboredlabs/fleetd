//! gzip for the JSON the hub answers over HTTP (/link/v1, /mcp), only when the request's Accept-Encoding offers it:
//! a client that doesn't ask gets the same bytes as before. Event streams and small answers stay as they are.
use axum::body::Body;
use axum::http::{HeaderMap, HeaderValue, header};
use axum::response::Response;
use flate2::Compression;
use flate2::write::GzEncoder;
use std::io::Write;

/// Below this a gzip header and trailer (18 bytes) and the extra work buy nothing.
const MIN_BYTES: usize = 1024;
/// The largest answer compressed here; anything bigger goes as it is (the hub's answers are far smaller).
const MAX_BYTES: usize = 64 * 1024 * 1024;

/// Whether an Accept-Encoding header offers gzip (`gzip`, `x-gzip` or `*`, with no `q=0`).
pub fn accepts_gzip(headers: &HeaderMap) -> bool {
    headers
        .get_all(header::ACCEPT_ENCODING)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(','))
        .any(|coding| {
            let mut parts = coding.split(';');
            let name = parts.next().unwrap_or("").trim();
            let refused = parts.any(|p| {
                p.trim()
                    .strip_prefix("q=")
                    .and_then(|q| q.trim().parse::<f32>().ok())
                    == Some(0.0)
            });
            !refused
                && (name.eq_ignore_ascii_case("gzip")
                    || name.eq_ignore_ascii_case("x-gzip")
                    || name == "*")
        })
}

/// `response` gzipped when the request offered gzip and it is a JSON answer worth it; else unchanged.
pub async fn negotiate(request: &HeaderMap, response: Response) -> Response {
    let json = response
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|t| t.starts_with("application/json"));
    if !json || response.headers().contains_key(header::CONTENT_ENCODING) {
        return response;
    }
    // Varies either way, so a cache between never hands a gzipped answer to a client that didn't ask.
    let (mut parts, body) = response.into_parts();
    parts
        .headers
        .append(header::VARY, HeaderValue::from_static("accept-encoding"));
    if !accepts_gzip(request) {
        return Response::from_parts(parts, body);
    }
    let Ok(bytes) = axum::body::to_bytes(body, MAX_BYTES).await else {
        return Response::from_parts(parts, Body::empty());
    };
    if bytes.len() < MIN_BYTES {
        return Response::from_parts(parts, Body::from(bytes));
    }
    let mut encoder = GzEncoder::new(Vec::with_capacity(bytes.len() / 4), Compression::fast());
    let gzipped = match encoder.write_all(&bytes).and_then(|()| encoder.finish()) {
        Ok(gzipped) => gzipped,
        Err(_) => return Response::from_parts(parts, Body::from(bytes)),
    };
    parts.headers.remove(header::CONTENT_LENGTH);
    parts
        .headers
        .insert(header::CONTENT_ENCODING, HeaderValue::from_static("gzip"));
    Response::from_parts(parts, Body::from(gzipped))
}

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::read::GzDecoder;
    use std::io::Read;

    fn offered(value: &str) -> HeaderMap {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::ACCEPT_ENCODING,
            HeaderValue::from_str(value).unwrap(),
        );
        headers
    }

    #[test]
    fn reads_what_accept_encoding_offers() {
        assert!(accepts_gzip(&offered("gzip")));
        assert!(accepts_gzip(&offered("br, GZIP;q=0.5")));
        assert!(accepts_gzip(&offered("*")));
        assert!(!accepts_gzip(&offered("gzip;q=0")));
        assert!(!accepts_gzip(&offered("br, deflate")));
        assert!(!accepts_gzip(&HeaderMap::new()));
    }

    async fn answered(request: &HeaderMap, value: serde_json::Value) -> (HeaderMap, Vec<u8>) {
        use axum::response::IntoResponse;
        let response = negotiate(request, axum::Json(value).into_response()).await;
        let (parts, body) = response.into_parts();
        let bytes = axum::body::to_bytes(body, usize::MAX).await.unwrap();
        (parts.headers, bytes.to_vec())
    }

    #[tokio::test]
    async fn gzips_a_large_json_answer_only_when_asked() {
        let big = serde_json::json!({ "events": vec!["machine.online devbox"; 200] });
        let plain = serde_json::to_vec(&big).unwrap();

        let (headers, body) = answered(&offered("gzip, br"), big.clone()).await;
        assert_eq!(headers[header::CONTENT_ENCODING], "gzip");
        assert_eq!(headers[header::VARY], "accept-encoding");
        assert!(
            body.len() * 10 < plain.len(),
            "{} of {}",
            body.len(),
            plain.len()
        );
        let mut inflated = Vec::new();
        GzDecoder::new(&body[..])
            .read_to_end(&mut inflated)
            .unwrap();
        assert_eq!(inflated, plain);

        // An older client offers nothing: the very same bytes as before.
        let (headers, body) = answered(&HeaderMap::new(), big).await;
        assert!(!headers.contains_key(header::CONTENT_ENCODING));
        assert_eq!(body, plain);

        // A small answer isn't worth it.
        let (headers, body) = answered(&offered("gzip"), serde_json::json!({ "ok": true })).await;
        assert!(!headers.contains_key(header::CONTENT_ENCODING));
        assert_eq!(body, br#"{"ok":true}"#);
    }

    #[tokio::test]
    async fn leaves_anything_but_json_alone() {
        let mut headers = offered("gzip");
        headers.insert(
            header::ACCEPT,
            HeaderValue::from_static("text/event-stream"),
        );
        let stream = Response::builder()
            .header(header::CONTENT_TYPE, "text/event-stream")
            .body(Body::from("data: x\n\n".repeat(500)))
            .unwrap();
        let out = negotiate(&headers, stream).await;
        assert!(!out.headers().contains_key(header::CONTENT_ENCODING));
    }
}
