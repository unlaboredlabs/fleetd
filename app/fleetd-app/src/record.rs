//! `FLEETD_RECORD=<dir>[,fps]`: the app records its own window to `<dir>/fleetd.mp4` plus a PNG every 2 s in
//! `<dir>/frames/`, with no Screen Recording permission (the capture itself is app/record, macOS only). Unset,
//! nothing here runs. On Linux, app/bench/record.sh records the app from outside.

use std::path::PathBuf;

use gpui::App;

const DEFAULT_FPS: u32 = 30;

#[derive(Debug, PartialEq)]
pub struct Config {
    pub dir: PathBuf,
    pub fps: u32,
}

/// `<dir>` or `<dir>,<fps>` (fps 1-120).
pub fn parse(value: &str) -> Result<Config, String> {
    let (dir, fps) = match value.rsplit_once(',') {
        Some((dir, fps)) => {
            let fps: u32 = fps.trim().parse().map_err(|_| format!("FLEETD_RECORD={value:?}: {fps:?} is not a frame rate"))?;
            (dir, fps)
        }
        None => (value, DEFAULT_FPS),
    };
    if !(1..=120).contains(&fps) {
        return Err(format!("FLEETD_RECORD={value:?}: the frame rate must be 1-120"));
    }
    if dir.trim().is_empty() {
        return Err(format!("FLEETD_RECORD={value:?}: no directory"));
    }
    Ok(Config { dir: PathBuf::from(dir.trim()), fps })
}

/// Read before gpui starts, so a bad value is an error message, not a panic in AppKit's launch callback.
pub fn from_env() -> Result<Option<Config>, String> {
    match std::env::var("FLEETD_RECORD") {
        Ok(v) if !v.is_empty() => parse(&v).map(Some),
        _ => Ok(None),
    }
}

/// Starts recording the app's first window. Call once it is open.
pub fn start(config: Config, cx: &mut App) {
    #[cfg(target_os = "macos")]
    {
        use raw_window_handle::HasWindowHandle;
        let number = cx
            .windows()
            .first()
            .and_then(|w| w.update(cx, |_, window, _| HasWindowHandle::window_handle(window).ok().and_then(fleetd_record::window_number)).ok())
            .flatten();
        let Some(number) = number else {
            eprintln!("FLEETD_RECORD error=no window to record");
            return;
        };
        if let Err(e) = fleetd_record::start(number, config.dir.clone(), config.fps) {
            eprintln!("FLEETD_RECORD error=cannot record into {}: {e}", config.dir.display());
            return;
        }
        // Quitting (closing the window, Cmd-Q) waits for the file to be finished.
        cx.on_app_quit(|_| {
            fleetd_record::finish(std::time::Duration::from_secs(15));
            async {}
        })
        .detach();
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (config, cx);
        eprintln!("FLEETD_RECORD is macOS only; app/bench/record.sh records the app on Linux");
    }
}

/// Begins `<dir>/clip.mp4` with the next frame (macOS; nothing elsewhere or when not recording). SIGUSR1 ends it.
pub fn clip_start() {
    #[cfg(target_os = "macos")]
    fleetd_record::clip_start();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dir_and_rate() {
        assert_eq!(parse("/tmp/rec").unwrap(), Config { dir: "/tmp/rec".into(), fps: 30 });
        assert_eq!(parse("/tmp/rec,60").unwrap(), Config { dir: "/tmp/rec".into(), fps: 60 });
        assert!(parse("/tmp/rec,0").is_err());
        assert!(parse("/tmp/rec,fast").is_err());
        assert!(parse(",30").is_err());
    }
}
