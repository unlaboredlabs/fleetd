//! The app's text field. GPUI ships none, so this grows out of GPUI's own `examples/input.rs` at the pinned
//! tag (Apache-2.0, Zed Industries): the `EntityInputHandler` IME plumbing and the custom text element are
//! that example's, extended with soft-wrapped multi-line text, word/line motion, undo, history, masking and
//! mouse selection. Key bindings follow Zed's default macOS and Linux keymaps.
//!
//! gpui-component's Input was the first choice, but it builds on its own GPUI fork (`gpui-pre`), whose types
//! don't mix with the pinned gpui, and its editing engine (gpui-base, ~30k lines with rope, LSP and tree-sitter)
//! is far more than a reply box needs.
//!
//! Usage: call [`bind_keys`] once at startup, create one with `cx.new(|cx| TextInput::new(cx))`, render the
//! entity as a child, and `cx.subscribe` to [`InputEvent`]s.

use std::ops::Range;

use gpui::{
    App, AvailableSpace, Bounds, ClipboardItem, ContentMask, Context, CursorStyle, ElementId, ElementInputHandler, Entity, EntityInputHandler,
    EventEmitter, FocusHandle, Focusable, GlobalElementId, KeyBinding, LayoutId, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent,
    PaintQuad, Pixels, Point, ScrollDelta, ScrollWheelEvent, SharedString, Style, TextAlign, TextRun, TextStyle, UTF16Selection, UnderlineStyle,
    Window, WrappedLine, actions, div, fill, point, prelude::*, px, relative, size,
};
use unicode_segmentation::UnicodeSegmentation;
use zeroize::{Zeroize, Zeroizing};

const CONTEXT: &str = "TextInput";
const BULLET: char = '•';
const HISTORY_MAX: usize = 50;
const UNDO_MAX: usize = 200;

actions!(
    text_input,
    [
        Backspace,
        Delete,
        DeleteWordLeft,
        DeleteWordRight,
        DeleteToLineStart,
        DeleteToLineEnd,
        Left,
        Right,
        Up,
        Down,
        WordLeft,
        WordRight,
        LineStart,
        LineEnd,
        TextStart,
        TextEnd,
        SelectLeft,
        SelectRight,
        SelectUp,
        SelectDown,
        SelectWordLeft,
        SelectWordRight,
        SelectToLineStart,
        SelectToLineEnd,
        SelectToTextStart,
        SelectToTextEnd,
        SelectAll,
        Copy,
        Cut,
        Paste,
        Undo,
        Redo,
        Newline,
        Submit,
        Cancel,
        ShowCharacterPalette,
    ]
);

/// Binds the text field keys: Cmd/Option on macOS, Ctrl elsewhere, as Zed's default keymaps do.
pub fn bind_keys(cx: &mut App) {
    fn k<A: gpui::Action>(keys: &str, action: A) -> KeyBinding {
        KeyBinding::new(keys, action, Some(CONTEXT))
    }
    let mut keys = vec![
        k("backspace", Backspace),
        k("shift-backspace", Backspace),
        k("delete", Delete),
        k("left", Left),
        k("right", Right),
        k("up", Up),
        k("down", Down),
        k("shift-left", SelectLeft),
        k("shift-right", SelectRight),
        k("shift-up", SelectUp),
        k("shift-down", SelectDown),
        k("home", LineStart),
        k("end", LineEnd),
        k("shift-home", SelectToLineStart),
        k("shift-end", SelectToLineEnd),
        k("enter", Submit),
        k("shift-enter", Newline),
        k("escape", Cancel),
    ];
    if cfg!(target_os = "macos") {
        keys.extend([
            k("alt-left", WordLeft),
            k("alt-right", WordRight),
            k("alt-shift-left", SelectWordLeft),
            k("alt-shift-right", SelectWordRight),
            k("cmd-left", LineStart),
            k("cmd-right", LineEnd),
            k("ctrl-a", LineStart),
            k("ctrl-e", LineEnd),
            k("cmd-shift-left", SelectToLineStart),
            k("cmd-shift-right", SelectToLineEnd),
            k("cmd-up", TextStart),
            k("cmd-down", TextEnd),
            k("cmd-shift-up", SelectToTextStart),
            k("cmd-shift-down", SelectToTextEnd),
            k("alt-backspace", DeleteWordLeft),
            k("alt-delete", DeleteWordRight),
            k("cmd-backspace", DeleteToLineStart),
            k("cmd-delete", DeleteToLineEnd),
            k("ctrl-k", DeleteToLineEnd),
            k("cmd-a", SelectAll),
            k("cmd-c", Copy),
            k("cmd-x", Cut),
            k("cmd-v", Paste),
            k("cmd-z", Undo),
            k("cmd-shift-z", Redo),
            k("ctrl-cmd-space", ShowCharacterPalette),
        ]);
    } else {
        keys.extend([
            k("ctrl-left", WordLeft),
            k("ctrl-right", WordRight),
            k("ctrl-shift-left", SelectWordLeft),
            k("ctrl-shift-right", SelectWordRight),
            k("ctrl-home", TextStart),
            k("ctrl-end", TextEnd),
            k("ctrl-shift-home", SelectToTextStart),
            k("ctrl-shift-end", SelectToTextEnd),
            k("ctrl-backspace", DeleteWordLeft),
            k("ctrl-delete", DeleteWordRight),
            k("ctrl-shift-backspace", DeleteToLineStart),
            k("ctrl-shift-delete", DeleteToLineEnd),
            k("ctrl-a", SelectAll),
            k("ctrl-c", Copy),
            k("ctrl-insert", Copy),
            k("ctrl-x", Cut),
            k("ctrl-v", Paste),
            k("shift-insert", Paste),
            k("ctrl-z", Undo),
            k("ctrl-shift-z", Redo),
            k("ctrl-y", Redo),
        ]);
    }
    cx.bind_keys(keys);
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InputEvent {
    /// Enter.
    Submit,
    /// Escape.
    Cancel,
    /// The text changed.
    Changed,
    /// An edit was refused because it would pass the byte limit.
    TooLong,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum EditKind {
    Insert,
    Delete,
    Other,
}

struct Snapshot {
    text: String,
    selected: Range<usize>,
}

/// One visual row: a hard line, or a piece of one when soft-wrapped. Offsets are into the displayed text.
#[derive(Clone, Copy, Debug)]
struct Row {
    line: usize,
    line_start: usize,
    start: usize,
    end: usize,
    /// Where the row starts in its line's unwrapped layout.
    x0: Pixels,
}

/// What the last paint laid out, for mouse hit-testing, vertical motion and IME bounds.
struct Layout {
    bounds: Bounds<Pixels>,
    line_height: Pixels,
    lines: Vec<WrappedLine>,
    rows: Vec<Row>,
    /// The placeholder is showing: every point maps to offset 0.
    empty: bool,
}

pub struct TextInput {
    focus: FocusHandle,
    text: Zeroizing<String>,
    placeholder: SharedString,
    selected: Range<usize>,
    reversed: bool,
    marked: Option<Range<usize>>,
    /// `Some(n)`: soft-wrapped, Shift+Enter adds lines, at most `n` rows tall before it scrolls.
    max_rows: Option<usize>,
    masked: bool,
    max_bytes: Option<usize>,
    bordered: bool,
    /// Machine text: the mono voice at the mono size.
    mono: bool,
    /// A text editor: Enter adds a line and nothing submits.
    enter_newline: bool,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    last_edit: Option<EditKind>,
    history: Vec<String>,
    history_ix: Option<usize>,
    /// The left button is down after a click with this count (1 char, 2 word, 3 line).
    dragging: Option<usize>,
    drag_anchor: Range<usize>,
    /// Up/Down keep the column they started from.
    goal_x: Option<Pixels>,
    scroll: Point<Pixels>,
    autoscroll: bool,
    layout: Option<Layout>,
}

impl EventEmitter<InputEvent> for TextInput {}

impl Focusable for TextInput {
    fn focus_handle(&self, _: &App) -> FocusHandle {
        self.focus.clone()
    }
}

impl TextInput {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self {
            focus: cx.focus_handle().tab_stop(true),
            text: Zeroizing::new(String::new()),
            placeholder: SharedString::default(),
            selected: 0..0,
            reversed: false,
            marked: None,
            max_rows: None,
            masked: false,
            max_bytes: None,
            bordered: true,
            mono: false,
            enter_newline: false,
            undo: Vec::new(),
            redo: Vec::new(),
            last_edit: None,
            history: Vec::new(),
            history_ix: None,
            dragging: None,
            drag_anchor: 0..0,
            goal_x: None,
            scroll: Point::default(),
            autoscroll: true,
            layout: None,
        }
    }

    pub fn placeholder(mut self, text: impl Into<SharedString>) -> Self {
        self.placeholder = text.into();
        self
    }

    /// Soft-wrapped; Shift+Enter inserts a newline (Enter still submits). Grows to `max_rows`, then scrolls.
    pub fn multi_line(mut self, max_rows: usize) -> Self {
        self.max_rows = Some(max_rows.max(1));
        self
    }

    /// A secret: shown as bullets, never copied or kept in undo, and held in a buffer allocated once at
    /// `max_bytes` (so edits never leave copies in freed memory) that is zeroed on clear and drop.
    pub fn masked(mut self, max_bytes: usize) -> Self {
        self.masked = true;
        self.max_bytes = Some(max_bytes);
        self.text = Zeroizing::new(String::with_capacity(max_bytes));
        self
    }

    /// Mono text, for fields that hold machine text such as a prompt.
    pub fn mono(mut self) -> Self {
        self.mono = true;
        self
    }

    /// For a multi-line field that holds a document rather than a message: Enter adds a line, like Shift+Enter.
    pub fn enter_newline(mut self) -> Self {
        self.enter_newline = true;
        self
    }

    /// No border or background, for a field that sits in a styled strip.
    pub fn borderless(mut self) -> Self {
        self.bordered = false;
        self
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn is_empty(&self) -> bool {
        self.text.is_empty()
    }

    pub fn set_text(&mut self, text: &str, cx: &mut Context<Self>) {
        let end = self.text.len();
        self.replace(0..end, text, EditKind::Other, cx);
        self.last_edit = None;
    }

    /// Puts the caret at the start and scrolls there, e.g. after filling a long text with [`Self::set_text`].
    pub fn caret_to_start(&mut self, cx: &mut Context<Self>) {
        self.selected = 0..0;
        self.reversed = false;
        self.goal_x = None;
        self.scroll = Point::default();
        self.autoscroll = true;
        cx.notify();
    }

    /// Empties the field (wiping a masked value) and its undo; history stays.
    pub fn clear(&mut self, cx: &mut Context<Self>) {
        self.text.zeroize();
        self.selected = 0..0;
        self.reversed = false;
        self.marked = None;
        self.undo.clear();
        self.redo.clear();
        self.last_edit = None;
        self.history_ix = None;
        self.autoscroll = true;
        cx.emit(InputEvent::Changed);
        cx.notify();
    }

    /// Types `text` at the caret, as if from the keyboard.
    pub fn insert(&mut self, text: &str, cx: &mut Context<Self>) {
        self.replace(self.selected.clone(), text, EditKind::Insert, cx);
    }

    /// Where the field was last painted, in window coordinates.
    pub fn bounds(&self) -> Option<Bounds<Pixels>> {
        self.layout.as_ref().map(|l| l.bounds)
    }

    /// Where the caret is, as a byte offset into [`Self::text`].
    pub fn caret(&self) -> usize {
        self.cursor()
    }

    /// Replaces `range` (byte offsets) with `text` and puts the caret after it, as one undo step.
    pub fn replace_range(&mut self, range: Range<usize>, text: &str, cx: &mut Context<Self>) {
        self.replace(range, text, EditKind::Other, cx);
        self.last_edit = None;
    }

    /// Adds a sent entry for Up on an empty field to recall.
    pub fn remember(&mut self, entry: &str) {
        if self.masked || entry.trim().is_empty() || self.history.last().is_some_and(|last| last == entry) {
            return;
        }
        self.history.push(entry.to_string());
        if self.history.len() > HISTORY_MAX {
            self.history.remove(0);
        }
        self.history_ix = None;
    }

    // ---- editing ----------------------------------------------------------------------------

    fn cursor(&self) -> usize {
        if self.reversed { self.selected.start } else { self.selected.end }
    }

    fn move_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        self.selected = offset..offset;
        self.reversed = false;
        self.after_move(cx);
    }

    fn select_to(&mut self, offset: usize, cx: &mut Context<Self>) {
        if self.reversed {
            self.selected.start = offset;
        } else {
            self.selected.end = offset;
        }
        if self.selected.end < self.selected.start {
            self.reversed = !self.reversed;
            self.selected = self.selected.end..self.selected.start;
        }
        self.after_move(cx);
    }

    fn select_range(&mut self, range: Range<usize>, cx: &mut Context<Self>) {
        self.selected = range;
        self.reversed = false;
        self.after_move(cx);
    }

    fn after_move(&mut self, cx: &mut Context<Self>) {
        self.last_edit = None;
        self.goal_x = None;
        self.autoscroll = true;
        cx.notify();
    }

    /// Every text change goes through here. False when refused for length.
    fn replace(&mut self, range: Range<usize>, new: &str, kind: EditKind, cx: &mut Context<Self>) -> bool {
        let new = if self.max_rows.is_none() && !self.masked { single_line(new) } else { std::borrow::Cow::Borrowed(new) };
        if let Some(max) = self.max_bytes
            && self.text.len() - range.len() + new.len() > max
        {
            cx.emit(InputEvent::TooLong);
            return false;
        }
        if !self.masked {
            let coalesce = kind == EditKind::Insert && self.last_edit == Some(kind) && !new.contains(char::is_whitespace);
            if !coalesce && !(kind == EditKind::Delete && self.last_edit == Some(kind)) {
                self.undo.push(Snapshot { text: self.text.to_string(), selected: self.selected.clone() });
                if self.undo.len() > UNDO_MAX {
                    self.undo.remove(0);
                }
            }
            self.redo.clear();
        }
        // In place: a masked buffer has capacity for max_bytes, so this never reallocates.
        self.text.replace_range(range.clone(), &new);
        let caret = range.start + new.len();
        self.selected = caret..caret;
        self.reversed = false;
        self.marked = None;
        self.last_edit = Some(kind);
        self.history_ix = None;
        self.goal_x = None;
        self.autoscroll = true;
        cx.emit(InputEvent::Changed);
        cx.notify();
        true
    }

    fn delete_to(&mut self, target: usize, cx: &mut Context<Self>) {
        let range = if self.selected.is_empty() {
            let at = self.cursor();
            at.min(target)..at.max(target)
        } else {
            self.selected.clone()
        };
        if !range.is_empty() {
            self.replace(range, "", EditKind::Delete, cx);
        }
    }

    fn restore(&mut self, snapshot: Snapshot, cx: &mut Context<Self>) {
        self.text.clear();
        self.text.push_str(&snapshot.text);
        self.selected = snapshot.selected;
        self.reversed = false;
        self.marked = None;
        self.last_edit = None;
        self.autoscroll = true;
        cx.emit(InputEvent::Changed);
        cx.notify();
    }

    /// Steps through history: `older` or newer. False when there is nowhere to go.
    fn recall(&mut self, older: bool, cx: &mut Context<Self>) -> bool {
        let next = match (self.history_ix, older) {
            (None, true) => self.history.len().checked_sub(1),
            (None, false) => return false,
            (Some(ix), true) => Some(ix.saturating_sub(1)),
            (Some(ix), false) => (ix + 1 < self.history.len()).then_some(ix + 1),
        };
        let text = next.map_or(String::new(), |ix| self.history[ix].clone());
        if next.is_none() && self.history_ix.is_none() {
            return false;
        }
        self.text.clear();
        self.text.push_str(&text);
        self.selected = self.text.len()..self.text.len();
        self.reversed = false;
        self.history_ix = next;
        self.last_edit = None;
        self.autoscroll = true;
        cx.emit(InputEvent::Changed);
        cx.notify();
        true
    }

    // ---- layout queries ---------------------------------------------------------------------

    /// The displayed text: bullets for a masked field.
    fn display(&self) -> String {
        if self.masked { BULLET.to_string().repeat(self.text.chars().count()) } else { self.text.to_string() }
    }

    fn to_display(&self, offset: usize) -> usize {
        if self.masked { self.text[..offset].chars().count() * BULLET.len_utf8() } else { offset }
    }

    fn text_offset(&self, offset: usize) -> usize {
        if self.masked {
            let n = offset / BULLET.len_utf8();
            self.text.char_indices().nth(n).map_or(self.text.len(), |(i, _)| i)
        } else {
            offset.min(self.text.len())
        }
    }

    /// The row a display offset sits on and its x within that row. At a soft-wrap boundary, the later row.
    fn locate(&self, layout: &Layout, display_offset: usize) -> (usize, Pixels) {
        if layout.empty || layout.rows.is_empty() {
            return (0, px(0.));
        }
        let ix = layout.rows.iter().rposition(|r| r.start <= display_offset).unwrap_or(0);
        let row = layout.rows[ix];
        let x = layout.lines[row.line].unwrapped_layout.x_for_index(display_offset.min(row.end) - row.line_start) - row.x0;
        (ix, x)
    }

    /// The text offset closest to `x` on row `ix`.
    fn offset_in_row(&self, layout: &Layout, ix: usize, x: Pixels) -> usize {
        let row = layout.rows[ix];
        let at = closest_index(&layout.lines[row.line].unwrapped_layout, x + row.x0) + row.line_start;
        self.text_offset(at.clamp(row.start, row.end))
    }

    fn offset_for_point(&self, position: Point<Pixels>) -> usize {
        let Some(layout) = self.layout.as_ref().filter(|l| !l.empty && !l.rows.is_empty()) else { return 0 };
        let local = position - layout.bounds.origin + self.scroll;
        let ix = ((local.y / layout.line_height).floor().max(0.) as usize).min(layout.rows.len() - 1);
        self.offset_in_row(layout, ix, local.x)
    }

    /// The offset one row up or down from the caret, keeping the goal column. None past the first/last row.
    fn vertical(&mut self, down: bool) -> Option<usize> {
        let layout = self.layout.as_ref().filter(|l| !l.empty)?;
        let (ix, x) = self.locate(layout, self.to_display(self.cursor()));
        let target = if down { ix + 1 } else { ix.checked_sub(1)? };
        if target >= layout.rows.len() {
            return None;
        }
        let goal = *self.goal_x.get_or_insert(x);
        let layout = self.layout.as_ref()?;
        Some(self.offset_in_row(layout, target, goal))
    }

    /// Start and end of the caret's visual row (the hard line before the first paint).
    fn row_bounds(&self) -> Range<usize> {
        let cursor = self.cursor();
        match self.layout.as_ref().filter(|l| !l.empty && !l.rows.is_empty()) {
            Some(layout) => {
                let (ix, _) = self.locate(layout, self.to_display(cursor));
                let row = layout.rows[ix];
                let start = self.text_offset(row.start);
                let mut end = self.text_offset(row.end);
                // A soft-wrapped row ends where the next begins; stop before its trailing space instead.
                if layout.rows.get(ix + 1).is_some_and(|next| next.line == row.line) {
                    end = prev_grapheme(&self.text, end).max(start);
                }
                start..end
            }
            None => line_at(&self.text, cursor),
        }
    }

    // ---- actions ----------------------------------------------------------------------------

    fn backspace(&mut self, _: &Backspace, _: &mut Window, cx: &mut Context<Self>) {
        self.delete_to(prev_grapheme(&self.text, self.cursor()), cx);
    }

    fn delete(&mut self, _: &Delete, _: &mut Window, cx: &mut Context<Self>) {
        self.delete_to(next_grapheme(&self.text, self.cursor()), cx);
    }

    fn delete_word_left(&mut self, _: &DeleteWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        let target = if self.masked { 0 } else { word_left(&self.text, self.cursor()) };
        self.delete_to(target, cx);
    }

    fn delete_word_right(&mut self, _: &DeleteWordRight, _: &mut Window, cx: &mut Context<Self>) {
        let target = if self.masked { self.text.len() } else { word_right(&self.text, self.cursor()) };
        self.delete_to(target, cx);
    }

    fn delete_to_line_start(&mut self, _: &DeleteToLineStart, _: &mut Window, cx: &mut Context<Self>) {
        let start = self.row_bounds().start;
        self.delete_to(start, cx);
    }

    fn delete_to_line_end(&mut self, _: &DeleteToLineEnd, _: &mut Window, cx: &mut Context<Self>) {
        let end = self.row_bounds().end;
        self.delete_to(end, cx);
    }

    fn left(&mut self, _: &Left, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected.is_empty() {
            self.move_to(prev_grapheme(&self.text, self.cursor()), cx);
        } else {
            self.move_to(self.selected.start, cx);
        }
    }

    fn right(&mut self, _: &Right, _: &mut Window, cx: &mut Context<Self>) {
        if self.selected.is_empty() {
            self.move_to(next_grapheme(&self.text, self.cursor()), cx);
        } else {
            self.move_to(self.selected.end, cx);
        }
    }

    fn up(&mut self, _: &Up, _: &mut Window, cx: &mut Context<Self>) {
        if (self.text.is_empty() || self.history_ix.is_some()) && self.recall(true, cx) {
            return;
        }
        // An empty field leaves the arrows to whatever contains it (e.g. a list).
        if self.text.is_empty() {
            return cx.propagate();
        }
        match (self.max_rows, self.vertical(false)) {
            (_, Some(offset)) => {
                let goal = self.goal_x;
                self.move_to(offset, cx);
                self.goal_x = goal;
            }
            (Some(_), None) => self.move_to(0, cx),
            // A single-line field leaves Up to whatever contains it (e.g. a list).
            (None, None) => cx.propagate(),
        }
    }

    fn down(&mut self, _: &Down, _: &mut Window, cx: &mut Context<Self>) {
        if self.history_ix.is_some() && self.recall(false, cx) {
            return;
        }
        if self.text.is_empty() {
            return cx.propagate();
        }
        match (self.max_rows, self.vertical(true)) {
            (_, Some(offset)) => {
                let goal = self.goal_x;
                self.move_to(offset, cx);
                self.goal_x = goal;
            }
            (Some(_), None) => self.move_to(self.text.len(), cx),
            (None, None) => cx.propagate(),
        }
    }

    fn word_left(&mut self, _: &WordLeft, _: &mut Window, cx: &mut Context<Self>) {
        let from = if self.selected.is_empty() { self.cursor() } else { self.selected.start };
        self.move_to(if self.masked { 0 } else { word_left(&self.text, from) }, cx);
    }

    fn word_right(&mut self, _: &WordRight, _: &mut Window, cx: &mut Context<Self>) {
        let from = if self.selected.is_empty() { self.cursor() } else { self.selected.end };
        self.move_to(if self.masked { self.text.len() } else { word_right(&self.text, from) }, cx);
    }

    fn line_start(&mut self, _: &LineStart, _: &mut Window, cx: &mut Context<Self>) {
        let start = self.row_bounds().start;
        self.move_to(start, cx);
    }

    fn line_end(&mut self, _: &LineEnd, _: &mut Window, cx: &mut Context<Self>) {
        let end = self.row_bounds().end;
        self.move_to(end, cx);
    }

    fn text_start(&mut self, _: &TextStart, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(0, cx);
    }

    fn text_end(&mut self, _: &TextEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.move_to(self.text.len(), cx);
    }

    fn select_left(&mut self, _: &SelectLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(prev_grapheme(&self.text, self.cursor()), cx);
    }

    fn select_right(&mut self, _: &SelectRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(next_grapheme(&self.text, self.cursor()), cx);
    }

    fn select_up(&mut self, _: &SelectUp, _: &mut Window, cx: &mut Context<Self>) {
        let target = self.vertical(false).unwrap_or(0);
        let goal = self.goal_x;
        self.select_to(target, cx);
        self.goal_x = goal;
    }

    fn select_down(&mut self, _: &SelectDown, _: &mut Window, cx: &mut Context<Self>) {
        let target = self.vertical(true).unwrap_or(self.text.len());
        let goal = self.goal_x;
        self.select_to(target, cx);
        self.goal_x = goal;
    }

    fn select_word_left(&mut self, _: &SelectWordLeft, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(if self.masked { 0 } else { word_left(&self.text, self.cursor()) }, cx);
    }

    fn select_word_right(&mut self, _: &SelectWordRight, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(if self.masked { self.text.len() } else { word_right(&self.text, self.cursor()) }, cx);
    }

    fn select_to_line_start(&mut self, _: &SelectToLineStart, _: &mut Window, cx: &mut Context<Self>) {
        let start = self.row_bounds().start;
        self.select_to(start, cx);
    }

    fn select_to_line_end(&mut self, _: &SelectToLineEnd, _: &mut Window, cx: &mut Context<Self>) {
        let end = self.row_bounds().end;
        self.select_to(end, cx);
    }

    fn select_to_text_start(&mut self, _: &SelectToTextStart, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(0, cx);
    }

    fn select_to_text_end(&mut self, _: &SelectToTextEnd, _: &mut Window, cx: &mut Context<Self>) {
        self.select_to(self.text.len(), cx);
    }

    fn select_all(&mut self, _: &SelectAll, _: &mut Window, cx: &mut Context<Self>) {
        self.select_range(0..self.text.len(), cx);
    }

    fn copy(&mut self, _: &Copy, _: &mut Window, cx: &mut Context<Self>) {
        if !self.masked && !self.selected.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.text[self.selected.clone()].to_string()));
        }
    }

    fn cut(&mut self, _: &Cut, _: &mut Window, cx: &mut Context<Self>) {
        if !self.masked && !self.selected.is_empty() {
            cx.write_to_clipboard(ClipboardItem::new_string(self.text[self.selected.clone()].to_string()));
            self.replace(self.selected.clone(), "", EditKind::Other, cx);
        }
    }

    fn paste(&mut self, _: &Paste, _: &mut Window, cx: &mut Context<Self>) {
        let Some(mut text) = cx.read_from_clipboard().and_then(|item| item.text()) else { return };
        let pasted = if self.masked { text.trim_end_matches(['\n', '\r']) } else { text.as_str() };
        self.replace(self.selected.clone(), pasted, EditKind::Other, cx);
        self.last_edit = None;
        text.zeroize();
    }

    fn undo(&mut self, _: &Undo, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(snapshot) = self.undo.pop() {
            self.redo.push(Snapshot { text: self.text.to_string(), selected: self.selected.clone() });
            self.restore(snapshot, cx);
        }
    }

    fn redo(&mut self, _: &Redo, _: &mut Window, cx: &mut Context<Self>) {
        if let Some(snapshot) = self.redo.pop() {
            self.undo.push(Snapshot { text: self.text.to_string(), selected: self.selected.clone() });
            self.restore(snapshot, cx);
        }
    }

    fn newline(&mut self, _: &Newline, _: &mut Window, cx: &mut Context<Self>) {
        if self.max_rows.is_some() {
            self.replace(self.selected.clone(), "\n", EditKind::Insert, cx);
        }
    }

    fn submit(&mut self, _: &Submit, _: &mut Window, cx: &mut Context<Self>) {
        if self.enter_newline && self.max_rows.is_some() {
            self.replace(self.selected.clone(), "\n", EditKind::Insert, cx);
            return;
        }
        cx.emit(InputEvent::Submit);
    }

    fn cancel(&mut self, _: &Cancel, _: &mut Window, cx: &mut Context<Self>) {
        cx.emit(InputEvent::Cancel);
    }

    fn show_character_palette(&mut self, _: &ShowCharacterPalette, window: &mut Window, _: &mut Context<Self>) {
        window.show_character_palette();
    }

    // ---- mouse ------------------------------------------------------------------------------

    fn on_mouse_down(&mut self, event: &MouseDownEvent, _: &mut Window, cx: &mut Context<Self>) {
        let at = self.offset_for_point(event.position);
        let clicks = event.click_count.clamp(1, 3);
        self.dragging = Some(clicks);
        match clicks {
            1 if event.modifiers.shift => self.select_to(at, cx),
            1 => self.move_to(at, cx),
            2 => self.select_range(if self.masked { 0..self.text.len() } else { word_at(&self.text, at) }, cx),
            _ => self.select_range(if self.max_rows.is_some() { line_at(&self.text, at) } else { 0..self.text.len() }, cx),
        }
        self.drag_anchor = self.selected.clone();
    }

    fn on_mouse_up(&mut self, _: &MouseUpEvent, _: &mut Window, _: &mut Context<Self>) {
        self.dragging = None;
    }

    fn on_mouse_move(&mut self, event: &MouseMoveEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(clicks) = self.dragging else { return };
        if !event.dragging() {
            self.dragging = None;
            return;
        }
        let at = self.offset_for_point(event.position);
        // Dragging after a double/triple click extends by whole words/lines, as on macOS.
        let unit = match clicks {
            1 => at..at,
            2 if !self.masked => word_at(&self.text, at),
            _ if self.max_rows.is_some() => line_at(&self.text, at),
            _ => 0..self.text.len(),
        };
        let anchor = self.drag_anchor.clone();
        if unit.start < anchor.start {
            self.selected = unit.start..anchor.end;
            self.reversed = true;
        } else {
            self.selected = anchor.start..unit.end.max(anchor.end);
            self.reversed = false;
        }
        self.autoscroll = true;
        cx.notify();
    }

    fn on_scroll(&mut self, event: &ScrollWheelEvent, _: &mut Window, cx: &mut Context<Self>) {
        let Some(layout) = &self.layout else { return };
        let delta = match event.delta {
            ScrollDelta::Pixels(p) => p,
            ScrollDelta::Lines(l) => point(px(l.x * 20.), layout.line_height * l.y),
        };
        let content_h = layout.line_height * layout.rows.len().max(1) as f32;
        let max_y = (content_h - layout.bounds.size.height).max(px(0.));
        if max_y > px(0.) {
            self.scroll.y = (self.scroll.y - delta.y).clamp(px(0.), max_y);
            self.autoscroll = false;
            cx.stop_propagation();
            cx.notify();
        }
    }

    // ---- utf-16, for the platform input handler -----------------------------------------------

    fn offset_from_utf16(&self, offset: usize) -> usize {
        let mut utf8 = 0;
        let mut utf16 = 0;
        for ch in self.text.chars() {
            if utf16 >= offset {
                break;
            }
            utf16 += ch.len_utf16();
            utf8 += ch.len_utf8();
        }
        utf8
    }

    fn offset_to_utf16(&self, offset: usize) -> usize {
        self.text[..offset.min(self.text.len())].chars().map(char::len_utf16).sum()
    }

    fn range_to_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_to_utf16(range.start)..self.offset_to_utf16(range.end)
    }

    fn range_from_utf16(&self, range: &Range<usize>) -> Range<usize> {
        self.offset_from_utf16(range.start)..self.offset_from_utf16(range.end)
    }
}

impl EntityInputHandler for TextInput {
    fn text_for_range(&mut self, range: Range<usize>, actual: &mut Option<Range<usize>>, _: &mut Window, _: &mut Context<Self>) -> Option<String> {
        if self.masked {
            return None;
        }
        let range = self.range_from_utf16(&range);
        actual.replace(self.range_to_utf16(&range));
        Some(self.text[range].to_string())
    }

    fn selected_text_range(&mut self, _: bool, _: &mut Window, _: &mut Context<Self>) -> Option<UTF16Selection> {
        Some(UTF16Selection { range: self.range_to_utf16(&self.selected), reversed: self.reversed })
    }

    fn marked_text_range(&self, _: &mut Window, _: &mut Context<Self>) -> Option<Range<usize>> {
        self.marked.as_ref().map(|r| self.range_to_utf16(r))
    }

    fn unmark_text(&mut self, _: &mut Window, _: &mut Context<Self>) {
        self.marked = None;
    }

    fn replace_text_in_range(&mut self, range: Option<Range<usize>>, text: &str, _: &mut Window, cx: &mut Context<Self>) {
        let range = range.map(|r| self.range_from_utf16(&r)).or(self.marked.clone()).unwrap_or(self.selected.clone());
        self.replace(range, text, EditKind::Insert, cx);
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        range: Option<Range<usize>>,
        text: &str,
        new_selected: Option<Range<usize>>,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let range = range.map(|r| self.range_from_utf16(&r)).or(self.marked.clone()).unwrap_or(self.selected.clone());
        if !self.replace(range.clone(), text, EditKind::Insert, cx) {
            return;
        }
        self.marked = (!text.is_empty()).then(|| range.start..range.start + text.len());
        if let Some(sel) = new_selected {
            // Relative to the marked text, in UTF-16 units of it.
            let utf8 = |n: usize| text.chars().scan(0, |u16s, c| (*u16s < n).then(|| (*u16s += c.len_utf16(), c.len_utf8()).1)).sum::<usize>();
            self.selected = range.start + utf8(sel.start)..range.start + utf8(sel.end);
        }
    }

    fn bounds_for_range(&mut self, range: Range<usize>, bounds: Bounds<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<Bounds<Pixels>> {
        let layout = self.layout.as_ref()?;
        let range = self.range_from_utf16(&range);
        let (row, x0) = self.locate(layout, self.to_display(range.start));
        let (_, x1) = self.locate(layout, self.to_display(range.end));
        let top = bounds.top() + layout.line_height * row as f32 - self.scroll.y;
        let left = bounds.left() - self.scroll.x;
        Some(Bounds::from_corners(point(left + x0, top), point(left + x1.max(x0), top + layout.line_height)))
    }

    fn character_index_for_point(&mut self, point: Point<Pixels>, _: &mut Window, _: &mut Context<Self>) -> Option<usize> {
        let offset = self.offset_for_point(point);
        Some(self.offset_to_utf16(offset))
    }
}

impl Render for TextInput {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let focused = self.focus.is_focused(window);
        div()
            .key_context(CONTEXT)
            .track_focus(&self.focus)
            .cursor(CursorStyle::IBeam)
            .on_action(cx.listener(Self::backspace))
            .on_action(cx.listener(Self::delete))
            .on_action(cx.listener(Self::delete_word_left))
            .on_action(cx.listener(Self::delete_word_right))
            .on_action(cx.listener(Self::delete_to_line_start))
            .on_action(cx.listener(Self::delete_to_line_end))
            .on_action(cx.listener(Self::left))
            .on_action(cx.listener(Self::right))
            .on_action(cx.listener(Self::up))
            .on_action(cx.listener(Self::down))
            .on_action(cx.listener(Self::word_left))
            .on_action(cx.listener(Self::word_right))
            .on_action(cx.listener(Self::line_start))
            .on_action(cx.listener(Self::line_end))
            .on_action(cx.listener(Self::text_start))
            .on_action(cx.listener(Self::text_end))
            .on_action(cx.listener(Self::select_left))
            .on_action(cx.listener(Self::select_right))
            .on_action(cx.listener(Self::select_up))
            .on_action(cx.listener(Self::select_down))
            .on_action(cx.listener(Self::select_word_left))
            .on_action(cx.listener(Self::select_word_right))
            .on_action(cx.listener(Self::select_to_line_start))
            .on_action(cx.listener(Self::select_to_line_end))
            .on_action(cx.listener(Self::select_to_text_start))
            .on_action(cx.listener(Self::select_to_text_end))
            .on_action(cx.listener(Self::select_all))
            .on_action(cx.listener(Self::copy))
            .on_action(cx.listener(Self::cut))
            .on_action(cx.listener(Self::paste))
            .on_action(cx.listener(Self::undo))
            .on_action(cx.listener(Self::redo))
            .on_action(cx.listener(Self::newline))
            .on_action(cx.listener(Self::submit))
            .on_action(cx.listener(Self::cancel))
            .on_action(cx.listener(Self::show_character_palette))
            .on_mouse_down(MouseButton::Left, cx.listener(Self::on_mouse_down))
            .on_mouse_up(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_up_out(MouseButton::Left, cx.listener(Self::on_mouse_up))
            .on_mouse_move(cx.listener(Self::on_mouse_move))
            .on_scroll_wheel(cx.listener(Self::on_scroll))
            .w_full()
            .min_w_0()
            .px_2()
            .py_1()
            .when(self.mono, |d| d.font_family(crate::theme::theme(cx).mono_font.clone()).text_size(px(crate::theme::size::SM)))
            .when(self.bordered, |d| {
                let t = crate::theme::theme(cx);
                d.rounded(px(crate::theme::radius::SM))
                    .border_1()
                    .bg(t.bg)
                    .border_color(if focused { t.accent } else { t.border })
                    .when(focused, |d| d.shadow(t.focus_ring()))
            })
            .child(TextElement { input: cx.entity() })
    }
}

struct TextElement {
    input: Entity<TextInput>,
}

struct Prepaint {
    lines: Vec<WrappedLine>,
    rows: Vec<Row>,
    empty: bool,
    line_height: Pixels,
    selection: Vec<PaintQuad>,
    cursor: Option<PaintQuad>,
}

impl IntoElement for TextElement {
    type Element = Self;

    fn into_element(self) -> Self::Element {
        self
    }
}

/// Shapes what the field shows. `wrap` is the width for multi-line fields.
fn shape(input: &TextInput, wrap: Option<Pixels>, style: &TextStyle, placeholder: gpui::Hsla, window: &mut Window) -> (Vec<WrappedLine>, bool) {
    let font_size = style.font_size.to_pixels(window.rem_size());
    let empty = input.text.is_empty();
    let (display, color) = if empty { (input.placeholder.to_string(), placeholder) } else { (input.display(), style.color) };
    let run = TextRun { len: display.len(), font: style.font(), color, background_color: None, underline: None, strikethrough: None };
    let runs = match input.marked.as_ref().filter(|_| !empty) {
        Some(marked) => {
            let (start, end) = (input.to_display(marked.start), input.to_display(marked.end));
            let underline = UnderlineStyle { color: Some(run.color), thickness: px(1.), wavy: false };
            [
                TextRun { len: start, ..run.clone() },
                TextRun { len: end - start, underline: Some(underline), ..run.clone() },
                TextRun { len: display.len() - end, ..run },
            ]
            .into_iter()
            .filter(|r| r.len > 0)
            .collect()
        }
        None => vec![run],
    };
    let lines = window.text_system().shape_text(display.into(), font_size, &runs, wrap, None).map(|l| l.into_vec()).unwrap_or_default();
    (lines, empty)
}

/// Like gpui's `closest_index_for_x`, but a point in the last character's left half stays before it.
fn closest_index(layout: &gpui::LineLayout, x: Pixels) -> usize {
    let mut prev = (0, px(0.));
    for glyph in layout.runs.iter().flat_map(|r| &r.glyphs) {
        if glyph.position.x >= x {
            return if glyph.position.x - x < x - prev.1 { glyph.index } else { prev.0 };
        }
        prev = (glyph.index, glyph.position.x);
    }
    if layout.width - x < x - prev.1 { layout.len } else { prev.0 }
}

fn rows_of(lines: &[WrappedLine]) -> Vec<Row> {
    let mut rows = Vec::new();
    let mut line_start = 0;
    for (line, wrapped) in lines.iter().enumerate() {
        let layout = &wrapped.unwrapped_layout;
        let mut start = (line_start, px(0.));
        for boundary in wrapped.wrap_boundaries() {
            let glyph = &layout.runs[boundary.run_ix].glyphs[boundary.glyph_ix];
            let at = (line_start + glyph.index, glyph.position.x);
            rows.push(Row { line, line_start, start: start.0, end: at.0, x0: start.1 });
            start = at;
        }
        rows.push(Row { line, line_start, start: start.0, end: line_start + wrapped.len(), x0: start.1 });
        line_start += wrapped.len() + 1;
    }
    rows
}

impl Element for TextElement {
    type RequestLayoutState = ();
    type PrepaintState = Prepaint;

    fn id(&self) -> Option<ElementId> {
        None
    }

    fn source_location(&self) -> Option<&'static core::panic::Location<'static>> {
        None
    }

    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        window: &mut Window,
        cx: &mut App,
    ) -> (LayoutId, ()) {
        let mut style = Style::default();
        style.size.width = relative(1.).into();
        let line_height = window.line_height();
        let Some(max_rows) = self.input.read(cx).max_rows else {
            style.size.height = line_height.into();
            return (window.request_layout(style, [], cx), ());
        };
        let input = self.input.clone();
        let text_style = window.text_style();
        let placeholder = crate::theme::theme(cx).faint;
        let id = window.request_measured_layout(style, move |known, available, window, cx| {
            let width = known.width.or(match available.width {
                AvailableSpace::Definite(w) => Some(w),
                _ => None,
            });
            let (lines, _) = shape(input.read(cx), width, &text_style, placeholder, window);
            let rows: usize = lines.iter().map(|l| l.wrap_boundaries().len() + 1).sum();
            size(width.unwrap_or_default(), line_height * rows.clamp(1, max_rows) as f32)
        });
        (id, ())
    }

    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        window: &mut Window,
        cx: &mut App,
    ) -> Prepaint {
        let t = crate::theme::theme(cx);
        let (placeholder, selection_color, caret) = (t.faint, t.ring, t.accent);
        let input = self.input.read(cx);
        let line_height = window.line_height();
        let wrap = input.max_rows.map(|_| bounds.size.width);
        let (lines, empty) = shape(input, wrap, &window.text_style(), placeholder, window);
        let rows = rows_of(&lines);
        let probe = Layout { bounds, line_height, lines: Vec::new(), rows: rows.clone(), empty };
        let layout = Layout { lines, ..probe };
        let cursor_display = input.to_display(input.cursor());
        let (cursor_row, cursor_x) = input.locate(&layout, cursor_display);

        // Keep the caret in view after it moves.
        let mut scroll = input.scroll;
        if input.autoscroll {
            if input.max_rows.is_some() {
                let top = line_height * cursor_row as f32;
                if top < scroll.y {
                    scroll.y = top;
                } else if top + line_height > scroll.y + bounds.size.height {
                    scroll.y = top + line_height - bounds.size.height;
                }
            } else {
                let width = bounds.size.width - px(2.);
                if cursor_x < scroll.x {
                    scroll.x = cursor_x;
                } else if cursor_x > scroll.x + width {
                    scroll.x = cursor_x - width;
                }
                let line_width = layout.lines.first().map_or(px(0.), |l| l.unwrapped_layout.width);
                scroll.x = scroll.x.min((line_width - width).max(px(0.)));
            }
        }
        let origin = bounds.origin - scroll;

        let mut selection = Vec::new();
        if !input.selected.is_empty() && !empty {
            let (start, end) = (input.to_display(input.selected.start), input.to_display(input.selected.end));
            for (ix, row) in layout.rows.iter().enumerate() {
                let (a, b) = (start.max(row.start), end.min(row.end));
                let continues = end > row.end && start <= row.end;
                if a > b || (a == b && !continues) {
                    continue;
                }
                let x = |offset: usize| layout.lines[row.line].unwrapped_layout.x_for_index(offset - row.line_start) - row.x0;
                let top = origin.y + line_height * ix as f32;
                let right = x(b) + if continues { px(4.) } else { px(0.) };
                selection.push(fill(Bounds::from_corners(point(origin.x + x(a), top), point(origin.x + right, top + line_height)), selection_color));
            }
        }
        let cursor = (input.selected.is_empty() || input.marked.is_some()).then(|| {
            let top = origin.y + line_height * cursor_row as f32;
            fill(Bounds::new(point(origin.x + cursor_x, top), size(px(1.5), line_height)), caret)
        });
        self.input.update(cx, |input, _| {
            input.scroll = scroll;
            input.autoscroll = false;
        });
        Prepaint { lines: layout.lines, rows: layout.rows, empty, line_height, selection, cursor }
    }

    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&gpui::InspectorElementId>,
        bounds: Bounds<Pixels>,
        _: &mut (),
        prepaint: &mut Prepaint,
        window: &mut Window,
        cx: &mut App,
    ) {
        let focus = self.input.read(cx).focus.clone();
        let scroll = self.input.read(cx).scroll;
        window.handle_input(&focus, ElementInputHandler::new(bounds, self.input.clone()), cx);
        let line_height = prepaint.line_height;
        window.with_content_mask(Some(ContentMask { bounds }), |window| {
            for quad in prepaint.selection.drain(..) {
                window.paint_quad(quad);
            }
            let mut row = 0;
            for line in &prepaint.lines {
                let origin = point(bounds.left() - scroll.x, bounds.top() - scroll.y + line_height * row as f32);
                line.paint(origin, line_height, TextAlign::Left, None, window, cx).ok();
                row += line.wrap_boundaries().len() + 1;
            }
            if focus.is_focused(window)
                && let Some(cursor) = prepaint.cursor.take()
            {
                window.paint_quad(cursor);
            }
        });
        let layout = Layout {
            bounds,
            line_height,
            lines: std::mem::take(&mut prepaint.lines),
            rows: std::mem::take(&mut prepaint.rows),
            empty: prepaint.empty,
        };
        self.input.update(cx, |input, _| input.layout = Some(layout));
    }
}

// ---- text boundaries (pure) ---------------------------------------------------------------------

fn single_line(text: &str) -> std::borrow::Cow<'_, str> {
    if text.contains(['\n', '\r']) { text.replace("\r\n", " ").replace(['\n', '\r'], " ").into() } else { text.into() }
}

fn prev_grapheme(text: &str, offset: usize) -> usize {
    text.grapheme_indices(true).rev().find_map(|(i, _)| (i < offset).then_some(i)).unwrap_or(0)
}

fn next_grapheme(text: &str, offset: usize) -> usize {
    text.grapheme_indices(true).find_map(|(i, _)| (i > offset).then_some(i)).unwrap_or(text.len())
}

#[derive(PartialEq, Eq, Clone, Copy)]
enum Class {
    Word,
    Space,
    Punct,
}

fn class(c: char) -> Class {
    if c.is_alphanumeric() || c == '_' {
        Class::Word
    } else if c.is_whitespace() {
        Class::Space
    } else {
        Class::Punct
    }
}

/// Option/Ctrl+Left: back over spaces and punctuation, then to the start of the word.
fn word_left(text: &str, offset: usize) -> usize {
    let mut at = offset;
    let mut chars = text[..offset].char_indices().rev().peekable();
    while let Some((i, _)) = chars.next_if(|(_, c)| class(*c) != Class::Word) {
        at = i;
    }
    while let Some((i, _)) = chars.next_if(|(_, c)| class(*c) == Class::Word) {
        at = i;
    }
    at
}

/// Option/Ctrl+Right: forward over spaces and punctuation, then to the end of the word.
fn word_right(text: &str, offset: usize) -> usize {
    let mut chars = text[offset..].char_indices().peekable();
    while chars.next_if(|(_, c)| class(*c) != Class::Word).is_some() {}
    while chars.next_if(|(_, c)| class(*c) == Class::Word).is_some() {}
    chars.peek().map_or(text.len(), |(i, _)| offset + i)
}

/// The run of same-class characters at `offset`, for a double click.
fn word_at(text: &str, offset: usize) -> Range<usize> {
    let Some(c) = text[offset..].chars().next().or_else(|| text[..offset].chars().next_back()) else { return offset..offset };
    let kind = class(c);
    let start = text[..offset].char_indices().rev().take_while(|(_, c)| class(*c) == kind).last().map_or(offset, |(i, _)| i);
    let end = text[offset..].char_indices().find(|(_, c)| class(*c) != kind).map_or(text.len(), |(i, _)| offset + i);
    start..end
}

/// The hard line at `offset`, without its newline.
fn line_at(text: &str, offset: usize) -> Range<usize> {
    let start = text[..offset].rfind('\n').map_or(0, |i| i + 1);
    let end = text[offset..].find('\n').map_or(text.len(), |i| offset + i);
    start..end
}

#[cfg(test)]
mod tests;
