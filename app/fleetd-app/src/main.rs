mod actions;
mod bench;
mod client;
mod crash;
// The workstream diff view; the hub serves no diffs yet.
#[allow(dead_code)]
mod diff;
mod fake;
mod keychain;
mod menus;
mod notify;
mod seal;
mod shell;
mod state;
mod titlebar;
mod update;

use std::borrow::Cow;

use gpui::{App, AppContext, Bounds, QuitMode, TitlebarOptions, WindowBounds, WindowDecorations, WindowOptions, px, size};

fn main() {
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
    // On macOS this closure runs inside applicationDidFinishLaunching, which can't unwind.
    gpui_platform::application()
        .with_assets(titlebar::Icons)
        // One window: closing it quits, on macOS too, rather than leaving a windowless app in the Dock.
        .with_quit_mode(QuitMode::LastWindowClosed)
        .run(move |cx: &mut App| crash::guard("startup", || launch(bench, cx)));
}

fn launch(bench: Option<bench::Mode>, cx: &mut App) {
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
            cx.new(|_| titlebar::Frame::new(shell))
        },
    )
    .expect("open window");
    cx.activate(true);
}
