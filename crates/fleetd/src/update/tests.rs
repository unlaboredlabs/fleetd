//! The update core against a fake release feed and a fake runner: a failed download or a checksum mismatch changes
//! nothing, and a new build that doesn't come up healthy is put back.
use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::sync::Mutex;
use std::sync::atomic::{AtomicI64, Ordering};
use std::time::Duration;

use fleetd_contracts::mcp::{UpdateStage, UpdateState};

use super::finish::{Health, Plan, Ports, Verdict, finish};
use super::service::{Service, services_in, unit_affixes};
use super::*;

/// A release feed in memory: `SHA256SUMS` over whatever assets it holds, unless a test says otherwise.
#[derive(Default)]
pub struct FakeFeed {
    pub files: Mutex<HashMap<String, Vec<u8>>>,
}

impl FakeFeed {
    pub fn with(assets: &[(&str, &[u8])], release: &str) -> Self {
        let mut files: HashMap<String, Vec<u8>> = assets
            .iter()
            .map(|(n, b)| ((*n).to_owned(), b.to_vec()))
            .collect();
        let sums: String = assets
            .iter()
            .map(|(n, b)| format!("{}  {n}\n", sha256_hex(b)))
            .collect();
        files.insert("SHA256SUMS".into(), sums.into_bytes());
        files.insert("release.json".into(), release.as_bytes().to_vec());
        Self {
            files: Mutex::new(files),
        }
    }
}

impl Feed for FakeFeed {
    fn get<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Vec<u8>, String>> {
        let found = self.files.lock().unwrap().get(name).cloned();
        Box::pin(async move { found.ok_or_else(|| format!("GET {name}: 404 Not Found")) })
    }
}

#[tokio::test]
async fn a_download_is_checked_against_the_releases_sums() {
    let feed = FakeFeed::with(&[("fleetd-linux-x64", b"new build")], "{}");
    assert_eq!(
        verified(&feed, "fleetd-linux-x64").await.unwrap(),
        b"new build"
    );

    let missing = verified(&feed, "fleetd-darwin-arm64").await.unwrap_err();
    assert_eq!(missing.stage, UpdateStage::Download);

    feed.files
        .lock()
        .unwrap()
        .insert("fleetd-linux-x64".into(), b"tampered".to_vec());
    let mismatch = verified(&feed, "fleetd-linux-x64").await.unwrap_err();
    assert_eq!(mismatch.stage, UpdateStage::Checksum);
    assert!(
        mismatch.message.ends_with("nothing was changed"),
        "{mismatch}"
    );

    feed.files.lock().unwrap().remove("SHA256SUMS");
    let offline = verified(&feed, "fleetd-linux-x64").await.unwrap_err();
    assert_eq!(offline.stage, UpdateStage::Download);
}

/// A feed that hands builds out only as a stream of small chunks, and breaks off after `breaks_after` of them when set.
struct Chunked {
    feed: FakeFeed,
    breaks_after: Option<usize>,
}

impl Feed for Chunked {
    fn get<'a>(&'a self, name: &'a str) -> BoxFuture<'a, Result<Vec<u8>, String>> {
        Box::pin(async move {
            match name {
                "SHA256SUMS" | "release.json" => self.feed.get(name).await,
                _ => Err(format!("`{name}` was asked for whole")),
            }
        })
    }

    fn stream<'a>(
        &'a self,
        name: &'a str,
        sink: &'a mut Sink<'_>,
    ) -> BoxFuture<'a, Result<(), String>> {
        Box::pin(async move {
            let bytes = self.feed.get(name).await?;
            for (n, chunk) in bytes.chunks(3).enumerate() {
                if self.breaks_after == Some(n) {
                    return Err("connection reset".into());
                }
                sink(chunk)?;
            }
            Ok(())
        })
    }
}

fn chunked(build: &[u8]) -> Chunked {
    Chunked {
        feed: FakeFeed::with(&[("fleetd-linux-x64", build)], "{}"),
        breaks_after: None,
    }
}

/// The files in `dir`, sorted.
fn names(dir: &Path) -> Vec<String> {
    let mut names: Vec<String> = fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[tokio::test]
async fn a_build_streams_into_its_file_hashed_on_the_way() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("update/fleetd.next");
    let feed = chunked(b"a new build, in many pieces");
    verified_to(&feed, "fleetd-linux-x64", &path).await.unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"a new build, in many pieces");
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert_eq!(names(path.parent().unwrap()), ["fleetd.next"]);

    let sums = sums(&feed).await.unwrap();
    assert!(is_build(&path, &sums, "fleetd-linux-x64"));
    assert_eq!(
        file_sha256_hex(&path).unwrap(),
        sha256_hex(b"a new build, in many pieces")
    );

    fs::write(&path, b"stale").unwrap();
    assert!(!is_build(&path, &sums, "fleetd-linux-x64"));
    assert!(!is_build(
        &dir.path().join("absent"),
        &sums,
        "fleetd-linux-x64"
    ));
    checked_to(&feed, &sums, "fleetd-linux-x64", &path)
        .await
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"a new build, in many pieces");
}

#[tokio::test]
async fn a_streamed_build_that_doesnt_match_the_sums_is_deleted_and_refused() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fleetd");
    fs::write(&path, b"old").unwrap();
    let feed = chunked(b"new build");
    feed.feed
        .files
        .lock()
        .unwrap()
        .insert("fleetd-linux-x64".into(), b"tampered build".to_vec());

    let mismatch = verified_to(&feed, "fleetd-linux-x64", &path)
        .await
        .unwrap_err();
    assert_eq!(mismatch.stage, UpdateStage::Checksum);
    assert!(
        mismatch.message.ends_with("nothing was changed"),
        "{mismatch}"
    );
    assert_eq!(fs::read(&path).unwrap(), b"old");
    assert_eq!(names(dir.path()), ["fleetd"], "the partial file is gone");

    let sums = sums(&feed).await.unwrap();
    let mismatch = checked_to(&feed, &sums, "fleetd-linux-x64", &path)
        .await
        .unwrap_err();
    assert_eq!(mismatch.stage, UpdateStage::Checksum);
    assert_eq!(names(dir.path()), ["fleetd"]);

    let missing = verified_to(&feed, "fleetd-darwin-arm64", &path)
        .await
        .unwrap_err();
    assert_eq!(missing.stage, UpdateStage::Download);
    assert_eq!(names(dir.path()), ["fleetd"]);
}

/// `bytes` packed as publish.sh packs a build (`xz --format=lzma`).
fn packed(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    lzma_rs::lzma_compress(&mut &bytes[..], &mut out).unwrap();
    out
}

/// A release with a build's packed copy beside it: SHA256SUMS lists both, as publish.sh writes it.
fn with_packed(build: &[u8]) -> Chunked {
    let feed = chunked(build);
    feed.feed
        .files
        .lock()
        .unwrap()
        .insert("fleetd-linux-x64.lzma".into(), packed(build));
    let sums = format!(
        "{}  fleetd-linux-x64\n{}  fleetd-linux-x64.lzma\n",
        sha256_hex(build),
        sha256_hex(&packed(build))
    );
    feed.feed
        .files
        .lock()
        .unwrap()
        .insert("SHA256SUMS".into(), sums.into_bytes());
    feed
}

#[tokio::test]
async fn a_release_with_a_packed_build_is_downloaded_packed_and_lands_unpacked() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fleetd.next");
    let build: Vec<u8> = (0..200_000u32).map(|n| (n % 7) as u8).collect();
    let feed = with_packed(&build);
    // Only the packed copy can be read: the download can't have been the plain one.
    feed.feed.files.lock().unwrap().remove("fleetd-linux-x64");

    verified_to(&feed, "fleetd-linux-x64", &path).await.unwrap();
    assert_eq!(fs::read(&path).unwrap(), build);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o755
    );
    assert_eq!(names(dir.path()), ["fleetd.next"]);
    let sums = sums(&feed).await.unwrap();
    assert!(is_build(&path, &sums, "fleetd-linux-x64"));
}

#[tokio::test]
async fn a_packed_build_that_fails_falls_back_to_the_plain_one() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fleetd");
    fs::write(&path, b"old").unwrap();

    // Not lzma at all.
    let feed = with_packed(b"new build");
    feed.feed
        .files
        .lock()
        .unwrap()
        .insert("fleetd-linux-x64.lzma".into(), b"not packed".to_vec());
    verified_to(&feed, "fleetd-linux-x64", &path).await.unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"new build");

    // Unpacks, but to another build than the sums name: the plain one is checked on its own, and lands.
    fs::write(&path, b"old").unwrap();
    let feed = with_packed(b"new build");
    feed.feed
        .files
        .lock()
        .unwrap()
        .insert("fleetd-linux-x64.lzma".into(), packed(b"evil build"));
    verified_to(&feed, "fleetd-linux-x64", &path).await.unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"new build");

    // Both wrong: refused, and nothing changed.
    fs::write(&path, b"old").unwrap();
    feed.feed
        .files
        .lock()
        .unwrap()
        .insert("fleetd-linux-x64".into(), b"evil build".to_vec());
    let mismatch = verified_to(&feed, "fleetd-linux-x64", &path)
        .await
        .unwrap_err();
    assert_eq!(mismatch.stage, UpdateStage::Checksum);
    assert_eq!(fs::read(&path).unwrap(), b"old");
    assert_eq!(names(dir.path()), ["fleetd"]);
}

#[tokio::test]
async fn a_download_cut_off_midway_leaves_nothing_behind() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fleetd");
    fs::write(&path, b"old").unwrap();
    let mut feed = chunked(b"a new build, in many pieces");
    feed.breaks_after = Some(2);
    let cut = verified_to(&feed, "fleetd-linux-x64", &path)
        .await
        .unwrap_err();
    assert_eq!(cut.stage, UpdateStage::Download);
    assert!(cut.message.contains("connection reset"), "{cut}");
    assert_eq!(fs::read(&path).unwrap(), b"old");
    assert_eq!(names(dir.path()), ["fleetd"]);

    // A feed with only the whole-file read still streams, in one piece.
    let whole = FakeFeed::with(&[("fleetd-linux-x64", b"new")], "{}");
    verified_to(&whole, "fleetd-linux-x64", &path)
        .await
        .unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"new");
}

/// The real feed hands a large asset on in the pieces the server sends, never as one buffer.
#[tokio::test]
async fn the_http_feed_streams_an_asset_in_pieces() {
    let build: Vec<u8> = (0..1_000_000u32).map(|n| (n % 251) as u8).collect();
    let served = build.clone();
    let sums = format!("{}  fleetd-linux-x64\n", sha256_hex(&build));
    let app = axum::Router::new()
        .route(
            "/fleetd-linux-x64",
            axum::routing::get(move || {
                let chunks: Vec<Result<Vec<u8>, std::io::Error>> =
                    served.chunks(64 * 1024).map(|c| Ok(c.to_vec())).collect();
                async move { axum::body::Body::from_stream(futures_util::stream::iter(chunks)) }
            }),
        )
        .route(
            "/SHA256SUMS",
            axum::routing::get(move || async move { sums }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    let feed = HttpFeed::new(base);

    let mut pieces = 0;
    let mut got = Vec::new();
    feed.stream("fleetd-linux-x64", &mut |chunk| {
        pieces += 1;
        got.extend_from_slice(chunk);
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(got, build);
    assert!(pieces > 1, "{pieces} piece");

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fleetd.next");
    verified_to(&feed, "fleetd-linux-x64", &path).await.unwrap();
    assert_eq!(fs::read(&path).unwrap(), build);

    let missing = feed
        .stream("fleetd-darwin-arm64", &mut |_| Ok(()))
        .await
        .unwrap_err();
    assert!(missing.contains("404"), "{missing}");
}

/// A server that cuts the build off after `cut` bytes the first time, then serves the rest from the byte a Range asks
/// for (or, with `ranges` off, the whole build again, as a server that can't go on does): its URL and how many GETs.
async fn cutting_server(
    build: Vec<u8>,
    cut: usize,
    ranges: bool,
) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    use axum::http::{HeaderMap, StatusCode, header};
    let gets = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = gets.clone();
    let app = axum::Router::new().route(
        "/fleetd-linux-x64",
        axum::routing::get(move |headers: HeaderMap| {
            let (build, n) = (build.clone(), counted.fetch_add(1, Ordering::SeqCst));
            async move {
                let from: usize = headers
                    .get(header::RANGE)
                    .and_then(|r| r.to_str().ok())
                    .and_then(|r| r.strip_prefix("bytes=")?.strip_suffix('-')?.parse().ok())
                    .filter(|_| ranges)
                    .unwrap_or(0);
                let mut chunks: Vec<Result<Vec<u8>, std::io::Error>> = build[from..]
                    .chunks(16 * 1024)
                    .map(|c| Ok(c.to_vec()))
                    .collect();
                if n == 0 {
                    chunks.truncate(cut / (16 * 1024));
                    chunks.push(Err(std::io::Error::other("cut off")));
                }
                let body = axum::body::Body::from_stream(futures_util::stream::iter(chunks));
                if from == 0 {
                    return (StatusCode::OK, HeaderMap::new(), body);
                }
                let mut sent = HeaderMap::new();
                let range = format!("bytes {from}-{}/{}", build.len() - 1, build.len());
                sent.insert(header::CONTENT_RANGE, range.parse().unwrap());
                (StatusCode::PARTIAL_CONTENT, sent, body)
            }
        }),
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, app).await });
    (base, gets)
}

/// A build's download cut off part way goes on from the byte it stopped at, not from the start.
#[tokio::test]
async fn a_cut_off_download_goes_on_from_where_it_stopped() {
    let build: Vec<u8> = (0..1_000_000u32).map(|n| (n % 251) as u8).collect();
    let (base, gets) = cutting_server(build.clone(), 400 * 1024, true).await;
    let feed = HttpFeed::new(base);
    let mut got = Vec::new();
    feed.stream("fleetd-linux-x64", &mut |chunk| {
        got.extend_from_slice(chunk);
        Ok(())
    })
    .await
    .unwrap();
    assert_eq!(got.len(), build.len(), "nothing came twice");
    assert_eq!(got, build);
    assert_eq!(gets.load(Ordering::SeqCst), 2);

    // A server that can't go on from a byte sends the whole build again: the download stops rather than doubling.
    let (base, _) = cutting_server(build.clone(), 400 * 1024, false).await;
    let mut got = Vec::new();
    let refused = HttpFeed::new(base)
        .stream("fleetd-linux-x64", &mut |chunk| {
            got.extend_from_slice(chunk);
            Ok(())
        })
        .await
        .unwrap_err();
    assert!(refused.contains("can't go on"), "{refused}");
    assert_eq!(got, build[..got.len()]);
}

/// A fake GitHub serving one release's `files`: download links under `<url>/download`, and the releases API at
/// `<url>/api/release`, whose assets answer `Accept: application/octet-stream` with a redirect to their bytes as
/// GitHub's do. Each way is up, or answers every GET `504 Gateway Timeout`, as `links` and `api` say. The feed over it.
pub(crate) async fn fake_github(
    files: HashMap<String, Vec<u8>>,
    links: bool,
    api: bool,
) -> HttpFeed {
    use axum::extract::{Path, State};
    use axum::http::{HeaderMap, StatusCode, header};
    use axum::response::{IntoResponse, Redirect};
    use serde_json::json;
    type Files = std::sync::Arc<HashMap<String, Vec<u8>>>;
    let down = || StatusCode::GATEWAY_TIMEOUT.into_response();
    let serve = |files: &Files, name: &str| match files.get(name) {
        Some(bytes) => bytes.clone().into_response(),
        None => StatusCode::NOT_FOUND.into_response(),
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let assets: Vec<_> = files
        .keys()
        .map(|name| json!({"name": name, "url": format!("{url}/api/assets/{name}")}))
        .collect();
    let release = json!({"tag_name": "edge", "assets": assets});
    let app = axum::Router::new()
        .route(
            "/download/{name}",
            axum::routing::get(
                move |State(files): State<Files>, Path(name): Path<String>| async move {
                    if links { serve(&files, &name) } else { down() }
                },
            ),
        )
        .route(
            "/api/release",
            axum::routing::get(move || async move {
                if api {
                    axum::Json(release).into_response()
                } else {
                    down()
                }
            }),
        )
        .route(
            "/api/assets/{name}",
            axum::routing::get(
                move |Path(name): Path<String>, headers: HeaderMap| async move {
                    let raw = headers
                        .get(header::ACCEPT)
                        .is_some_and(|a| a == "application/octet-stream");
                    match (api, raw) {
                        (false, _) => down(),
                        (true, true) => Redirect::to(&format!("/objects/{name}")).into_response(),
                        (true, false) => axum::Json(json!({"name": name})).into_response(),
                    }
                },
            ),
        )
        .route(
            "/objects/{name}",
            axum::routing::get(
                move |State(files): State<Files>, Path(name): Path<String>| async move {
                    serve(&files, &name)
                },
            ),
        )
        .with_state(std::sync::Arc::new(files));
    tokio::spawn(async move { axum::serve(listener, app).await });
    HttpFeed::with_api(
        format!("{url}/download"),
        Some(format!("{url}/api/release")),
    )
}

/// GitHub's download links answering 504 while its API answers: the update's files come through the API, and the
/// build is checked against the release's SHA256SUMS the same way.
#[tokio::test]
async fn a_failing_download_link_falls_back_to_githubs_api() {
    let build: Vec<u8> = (0..300_000u32).map(|n| (n % 251) as u8).collect();
    let release = r#"{"cliVersion":"0.6.0-edge.202611081200+abcdef0"}"#;
    let files = FakeFeed::with(&[("fleetd-linux-x64", &build)], release)
        .files
        .into_inner()
        .unwrap();
    let feed = fake_github(files.clone(), false, true).await;
    assert_eq!(
        crate::update::release(&feed)
            .await
            .unwrap()
            .cli_version
            .as_deref(),
        Some("0.6.0-edge.202611081200+abcdef0")
    );
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fleetd.next");
    verified_to(&feed, "fleetd-linux-x64", &path).await.unwrap();
    assert_eq!(fs::read(&path).unwrap(), build);
    assert_eq!(verified(&feed, "fleetd-linux-x64").await.unwrap(), build);

    // Through the API too, a build that doesn't match the sums is refused and nothing lands.
    let mut tampered = files;
    tampered.insert("fleetd-linux-x64".into(), b"tampered".to_vec());
    let feed = fake_github(tampered, false, true).await;
    let path = dir.path().join("fleetd.tampered");
    let mismatch = verified_to(&feed, "fleetd-linux-x64", &path)
        .await
        .unwrap_err();
    assert_eq!(mismatch.stage, UpdateStage::Checksum);
    assert!(!path.exists());
}

/// Both ways failing: the update says GitHub's downloads are failing, not a generic "couldn't download".
#[tokio::test]
async fn githubs_downloads_failing_both_ways_is_said_plainly() {
    let files = FakeFeed::with(&[("fleetd-linux-x64", b"new")], "{}")
        .files
        .into_inner()
        .unwrap();
    let feed = fake_github(files, false, false).await;
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("fleetd.next");
    let failures = [
        crate::update::release(&feed).await.map(drop).unwrap_err(),
        sums(&feed).await.map(drop).unwrap_err(),
        verified_to(&feed, "fleetd-linux-x64", &path)
            .await
            .unwrap_err(),
    ];
    for failure in failures {
        assert_eq!(failure.stage, UpdateStage::Download);
        assert!(failure.message.starts_with(GITHUB_FAILING), "{failure}");
        assert!(failure.message.contains("504 Gateway Timeout"), "{failure}");
    }
    assert!(!path.exists());
}

#[test]
fn a_github_release_has_its_api() {
    assert_eq!(
        release_api("https://github.com/unlaboredlabs/fleetd/releases/download/edge").as_deref(),
        Some("https://api.github.com/repos/unlaboredlabs/fleetd/releases/tags/edge")
    );
    assert_eq!(
        release_api("https://github.com/unlaboredlabs/fleetd/releases/latest/download").as_deref(),
        Some("https://api.github.com/repos/unlaboredlabs/fleetd/releases/latest")
    );
    assert_eq!(release_api("https://downloads.example.com/fleetd"), None);
}

#[tokio::test]
async fn reads_the_channels_newest_cli() {
    let feed = FakeFeed::with(&[], r#"{"cliVersion":"0.6.0-edge.202610261056+1b563d7"}"#);
    assert_eq!(
        release(&feed).await.unwrap().cli_version.as_deref(),
        Some("0.6.0-edge.202610261056+1b563d7")
    );
    let broken = FakeFeed::with(&[], "not json");
    assert_eq!(
        release(&broken).await.unwrap_err().stage,
        UpdateStage::Download
    );
}

#[test]
fn a_swap_keeps_the_previous_binary_and_restore_puts_it_back() {
    let dir = tempfile::tempdir().unwrap();
    let exe = dir.path().join("fleetd");
    let prev = dir.path().join("update/fleetd.prev");
    let new = dir.path().join("fleetd.next");
    fs::write(&exe, b"old").unwrap();
    fs::write(&new, b"new").unwrap();
    swap(&exe, &new, b"old", &prev).unwrap();
    assert_eq!(fs::read(&exe).unwrap(), b"new");
    assert_eq!(fs::read(&prev).unwrap(), b"old");
    restore(&exe, &prev).unwrap();
    assert_eq!(fs::read(&exe).unwrap(), b"old");

    // Nowhere to keep the previous binary: the installed one stays.
    let blocked = dir.path().join("file");
    fs::write(&blocked, b"").unwrap();
    let failed = swap(&exe, &new, b"old", &blocked.join("prev")).unwrap_err();
    assert_eq!(failed.stage, UpdateStage::Install);
    assert_eq!(fs::read(&exe).unwrap(), b"old");
}

#[test]
fn finds_this_binarys_units_hubs_first_and_leaves_a_labs_alone() {
    let dir = tempfile::tempdir().unwrap();
    let (prefix, ext) = unit_affixes();
    let unit = |name: &str, exe: &str| {
        fs::write(
            dir.path().join(format!("{prefix}{name}{ext}")),
            format!("ExecStart={exe} run\n"),
        )
        .unwrap();
    };
    unit("node", "/home/u/.fleetd/bin/fleetd");
    unit("hub", "/home/u/.fleetd/bin/fleetd");
    unit("hub-lab3", "/tmp/lab3/fleetd");
    unit("listen", "/home/u/.fleetd/bin/fleetd");
    let found = services_in(dir.path(), Path::new("/home/u/.fleetd/bin/fleetd"));
    let units: Vec<&str> = found.iter().map(|s| s.unit.as_str()).collect();
    assert_eq!(units, ["hub", "node"]);
}

#[test]
fn reads_sha256sum_output() {
    let sums = parse_sums("ABCDEF  fleetd-linux-x64\n0123 *latest-linux.yml\n\n");
    assert_eq!(
        sums.get("fleetd-linux-x64").map(String::as_str),
        Some("abcdef")
    );
    assert_eq!(
        sums.get("latest-linux.yml").map(String::as_str),
        Some("0123")
    );
    assert_eq!(sums.len(), 2);
}

#[test]
fn builds_follow_their_channel() {
    assert_eq!(
        Channel::of("0.4.0-edge.202610171030+abc1234", true),
        Channel::Edge
    );
    assert_eq!(Channel::of("0.4.0", true), Channel::Stable);
    assert_eq!(Channel::of("0.0.0", false), Channel::Edge);
    assert_eq!(Channel::parse("edge"), Ok(Channel::Edge));
    assert_eq!(Channel::parse("latest"), Ok(Channel::Stable));
    assert!(Channel::parse("beta").is_err());
}

/// Each flavour updates to its own asset, so a Rust build never installs the Bun one unless told to (and back).
#[test]
fn each_flavour_has_its_own_asset() {
    assert_eq!(FLAVOUR, Flavour::Rust);
    assert_eq!(cli_asset(), asset_of(Flavour::Rust));
    let rust = asset_of(Flavour::Rust).unwrap();
    let bun = asset_of(Flavour::Bun).unwrap();
    assert!(rust.starts_with("fleetd-") && !rust.starts_with("fleetd-bun-"));
    assert_eq!(bun, rust.replacen("fleetd-", "fleetd-bun-", 1));
    assert_eq!(Flavour::parse("bun"), Ok(Flavour::Bun));
    assert_eq!(Flavour::parse("rust").map(Flavour::as_str), Ok("rust"));
    assert!(Flavour::parse("ts").is_err());
}

/// Nightly is what Edge was called before D203: a build from then, and `--channel nightly` or
/// `FLEETD_CHANNEL=nightly` in someone's script, all follow edge.
#[test]
fn nightly_is_edge() {
    assert_eq!(
        Channel::of("0.0.0-nightly.202610261056+1b563d7", true),
        Channel::Edge
    );
    assert_eq!(Channel::parse("nightly"), Ok(Channel::Edge));
    assert_eq!(Channel::Edge.as_str(), "edge");
}

/// The service manager and the restarted service, as a test scripts them: which version comes up healthy, and a
/// clock the watcher's waits move.
pub struct FakeRunner {
    /// What runs after each restart: the version the restarted service answers on, or None for one that never
    /// comes up.
    pub comes_up: Mutex<Vec<Option<String>>>,
    pub restarts: Mutex<Vec<String>>,
    /// The fake clock at each restart.
    pub restarted_at: Mutex<Vec<i64>>,
    refuse_restart: bool,
    running: Mutex<Option<String>>,
    now: AtomicI64,
}

impl FakeRunner {
    pub fn new(comes_up: &[Option<&str>]) -> Self {
        Self {
            comes_up: Mutex::new(
                comes_up
                    .iter()
                    .rev()
                    .map(|v| v.map(str::to_owned))
                    .collect(),
            ),
            restarts: Mutex::default(),
            restarted_at: Mutex::default(),
            refuse_restart: false,
            running: Mutex::default(),
            now: AtomicI64::new(1_000_000),
        }
    }

    /// A service manager that refuses every restart.
    pub fn refusing() -> Self {
        Self {
            refuse_restart: true,
            ..Self::new(&[])
        }
    }
}

impl Ports for FakeRunner {
    fn restart(&self, service: &Service) -> Result<(), String> {
        self.restarts.lock().unwrap().push(service.name.clone());
        self.restarted_at.lock().unwrap().push(self.now_ms());
        if self.refuse_restart {
            return Err(format!(
                "restarting {} exited with exit status: 1",
                service.name
            ));
        }
        *self.running.lock().unwrap() = self.comes_up.lock().unwrap().pop().flatten();
        Ok(())
    }

    fn healthy<'a>(&'a self, _: &'a Health, version: &'a str, _: i64) -> BoxFuture<'a, bool> {
        let up = self.running.lock().unwrap().as_deref() == Some(version);
        Box::pin(async move { up })
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'_, ()> {
        self.now.fetch_add(
            i64::try_from(duration.as_millis()).unwrap(),
            Ordering::SeqCst,
        );
        Box::pin(async {})
    }

    fn now_ms(&self) -> i64 {
        self.now.load(Ordering::SeqCst)
    }
}

/// A build from before Edge was called Edge: the same series.
const OLD: &str = "0.0.0-nightly.202610251000+aaaaaaa";
const NEW: &str = "0.0.0-edge.202610261056+1b563d7";

fn plan(dir: &Path) -> Plan {
    let exe = dir.join("fleetd");
    let prev = dir.join("update/fleetd.prev");
    let new = dir.join("fleetd.next");
    fs::write(&exe, b"old").unwrap();
    fs::write(&new, b"new").unwrap();
    swap(&exe, &new, b"old", &prev).unwrap();
    Plan {
        exe,
        prev,
        service: Service {
            name: "fleetd-hub.service".into(),
            unit: "hub".into(),
        },
        from: OLD.into(),
        to: NEW.into(),
        health: Health::Hub {
            url: "http://127.0.0.1:4790".into(),
        },
        wait_secs: 90,
        verdict: dir.join("update/hub-verdict.json"),
        answered: None,
    }
}

#[tokio::test]
async fn a_new_build_that_comes_up_stays() {
    let dir = tempfile::tempdir().unwrap();
    let plan = plan(dir.path());
    let runner = FakeRunner::new(&[Some(NEW)]);
    let verdict = finish(&plan, &runner).await;
    assert_eq!(verdict.state, UpdateState::Done);
    assert_eq!(fs::read(&plan.exe).unwrap(), b"new");
    assert_eq!(*runner.restarts.lock().unwrap(), ["fleetd-hub.service"]);
}

#[tokio::test]
async fn a_new_build_that_doesnt_come_up_healthy_is_put_back() {
    let dir = tempfile::tempdir().unwrap();
    let plan = plan(dir.path());
    let runner = FakeRunner::new(&[None, Some(OLD)]);
    let verdict = finish(&plan, &runner).await;
    assert_eq!(
        verdict,
        Verdict {
            state: UpdateState::RolledBack,
            stage: Some(UpdateStage::Health),
            message: format!(
                "Edge · Oct 26, 10:56 UTC · 1b563d7 ({NEW}) didn't come up healthy within 90 s, so \
                 Edge · Oct 25, 10:00 UTC · aaaaaaa ({OLD}) was put back and runs again"
            ),
        }
    );
    assert_eq!(
        fs::read(&plan.exe).unwrap(),
        b"old",
        "the previous binary is back"
    );
    assert_eq!(runner.restarts.lock().unwrap().len(), 2);
    assert!(
        runner.now_ms() >= 1_000_000 + 90_000,
        "it waited the whole 90 s"
    );
}

/// A hub answered before its watcher started, so it restarts at once; a node only once it says its answer is on the
/// link, or after [`super::finish::ANSWER_WAIT`] if it never does, and in neither case later.
#[tokio::test]
async fn a_hub_restarts_at_once_and_a_node_once_its_answer_is_out() {
    let dir = tempfile::tempdir().unwrap();
    let hub = plan(dir.path());
    let runner = FakeRunner::new(&[Some(NEW)]);
    assert_eq!(finish(&hub, &runner).await.state, UpdateState::Done);
    assert_eq!(*runner.restarted_at.lock().unwrap(), [1_000_000]);

    let answered = dir.path().join("update/node-answered");
    let node = Plan {
        answered: Some(answered.clone()),
        ..plan(dir.path())
    };
    let runner = FakeRunner::new(&[Some(NEW)]);
    assert_eq!(finish(&node, &runner).await.state, UpdateState::Done);
    let at = runner.restarted_at.lock().unwrap()[0];
    assert!(
        (1_002_000..1_002_200).contains(&at),
        "never answered: restarted after the cap, at {at}"
    );

    super::finish::mark_answered(&answered);
    let runner = FakeRunner::new(&[Some(NEW)]);
    assert_eq!(finish(&node, &runner).await.state, UpdateState::Done);
    assert_eq!(*runner.restarted_at.lock().unwrap(), [1_000_000]);
}

/// A node's new build that doesn't come up is put back as a hub's is, its answer's wait making no difference.
#[tokio::test]
async fn a_nodes_new_build_that_doesnt_come_up_is_put_back() {
    let dir = tempfile::tempdir().unwrap();
    let answered = dir.path().join("update/node-answered");
    let node = Plan {
        answered: Some(answered.clone()),
        ..plan(dir.path())
    };
    super::finish::mark_answered(&answered);
    let runner = FakeRunner::new(&[None, Some(OLD)]);
    let verdict = finish(&node, &runner).await;
    assert_eq!(verdict.state, UpdateState::RolledBack);
    assert_eq!(fs::read(&node.exe).unwrap(), b"old");
    assert_eq!(runner.restarts.lock().unwrap().len(), 2);
}

/// The service manager refused: nothing restarted, so the old build still runs; only its binary goes back, and the
/// verdict says that, not that it was rolled back or didn't come up.
#[tokio::test]
async fn a_restart_that_fails_says_so_and_puts_the_previous_binary_back() {
    let dir = tempfile::tempdir().unwrap();
    let plan = plan(dir.path());
    let runner = FakeRunner::refusing();
    let verdict = finish(&plan, &runner).await;
    assert_eq!(
        verdict,
        Verdict {
            state: UpdateState::Failed,
            stage: Some(UpdateStage::Restart),
            message: format!(
                "restarting fleetd-hub.service exited with exit status: 1, so it never restarted onto \
                 Edge · Oct 26, 10:56 UTC · 1b563d7 ({NEW}) and still runs Edge · Oct 25, 10:00 UTC · aaaaaaa \
                 ({OLD}); its previous binary was put back"
            ),
        }
    );
    assert_eq!(fs::read(&plan.exe).unwrap(), b"old");
    assert_eq!(
        runner.restarts.lock().unwrap().len(),
        1,
        "a refused restart isn't asked for again"
    );
}
