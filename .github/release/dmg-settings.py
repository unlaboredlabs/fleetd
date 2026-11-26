# dmgbuild's settings for the Mac app's disk image (macos-dmg.sh): the window that opens on it holds the app on the
# left and an Applications shortcut on the right, to drag one onto the other, and nothing else. No background picture:
# Finder draws the labels for the system's own window colour, so they read in light and dark mode alike.
# `-D app=<path to fleetd.app>` names the app.
app = defines["app"]  # noqa: F821 (dmgbuild's)

files = [app]
symlinks = {"Applications": "/Applications"}
# The volume shows the app's own icon.
icon = app + "/Contents/Resources/icon.icns"

# LZFSE, read by macOS 10.11 on: the app needs macOS 12.
format = "ULFO"
filesystem = "HFS+"

# Finder's coordinates run up from the screen's bottom left: this sits in the upper half of a 13-inch screen.
window_rect = ((200, 360), (560, 320))
default_view = "icon-view"
show_toolbar = False
show_pathbar = False
show_status_bar = False
show_sidebar = False
show_tab_view = False
show_icon_preview = False
include_icon_view_settings = True
icon_size = 128
text_size = 13
icon_locations = {
    "fleetd.app": (150, 140),
    "Applications": (410, 140),
}
