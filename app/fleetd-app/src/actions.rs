//! Every action the app menu and its shortcuts dispatch. Views handle the ones that belong to them with
//! `.on_action(cx.listener(...))`; the app-wide ones (About, Quit, window management, links) have global
//! handlers in `menus.rs`. A menu item is greyed out, and its shortcut falls through to the focused view's
//! key handler, while nothing in the focused view's path handles its action.

use gpui::{App, KeyBinding, actions};

actions!(
    fleetd,
    [
        About,
        OpenSettings,
        CheckForUpdates,
        NewOrder,
        ToggleCommandPalette,
        ToggleSidebar,
        ToggleFullScreen,
        Hide,
        HideOthers,
        ShowAll,
        Quit,
        Minimize,
        Zoom,
        BringAllToFront,
        OpenGitHub,
        OpenDocs,
    ]
);

// The Edit menu's actions. Stand-ins until the text field (input.rs, PR #88) lands: then this becomes
// `pub use crate::input::{Copy, Cut, Paste, Redo, SelectAll, Undo};`, whose bindings (input::bind_keys,
// called from main.rs) give the menu its shortcuts. Unbound here so cmd/ctrl+V still reaches the shell.
actions!(edit, [Undo, Redo, Cut, Copy, Paste, SelectAll]);

pub fn bind_keys(cx: &mut App) {
    // `secondary` is cmd on macOS and ctrl elsewhere.
    cx.bind_keys([
        KeyBinding::new("secondary-,", OpenSettings, None),
        KeyBinding::new("secondary-n", NewOrder, None),
        KeyBinding::new("secondary-k", ToggleCommandPalette, None),
        KeyBinding::new("secondary-b", ToggleSidebar, None),
        KeyBinding::new("secondary-q", Quit, None),
    ]);
    if cfg!(target_os = "macos") {
        cx.bind_keys([
            KeyBinding::new("cmd-h", Hide, None),
            KeyBinding::new("cmd-alt-h", HideOthers, None),
            KeyBinding::new("cmd-m", Minimize, None),
            KeyBinding::new("ctrl-cmd-f", ToggleFullScreen, None),
        ]);
    } else {
        cx.bind_keys([KeyBinding::new("f11", ToggleFullScreen, None)]);
    }
}
