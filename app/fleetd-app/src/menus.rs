//! The app menu: the macOS menu bar, and on Linux the list behind the title bar's menu button (both read
//! the same `cx.set_menus`). Handlers for app-wide actions live here; the ones that need the window are on
//! the window frame (`titlebar::Frame`).

use gpui::{Action, App, Menu, MenuItem, OsAction};

use crate::actions::*;
use crate::crash;

const REPO_URL: &str = "https://github.com/unlaboredlabs/fleetd";
const DOCS_URL: &str = "https://fleetd.sh/docs";

pub fn init(cx: &mut App) {
    bind_keys(cx);
    // Menu items run inside AppKit's menu callback, which can't unwind.
    global::<Quit>(cx, |cx| cx.quit());
    global::<Hide>(cx, |cx| cx.hide());
    global::<HideOthers>(cx, |cx| cx.hide_other_apps());
    global::<ShowAll>(cx, |cx| cx.unhide_other_apps());
    global::<CheckForUpdates>(cx, crate::update::check_now);
    global::<OpenGitHub>(cx, |cx| cx.open_url(REPO_URL));
    global::<OpenDocs>(cx, |cx| cx.open_url(DOCS_URL));
    cx.set_menus(menus());
}

fn global<A: Action>(cx: &mut App, f: fn(&mut App)) {
    cx.on_action(move |action: &A, cx| crash::guard(action.name(), || f(cx)));
}

fn menus() -> Vec<Menu> {
    vec![
        Menu::new("fleetd").items([
            MenuItem::action("About fleetd", About),
            MenuItem::action("Check for Updates…", CheckForUpdates),
            MenuItem::separator(),
            MenuItem::action("Settings…", OpenSettings),
            #[cfg(target_os = "macos")]
            MenuItem::separator(),
            #[cfg(target_os = "macos")]
            MenuItem::os_submenu("Services", gpui::SystemMenuType::Services),
            #[cfg(target_os = "macos")]
            MenuItem::separator(),
            #[cfg(target_os = "macos")]
            MenuItem::action("Hide fleetd", Hide),
            #[cfg(target_os = "macos")]
            MenuItem::action("Hide Others", HideOthers),
            #[cfg(target_os = "macos")]
            MenuItem::action("Show All", ShowAll),
            MenuItem::separator(),
            MenuItem::action("Quit fleetd", Quit),
        ]),
        Menu::new("File").items([
            MenuItem::action("New Order", NewOrder),
            MenuItem::action("Add Project…", AddProject),
            MenuItem::action("Focus Composer", FocusComposer),
        ]),
        Menu::new("Edit").items([
            MenuItem::os_action("Undo", Undo, OsAction::Undo),
            MenuItem::os_action("Redo", Redo, OsAction::Redo),
            MenuItem::separator(),
            MenuItem::os_action("Cut", Cut, OsAction::Cut),
            MenuItem::os_action("Copy", Copy, OsAction::Copy),
            MenuItem::os_action("Paste", Paste, OsAction::Paste),
            MenuItem::os_action("Select All", SelectAll, OsAction::SelectAll),
        ]),
        Menu::new("View").items([
            MenuItem::action("Status", ToggleStatus),
            MenuItem::action("Board", GoToBoard),
            MenuItem::action("Inbox", ToggleInbox),
            MenuItem::action("Group by Project or Status", ToggleGrouping),
            MenuItem::separator(),
            MenuItem::action("Command Palette", ToggleCommandPalette),
            MenuItem::action("Toggle Sidebar", ToggleSidebar),
            // AppKit adds its own "Enter Full Screen" to a menu named View, as it does for Zed; a second
            // one here would show twice.
            #[cfg(not(target_os = "macos"))]
            MenuItem::separator(),
            #[cfg(not(target_os = "macos"))]
            MenuItem::action("Full Screen", ToggleFullScreen),
        ]),
        Menu::new("Order").items([
            MenuItem::action("Previous Order", PreviousOrder),
            MenuItem::action("Next Order", NextOrder),
            MenuItem::separator(),
            MenuItem::action("Stop Order…", StopOrder),
        ]),
        Menu::new("Window").items([
            MenuItem::action("Minimize", Minimize),
            MenuItem::action(if cfg!(target_os = "macos") { "Zoom" } else { "Maximize" }, Zoom),
            #[cfg(target_os = "macos")]
            MenuItem::separator(),
            #[cfg(target_os = "macos")]
            MenuItem::action("Bring All to Front", BringAllToFront),
        ]),
        Menu::new("Help").items([MenuItem::action("fleetd on GitHub", OpenGitHub), MenuItem::action("Docs", OpenDocs)]),
    ]
}
