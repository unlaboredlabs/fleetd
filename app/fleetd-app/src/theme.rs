//! The app's visual system: one family per voice, a short type scale, a 4 px spacing grid, and colour tokens
//! for light and dark. Every screen reads the [`Theme`] global; nothing else picks a colour or a size.
//!
//! Principles, in order: work is quiet and decisions are loud (an open ask is set in full-weight text, the
//! rest of the fleet in grey); hierarchy comes from weight, grey and space, not from cards, borders or size
//! jumps; mono is only for machine text (commands, logs, ids, paths, diffs); one accent, used for focus,
//! links, unread and the primary button, nowhere else.
//!
//! Type: on macOS the system font (SF Pro, which CoreText switches between its Text and Display optical
//! sizes by point size) and SF Mono, falling back to Menlo, so the app reads like the rest of the OS. Linux
//! has no single system UI font and the headless bench host has none at all, so there we bundle IBM Plex
//! Sans (OFL; Regular and SemiBold, the only two weights the scale uses) and Lilex (OFL) for machine text.

#[cfg(not(target_os = "macos"))]
use std::borrow::Cow;

use gpui::{App, BoxShadow, FontWeight, Global, Hsla, SharedString, Window, WindowAppearance, point, px, rgb, rgba};
use serde::{Deserialize, Serialize};

/// Type scale (px). Four steps; most text is `MD`, titles are `MD` semibold (hierarchy from weight, not size),
/// metadata is `XS`, machine text is `SM` in mono.
pub mod size {
    /// Metadata: counts, timestamps, machine chips, field labels.
    pub const XS: f32 = 11.;
    /// Mono: commands, logs, diffs, ids.
    pub const SM: f32 = 12.;
    /// Body, controls and titles; the macOS default control size.
    pub const MD: f32 = 13.;
    /// The one headline on the connect screen and empty states.
    pub const XL: f32 = 20.;
}

/// Weights: two only. Regular for everything, semibold for titles and for what needs you.
pub const REGULAR: FontWeight = FontWeight::NORMAL;
pub const STRONG: FontWeight = FontWeight::SEMIBOLD;

/// Spacing is gpui's 4 px grid: use `_1` (4), `_1p5` (6), `_2` (8), `_3` (12), `_4` (16), `_6` (24) and
/// `_8` (32) only. Fixed heights below keep rows and controls aligned across screens.
pub mod metric {
    /// List and sidebar rows (macOS sidebar density).
    pub const ROW: f32 = 28.;
    /// Log and diff lines.
    pub const LINE: f32 = 18.;
    /// Buttons.
    pub const CONTROL: f32 = 24.;
    /// Text fields.
    pub const FIELD: f32 = 28.;
    /// Screen and pane headers, the composer bar.
    pub const BAR: f32 = 40.;
    pub const SIDEBAR: f32 = 240.;
    /// Readable measure for prose columns (asks, settings, connect).
    pub const MEASURE: f32 = 680.;
}

/// Corner radii: controls, panels, the floating palette.
pub mod radius {
    pub const SM: f32 = 4.;
    pub const MD: f32 = 6.;
    pub const LG: f32 = 10.;
}

/// What the user picked in Settings; `System` follows the OS and changes with it.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    System,
    Light,
    Dark,
}

impl Mode {
    pub const ALL: [Mode; 3] = [Mode::System, Mode::Light, Mode::Dark];

    pub fn label(self) -> &'static str {
        match self {
            Mode::System => "Match system",
            Mode::Light => "Light",
            Mode::Dark => "Dark",
        }
    }

    pub fn is_dark(self, os: WindowAppearance) -> bool {
        match self {
            Mode::System => matches!(os, WindowAppearance::Dark | WindowAppearance::VibrantDark),
            Mode::Light => false,
            Mode::Dark => true,
        }
    }
}

/// Raw tokens, `0xRRGGBB` (opaque) or `0xRRGGBBAA` for the overlay states, which work on any surface.
#[derive(Clone, Copy, Debug)]
pub struct Palette {
    /// The content area.
    pub bg: u32,
    /// The sidebar: one near-invisible tone step from `bg`, no border needed.
    pub sidebar: u32,
    /// Floating surfaces (palette, composer, menus); separated by a hairline and a soft shadow.
    pub raised: u32,
    /// Overlay on hover (RGBA).
    pub hover: u32,
    /// Overlay on the selected row (RGBA).
    pub selected: u32,
    /// Rules between regions.
    pub hairline: u32,
    /// Field and button outlines.
    pub border: u32,
    /// Primary text, and what needs you.
    pub text: u32,
    /// Work that happened without you, secondary labels, metadata. The smallest readable text uses this.
    pub quiet: u32,
    /// Not for text anyone has to read: placeholders, disabled items, state dots, underlines.
    pub faint: u32,
    /// Focus, links, unread.
    pub accent: u32,
    /// The primary button's fill, and its label.
    pub accent_fill: u32,
    pub on_accent: u32,
    /// Focus ring (RGBA), drawn outside the control.
    pub ring: u32,
    pub success: u32,
    pub warning: u32,
    pub danger: u32,
    /// Diff line backgrounds.
    pub diff_add: u32,
    pub diff_del: u32,
    /// Floating-surface shadow (RGBA).
    pub shadow: u32,
}

pub const LIGHT: Palette = Palette {
    bg: 0xffffff,
    sidebar: 0xf5f5f3,
    raised: 0xffffff,
    hover: 0x0000000a,
    selected: 0x00000012,
    hairline: 0xe6e6e2,
    border: 0xcfcfca,
    text: 0x1c1c1a,
    quiet: 0x63635d,
    faint: 0x96968f,
    accent: 0x2360c4,
    accent_fill: 0x2360c4,
    on_accent: 0xffffff,
    ring: 0x2360c447,
    success: 0x287142,
    warning: 0x8c5a00,
    danger: 0xb63531,
    diff_add: 0xe7f4ea,
    diff_del: 0xfbebea,
    shadow: 0x0000001f,
};

pub const DARK: Palette = Palette {
    bg: 0x1c1c1b,
    sidebar: 0x232322,
    raised: 0x2a2a29,
    hover: 0xffffff0d,
    selected: 0xffffff17,
    hairline: 0x323230,
    border: 0x4a4a46,
    text: 0xededea,
    quiet: 0xababa5,
    faint: 0x74746e,
    accent: 0x79abf5,
    accent_fill: 0x2e69cc,
    on_accent: 0xffffff,
    ring: 0x76a9f560,
    success: 0x6cc28a,
    warning: 0xe3aa4a,
    danger: 0xf38c88,
    diff_add: 0x1f3326,
    diff_del: 0x3b2422,
    shadow: 0x00000066,
};

/// Resolved colours for the current appearance, plus the fonts. Read it with [`theme`].
#[derive(Clone, Debug)]
pub struct Theme {
    pub mode: Mode,
    pub bg: Hsla,
    pub sidebar: Hsla,
    pub raised: Hsla,
    pub hover: Hsla,
    pub selected: Hsla,
    pub hairline: Hsla,
    pub border: Hsla,
    pub text: Hsla,
    pub quiet: Hsla,
    pub faint: Hsla,
    pub accent: Hsla,
    pub accent_fill: Hsla,
    pub on_accent: Hsla,
    pub ring: Hsla,
    pub success: Hsla,
    pub warning: Hsla,
    pub danger: Hsla,
    pub diff_add: Hsla,
    pub diff_del: Hsla,
    shadow: Hsla,
    /// The human voice.
    pub ui_font: SharedString,
    /// The machine voice.
    pub mono_font: SharedString,
}

impl Global for Theme {}

impl Theme {
    pub fn new(mode: Mode, os: WindowAppearance, ui_font: SharedString, mono_font: SharedString) -> Self {
        let p = if mode.is_dark(os) { DARK } else { LIGHT };
        let c = |v: u32| -> Hsla { rgb(v).into() };
        let a = |v: u32| -> Hsla { rgba(v).into() };
        Theme {
            mode,
            bg: c(p.bg),
            sidebar: c(p.sidebar),
            raised: c(p.raised),
            hover: a(p.hover),
            selected: a(p.selected),
            hairline: c(p.hairline),
            border: c(p.border),
            text: c(p.text),
            quiet: c(p.quiet),
            faint: c(p.faint),
            accent: c(p.accent),
            accent_fill: c(p.accent_fill),
            on_accent: c(p.on_accent),
            ring: a(p.ring),
            success: c(p.success),
            warning: c(p.warning),
            danger: c(p.danger),
            diff_add: c(p.diff_add),
            diff_del: c(p.diff_del),
            shadow: a(p.shadow),
            ui_font,
            mono_font,
        }
    }

    /// The macOS-style focus ring: 3 px of translucent accent around the control, no blur.
    pub fn focus_ring(&self) -> Vec<BoxShadow> {
        vec![BoxShadow { color: self.ring, offset: point(px(0.), px(0.)), blur_radius: px(0.), spread_radius: px(3.), inset: false }]
    }

    /// Floating surfaces only (palette, composer, menus): one soft shadow, no glow.
    pub fn float_shadow(&self) -> Vec<BoxShadow> {
        vec![BoxShadow { color: self.shadow, offset: point(px(0.), px(8.)), blur_radius: px(28.), spread_radius: px(0.), inset: false }]
    }
}

/// The current theme. Before [`init`] (tests, or a view built before the window), the dark defaults.
pub fn theme(cx: &App) -> &Theme {
    static FALLBACK: std::sync::OnceLock<Theme> = std::sync::OnceLock::new();
    cx.try_global::<Theme>()
        .unwrap_or_else(|| FALLBACK.get_or_init(|| Theme::new(Mode::Dark, WindowAppearance::Dark, "IBM Plex Sans".into(), "Lilex".into())))
}

/// Registers fonts, resolves the saved mode against the window's appearance, and follows OS changes.
/// Call once, before the first frame.
pub fn init(window: &mut Window, cx: &mut App) {
    #[cfg(not(target_os = "macos"))]
    cx.text_system()
        .add_fonts(vec![Cow::Borrowed(include_bytes!("../assets/fonts/IBMPlexSans-SemiBold.ttf").as_slice())])
        .expect("bundled font loads");
    let (ui, mono) = fonts(cx);
    let mode = crate::prefs::load().theme;
    cx.set_global(Theme::new(mode, window.appearance(), ui, mono));
    window
        .observe_window_appearance(|window, cx| {
            let t = theme(cx);
            if t.mode == Mode::System {
                let next = Theme::new(Mode::System, window.appearance(), t.ui_font.clone(), t.mono_font.clone());
                cx.set_global(next);
                window.refresh();
            }
        })
        .detach();
}

/// Switches the mode now and saves it (off the UI thread).
pub fn set_mode(mode: Mode, window: &mut Window, cx: &mut App) {
    let t = theme(cx);
    let next = Theme::new(mode, window.appearance(), t.ui_font.clone(), t.mono_font.clone());
    cx.set_global(next);
    window.refresh();
    cx.background_executor()
        .spawn(async move {
            let mut prefs = crate::prefs::load();
            prefs.theme = mode;
            // Not saved only if the config directory is unwritable; the choice still holds for this run.
            let _ = crate::prefs::save(&prefs);
        })
        .detach();
}

#[cfg(target_os = "macos")]
fn fonts(cx: &App) -> (SharedString, SharedString) {
    // SF Mono ships with macOS but is not always registered as a public family; Menlo always is. A family gpui
    // can't load resolves to its fallback (Lilex, bundled), so SF Mono is there when it resolves to anything else.
    let ts = cx.text_system();
    let mono = if ts.resolve_font(&gpui::font("SF Mono")) != ts.resolve_font(&gpui::font("Lilex")) { "SF Mono" } else { "Menlo" };
    (".SystemUIFont".into(), mono.into())
}

#[cfg(not(target_os = "macos"))]
fn fonts(_: &App) -> (SharedString, SharedString) {
    ("IBM Plex Sans".into(), "Lilex".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// WCAG 2 relative luminance of an opaque `0xRRGGBB`.
    fn luminance(c: u32) -> f64 {
        let ch = |shift: u32| {
            let v = ((c >> shift) & 0xff) as f64 / 255.;
            if v <= 0.039_28 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
        };
        0.2126 * ch(16) + 0.7152 * ch(8) + 0.0722 * ch(0)
    }

    fn contrast(a: u32, b: u32) -> f64 {
        let (x, y) = (luminance(a), luminance(b));
        (x.max(y) + 0.05) / (x.min(y) + 0.05)
    }

    /// An RGBA overlay (hover, selected) composited onto an opaque surface.
    fn over(surface: u32, overlay: u32) -> u32 {
        let a = (overlay & 0xff) as f64 / 255.;
        [16, 8, 0].iter().fold(0, |acc, &shift| {
            let (o, s) = (((overlay >> 8) >> shift) & 0xff, (surface >> shift) & 0xff);
            acc | (((o as f64 * a + s as f64 * (1. - a)).round() as u32) << shift)
        })
    }

    /// Every surface text sits on: the base tones, the diff tints, and the base tones under the hover and
    /// selected overlays (a selected row's metadata is still read).
    fn surfaces(p: &Palette) -> Vec<(String, u32)> {
        let base = [("bg", p.bg), ("sidebar", p.sidebar), ("raised", p.raised)];
        let mut out: Vec<(String, u32)> = base.iter().map(|(n, c)| (n.to_string(), *c)).collect();
        out.extend([("diff_add".to_string(), p.diff_add), ("diff_del".to_string(), p.diff_del)]);
        for (n, c) in base {
            out.push((format!("{n}+hover"), over(c, p.hover)));
            out.push((format!("{n}+selected"), over(c, p.selected)));
        }
        out
    }

    #[test]
    fn every_text_token_passes_aa_on_every_surface_in_both_modes() {
        for (name, p) in [("light", LIGHT), ("dark", DARK)] {
            for (surface, bg) in surfaces(&p) {
                // All readable text, down to 11 px metadata: WCAG AA for normal text. `faint` is not a text
                // colour and is deliberately absent.
                for (token, fg) in
                    [("text", p.text), ("quiet", p.quiet), ("accent", p.accent), ("danger", p.danger), ("success", p.success), ("warning", p.warning)]
                {
                    let r = contrast(fg, bg);
                    assert!(r >= 4.5, "{name}: {token} on {surface} is {r:.2}:1, under 4.5");
                }
            }
            let r = contrast(p.on_accent, p.accent_fill);
            assert!(r >= 4.5, "{name}: primary button label is {r:.2}:1");
            // Placeholders and disabled items are exempt from AA but must still be visible.
            for (surface, bg) in [("bg", p.bg), ("sidebar", p.sidebar), ("raised", p.raised)] {
                let r = contrast(p.faint, bg);
                assert!(r >= 2.5, "{name}: faint on {surface} is {r:.2}:1");
            }
        }
    }

    #[test]
    fn overlays_composite_like_the_renderer() {
        assert_eq!(over(0xffffff, 0x00000080), 0x7f7f7f);
        assert_eq!(over(0x000000, 0xffffff00), 0x000000);
    }

    #[test]
    fn surfaces_are_tone_steps_not_jumps() {
        // The sidebar reads as a separate region without a border: distinct, but under 1.15:1.
        for p in [LIGHT, DARK] {
            let r = contrast(p.bg, p.sidebar);
            assert!(r > 1.03 && r < 1.15, "bg vs sidebar is {r:.3}:1");
        }
    }

    #[test]
    fn system_mode_follows_the_os_and_explicit_modes_do_not() {
        assert!(Mode::System.is_dark(WindowAppearance::Dark));
        assert!(Mode::System.is_dark(WindowAppearance::VibrantDark));
        assert!(!Mode::System.is_dark(WindowAppearance::Light));
        assert!(Mode::Dark.is_dark(WindowAppearance::Light));
        assert!(!Mode::Light.is_dark(WindowAppearance::VibrantDark));
    }
}
