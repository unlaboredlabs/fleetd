mod actions;
mod bench;
mod client;
mod composer;
mod crash;
// The full diff view waits on the hub serving workstream diffs; the lead log already tints diff output.
#[allow(dead_code)]
mod diff;
#[allow(dead_code)]
mod diffview;
mod fake;
mod input;
mod keychain;
mod links;
mod menus;
mod notify;
mod pair;
mod palette;
mod prefs;
mod seal;
mod settings;
mod shell;
mod sidebar;
mod state;
mod theme;
mod titlebar;
mod ui;
mod update;

use std::borrow::Cow;

use gpui::{App, AppContext, Bounds, QuitMode, TitlebarOptions, WindowBounds, WindowDecorations, WindowOptions, px, size};

fn main() {
    bench::mark_start();
    if std::env::args().any(|a| a == "--version") {
        println!("fleetd-app {}", update::VERSION);
        return;
    }
    crash::install_hook();
    let bench = match bench::Mode::from_env() {
        Ok(mode) => mode,
        Err(e) => {
            eprintln!("fleetd-app: {e}");
            std::process::exit(2);
        }
    };
    if let Some(mode) = bench {
        bench::stage("process_start", &format!("mode={mode:?} pid={}", std::process::id()));
        bench::start_watchdog();
    }
    #[cfg(target_os = "macos")]
    skip_window_restoration();
    let app = gpui_platform::application()
        .with_assets(titlebar::Icons)
        // One window: closing it quits, on macOS too, rather than leaving a windowless app in the Dock.
        .with_quit_mode(QuitMode::LastWindowClosed);
    let links = pair::listen(&app);
    if bench.is_some() {
        // Splits the time before `app_launched` into gpui's platform setup and AppKit's own launch.
        bench::stage("platform_ready", "");
    }
    // On macOS this closure runs inside applicationDidFinishLaunching, which can't unwind.
    app.run(move |cx: &mut App| crash::guard("startup", || launch(bench, links, cx)));
}

fn launch(bench: Option<bench::Mode>, links: pair::Links, cx: &mut App) {
    let stage = |name, detail: &str| {
        if bench.is_some() {
            bench::stage(name, detail);
        }
    };
    stage("app_launched", "");
    cx.set_global(links);
    shell::bind_keys(cx);
    // Bundled so text renders the same everywhere, including hosts with no system fonts.
    cx.text_system()
        .add_fonts(vec![
            Cow::Borrowed(include_bytes!("../assets/fonts/IBMPlexSans-Regular.ttf").as_slice()),
            Cow::Borrowed(include_bytes!("../assets/fonts/Lilex-Regular.ttf").as_slice()),
        ])
        .expect("bundled fonts load");
    // Required for system notifications; on macOS they also need the app bundle (app/packaging/macos-bundle.sh).
    cx.set_app_identity("sh.fleetd.app", "fleetd");
    menus::init(cx);
    let bounds = Bounds::centered(None, size(px(1400.), px(900.)), cx);
    stage("window_opening", &bench::displays_and(bounds, cx));
    cx.open_window(
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            // The app draws its own top bar (titlebar.rs): on macOS the traffic lights sit in it, on Linux it
            // carries the window buttons whenever the compositor leaves decorations to the client.
            titlebar: Some(TitlebarOptions {
                title: Some("fleetd".into()),
                appears_transparent: true,
                traffic_light_position: Some(titlebar::TRAFFIC_LIGHTS),
            }),
            app_owns_titlebar_drag: true,
            window_decorations: Some(WindowDecorations::Client),
            window_min_size: Some(size(px(640.), px(400.))),
            app_id: Some("fleetd".into()),
            // gpui caps unfocused windows at 30 fps. Benchmarks measure rendering, not whether the OS
            // gave a freshly launched binary focus (macOS often doesn't), so lift the cap there.
            inactive_frame_interval: if bench.is_some() { None } else { WindowOptions::default().inactive_frame_interval },
            ..Default::default()
        },
        |window, cx| {
            let shell = cx.new(|cx| shell::Shell::new(bench, window, cx));
            cx.new(|cx| {
                if bench.is_some() {
                    bench::watch_window(window, cx);
                }
                titlebar::Frame::new(shell)
            })
        },
    )
    .expect("open window");
    cx.activate(true);
    stage("activate_requested", "");
}

/// AppKit's window restoration runs during launch, before gpui calls `launch`. After a launch that died part way
/// (the abort an early nightly hit inside applicationDidFinishLaunching, or a kill), the next one first shows a
/// modal "quit unexpectedly while reopening windows" alert, so the app has no window and prints nothing until
/// someone clicks it; a run killed while the alert is up leaves it armed for the next. The app restores nothing
/// (it opens one window at a fixed size), so turn restoration off in its own defaults domain (Xcode passes the
/// same key when it runs an app). Set on every launch, before AppKit reads it.
#[cfg(target_os = "macos")]
fn skip_window_restoration() {
    use objc2_foundation::{NSString, NSUserDefaults};
    NSUserDefaults::standardUserDefaults().setBool_forKey(true, &NSString::from_str("ApplePersistenceIgnoreState"));
}
