//! The motion system: a handful of durations and easings, reduce-motion from the OS and the user's pref, and
//! [`Presence`], which tells a list which rows are new and which are gone so they can enter and leave.
//!
//! Motion only ever follows an event: a row arrives, a row leaves, a status changes, a sparkline gains a
//! bucket, a train chip moves. Nothing loops (no `Animation::repeat` anywhere). Everything goes through gpui's
//! `with_animation`, which renders the end state and schedules no frames when `cx.reduce_motion()` is set.

use std::collections::HashSet;
use std::hash::Hash;
use std::time::Duration;

use gpui::prelude::*;
use gpui::{
    Animation, AnimationExt, AnyElement, App, ElementId, Global, IntoElement, Pixels, Styled, div, ease_in_out, ease_out_quint, px, quadratic,
};
use serde::{Deserialize, Serialize};

/// Settings → Motion. `System` follows the OS (macOS Reduce motion, GNOME animations off, KDE speed 0).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MotionPref {
    #[default]
    System,
    Reduced,
    Full,
}

impl MotionPref {
    pub const ALL: [MotionPref; 3] = [MotionPref::System, MotionPref::Reduced, MotionPref::Full];

    pub fn label(self) -> &'static str {
        match self {
            MotionPref::System => "Match system",
            MotionPref::Reduced => "Reduced",
            MotionPref::Full => "Full",
        }
    }
}

pub mod dur {
    use std::time::Duration;

    /// Hover and press tints, chip and dot colour changes.
    pub const MICRO: Duration = Duration::from_millis(120);
    /// A row or card arriving.
    pub const ENTER: Duration = Duration::from_millis(180);
    /// A row or card leaving.
    pub const EXIT: Duration = Duration::from_millis(140);
    /// The inbox panel sliding in or out.
    pub const PANEL: Duration = Duration::from_millis(200);
    /// Sparkline bars shifting one slot when a bucket arrives.
    pub const SPARK: Duration = Duration::from_millis(180);
    /// A train chip sliding to its new slot.
    pub const TRAIN: Duration = Duration::from_millis(240);
    /// How long a finished lane stays on the board, reading "done in 3:02", before it leaves.
    pub const DONE_HOLD: Duration = Duration::from_secs(8);
    /// How long a merged chip stays on the train strip.
    pub const MERGED_HOLD: Duration = Duration::from_secs(10);
}

/// The inbox panel's width; `slide_panel` moves it by this much.
pub const PANEL_W: f32 = 360.;

#[derive(Default)]
struct Motion {
    pref: MotionPref,
    os_reduced: bool,
}

impl Global for Motion {}

/// Call once at launch. Applies the pref (default `System`) now and reads the OS setting off the UI thread, so
/// it never costs startup time; until it answers, motion is on.
pub fn init(cx: &mut App) {
    if !cx.has_global::<Motion>() {
        cx.set_global(Motion::default());
    }
    apply(cx);
    let read = cx.background_executor().spawn(async { os_reduces_motion() });
    cx.spawn(async move |cx| {
        let reduced = read.await;
        cx.update(|cx| {
            cx.global_mut::<Motion>().os_reduced = reduced;
            apply(cx);
        });
    })
    .detach();
}

pub fn set_pref(pref: MotionPref, cx: &mut App) {
    if !cx.has_global::<Motion>() {
        cx.set_global(Motion::default());
    }
    cx.global_mut::<Motion>().pref = pref;
    apply(cx);
}

fn apply(cx: &mut App) {
    let m = cx.global::<Motion>();
    let reduced = resolve(m.pref, m.os_reduced);
    cx.set_reduce_motion(reduced);
}

fn resolve(pref: MotionPref, os_reduced: bool) -> bool {
    match pref {
        MotionPref::System => os_reduced,
        MotionPref::Reduced => true,
        MotionPref::Full => false,
    }
}

#[cfg(target_os = "macos")]
fn os_reduces_motion() -> bool {
    // NSWorkspace.accessibilityDisplayShouldReduceMotion reads this same default.
    command_out("defaults", &["read", "com.apple.universalaccess", "reduceMotion"]).is_some_and(|v| v.trim() == "1")
}

#[cfg(not(target_os = "macos"))]
fn os_reduces_motion() -> bool {
    let gnome = command_out("gsettings", &["get", "org.gnome.desktop.interface", "enable-animations"]).is_some_and(|v| v.trim() == "false");
    let kde = std::env::var_os("XDG_CONFIG_HOME")
        .map(std::path::PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|h| std::path::Path::new(&h).join(".config")))
        .and_then(|dir| std::fs::read_to_string(dir.join("kdeglobals")).ok())
        .is_some_and(|text| kde_animations_off(&text));
    gnome || kde
}

fn command_out(cmd: &str, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new(cmd).args(args).stderr(std::process::Stdio::null()).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).into_owned())
}

/// KDE turns animations off with `AnimationDurationFactor=0` in the `[KDE]` group of kdeglobals.
#[cfg_attr(target_os = "macos", allow(dead_code))]
fn kde_animations_off(kdeglobals: &str) -> bool {
    let mut in_kde = false;
    for line in kdeglobals.lines().map(str::trim) {
        if line.starts_with('[') {
            in_kde = line == "[KDE]";
        } else if in_kde && let Some(v) = line.strip_prefix("AnimationDurationFactor=") {
            return v.trim().parse::<f32>().is_ok_and(|f| f == 0.);
        }
    }
    false
}

/// Fades an element in, once, the first time `id` renders. For rows whose height the caller knows, prefer
/// [`enter_sized`], which also grows the row so its neighbours slide instead of jumping.
pub fn enter(id: impl Into<ElementId>, el: impl IntoElement) -> AnyElement {
    div().child(el).with_animation(id, Animation::new(dur::ENTER).with_easing(ease_out_quint()), |d, t| d.opacity(t)).into_any_element()
}

/// Fades in and grows from 0 to `height`, once. Top-inserted rows push the rest down smoothly.
pub fn enter_sized(id: impl Into<ElementId>, el: impl IntoElement, height: Pixels) -> AnyElement {
    div()
        .overflow_hidden()
        .child(el)
        .with_animation(id, Animation::new(dur::ENTER).with_easing(ease_out_quint()), move |d, t| d.h(height * t).opacity(t))
        .into_any_element()
}

/// Fades out, then collapses from `height` to 0: opacity over the first 80 ms, height over the last 60. The
/// caller keeps rendering the row until [`dur::EXIT`] has passed, then drops it.
pub fn exit_sized(id: impl Into<ElementId>, el: impl IntoElement, height: Pixels) -> AnyElement {
    let fade = Animation::new(Duration::from_millis(80)).with_easing(quadratic);
    let collapse = Animation::new(dur::EXIT - Duration::from_millis(80)).with_easing(quadratic);
    div()
        .overflow_hidden()
        .h(height)
        .child(el)
        .with_animations(id, vec![fade, collapse], move |d, step, t| match step {
            0 => d.opacity(1. - t),
            _ => d.opacity(0.).h(height * (1. - t)),
        })
        .into_any_element()
}

/// The inbox panel: slides in from the right edge when `open`, out when not. Give each direction its own id
/// (this appends `open` to it) so each plays once. After closing, render it for [`dur::PANEL`] more, then
/// drop it.
pub fn slide_panel(id: impl Into<ElementId>, el: impl IntoElement, open: bool) -> AnyElement {
    let id = ElementId::from(id.into().to_string() + if open { "-open" } else { "-close" });
    div()
        .relative()
        .size_full()
        .child(el)
        .with_animation(id, Animation::new(dur::PANEL).with_easing(ease_out_quint()), move |d, t| {
            let shown = if open { t } else { 1. - t };
            d.left(px(PANEL_W * (1. - shown)))
        })
        .into_any_element()
}

/// A horizontal slide from `from` to `to`, for a chip moving between slots.
pub fn slide_x(id: impl Into<ElementId>, el: impl IntoElement, from: Pixels, to: Pixels) -> AnyElement {
    div()
        .absolute()
        .top_0()
        .left(to)
        .child(el)
        .with_animation(id, Animation::new(dur::TRAIN).with_easing(ease_in_out), move |d, t| d.left(from + (to - from) * t))
        .into_any_element()
}

/// Remembers which keys a list showed last time, and tells which are new and which are gone. The first diff
/// only primes it: rows that are there when a list first loads don't animate in.
pub struct Presence<K> {
    shown: Vec<K>,
    primed: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub struct PresenceDiff<K> {
    /// In the order of `now`.
    pub entered: Vec<K>,
    /// In the order they were shown.
    pub left: Vec<K>,
}

impl<K> Default for Presence<K> {
    fn default() -> Self {
        Self { shown: Vec::new(), primed: false }
    }
}

impl<K: Eq + Hash + Clone> Presence<K> {
    pub fn diff(&mut self, now: impl IntoIterator<Item = K>) -> PresenceDiff<K> {
        let now: Vec<K> = now.into_iter().collect();
        let now_set: HashSet<&K> = now.iter().collect();
        let before: HashSet<&K> = self.shown.iter().collect();
        let entered = if self.primed { now.iter().filter(|k| !before.contains(k)).cloned().collect() } else { Vec::new() };
        let left = self.shown.iter().filter(|k| !now_set.contains(k)).cloned().collect();
        self.shown = now;
        self.primed = true;
        PresenceDiff { entered, left }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pref_overrides_the_os_only_when_set() {
        assert!(!resolve(MotionPref::System, false));
        assert!(resolve(MotionPref::System, true));
        assert!(resolve(MotionPref::Reduced, false));
        assert!(!resolve(MotionPref::Full, true));
    }

    #[test]
    fn kde_factor_zero_means_no_animations() {
        assert!(kde_animations_off("[General]\nfoo=1\n[KDE]\nAnimationDurationFactor=0\n"));
        assert!(!kde_animations_off("[KDE]\nAnimationDurationFactor=0.5\n"));
        // The key only counts inside [KDE].
        assert!(!kde_animations_off("[General]\nAnimationDurationFactor=0\n[KDE]\nLookAndFeel=x\n"));
        assert!(!kde_animations_off(""));
    }

    #[test]
    fn first_diff_primes_without_entering() {
        let mut p = Presence::default();
        assert_eq!(p.diff(["a", "b"]), PresenceDiff { entered: vec![], left: vec![] });
        assert_eq!(p.diff(["c", "a"]), PresenceDiff { entered: vec!["c"], left: vec!["b"] });
        assert_eq!(p.diff(Vec::<&str>::new()), PresenceDiff { entered: vec![], left: vec!["c", "a"] });
        assert_eq!(p.diff(["a"]), PresenceDiff { entered: vec!["a"], left: vec![] });
    }

    #[test]
    fn pref_serializes_lowercase_for_prefs_json() {
        assert_eq!(serde_json::to_string(&MotionPref::Reduced).unwrap(), "\"reduced\"");
        assert_eq!(serde_json::from_str::<MotionPref>("\"full\"").unwrap(), MotionPref::Full);
    }
}
