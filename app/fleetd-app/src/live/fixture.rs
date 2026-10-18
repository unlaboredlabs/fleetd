//! Fixture board and scripted live feed, for `FLEETD_BENCH=live` and screenshots only.

use gpui::{App, AppContext, Context, IntoElement, Render, Window, WindowOptions, div};

/// Opens the live bench window. Called by `main` for `FLEETD_BENCH=live` instead of the shell.
pub fn open_bench(options: WindowOptions, cx: &mut App) {
    cx.open_window(options, |_, cx| cx.new(|_| BenchBoard)).expect("open window");
}

struct BenchBoard;

impl Render for BenchBoard {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        div()
    }
}
