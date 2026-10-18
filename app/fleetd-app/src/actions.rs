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
        FocusComposer,
        ToggleInbox,
        GoToBoard,
        ToggleGrouping,
        PreviousOrder,
        NextOrder,
        StopOrder,
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

// The Edit menu's actions are the text field's: enabled while a field has focus, with its shortcuts
// (input::bind_keys, called from shell::bind_keys).
pub use crate::input::{Copy, Cut, Paste, Redo, SelectAll, Undo};

pub fn bind_keys(cx: &mut App) {
    // `secondary` is cmd on macOS and ctrl elsewhere.
    cx.bind_keys([
        KeyBinding::new("secondary-,", OpenSettings, None),
        KeyBinding::new("secondary-n", NewOrder, None),
        KeyBinding::new("secondary-l", FocusComposer, None),
        KeyBinding::new("secondary-i", ToggleInbox, None),
        KeyBinding::new("secondary-0", GoToBoard, None),
        KeyBinding::new("secondary-shift-g", ToggleGrouping, None),
        KeyBinding::new("secondary-[", PreviousOrder, None),
        KeyBinding::new("secondary-]", NextOrder, None),
        KeyBinding::new("secondary-.", StopOrder, None),
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
