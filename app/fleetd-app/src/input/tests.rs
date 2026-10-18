//! Each text field behaviour, driven through gpui's headless test window with the real key bindings.

use gpui::{
    ClipboardItem, Entity, Modifiers, MouseButton, MouseDownEvent, MouseMoveEvent, MouseUpEvent, TestAppContext, VisualTestContext, point, px,
};

use super::*;

/// Cmd on macOS, Ctrl elsewhere.
const PRIMARY: &str = if cfg!(target_os = "macos") { "cmd" } else { "ctrl" };
/// Word motion: Option on macOS, Ctrl elsewhere.
const WORD: &str = if cfg!(target_os = "macos") { "alt" } else { "ctrl" };

fn field(cx: &mut TestAppContext, build: impl FnOnce(TextInput) -> TextInput) -> (Entity<TextInput>, &mut VisualTestContext) {
    cx.update(bind_keys);
    let (input, cx) = cx.add_window_view(|_, cx| build(TextInput::new(cx)));
    cx.update(|window, cx| {
        let focus = input.read(cx).focus.clone();
        window.focus(&focus, cx);
    });
    (input, cx)
}

fn text(input: &Entity<TextInput>, cx: &mut VisualTestContext) -> String {
    input.read_with(cx, |i, _| i.text().to_string())
}

fn selection(input: &Entity<TextInput>, cx: &mut VisualTestContext) -> Range<usize> {
    input.read_with(cx, |i, _| i.selected.clone())
}

fn keys(cx: &mut VisualTestContext, keystrokes: &str) {
    cx.simulate_keystrokes(keystrokes);
    cx.run_until_parked();
}

fn events(input: &Entity<TextInput>, cx: &mut VisualTestContext) -> std::rc::Rc<std::cell::RefCell<Vec<InputEvent>>> {
    let seen = std::rc::Rc::new(std::cell::RefCell::new(Vec::new()));
    let sink = seen.clone();
    cx.update(|_, cx| cx.subscribe(input, move |_, e: &InputEvent, _| sink.borrow_mut().push(e.clone())).detach());
    seen
}

/// Window position of display offset `offset` on the field's first row.
fn point_at(input: &Entity<TextInput>, cx: &mut VisualTestContext, offset: usize) -> Point<Pixels> {
    cx.run_until_parked();
    input.read_with(cx, |i, _| {
        let layout = i.layout.as_ref().expect("painted");
        let (row, x) = i.locate(layout, offset);
        layout.bounds.origin + point(x + px(0.5), layout.line_height * row as f32 + layout.line_height / 2.)
    })
}

fn click(cx: &mut VisualTestContext, at: Point<Pixels>, count: usize, shift: bool) {
    let modifiers = Modifiers { shift, ..Default::default() };
    cx.simulate_event(MouseDownEvent { button: MouseButton::Left, position: at, modifiers, click_count: count, first_mouse: false });
    cx.simulate_event(MouseUpEvent { button: MouseButton::Left, position: at, modifiers, click_count: count });
    cx.run_until_parked();
}

#[gpui::test]
fn typing_inserts_at_the_caret(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i);
    cx.simulate_input("helo");
    keys(cx, "left");
    cx.simulate_input("l");
    assert_eq!(text(&input, cx), "hello");
    assert_eq!(selection(&input, cx), 4..4);
}

#[gpui::test]
fn select_all_then_typing_replaces(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i);
    cx.simulate_input("old text");
    keys(cx, &format!("{PRIMARY}-a"));
    assert_eq!(selection(&input, cx), 0..8);
    cx.simulate_input("new");
    assert_eq!(text(&input, cx), "new");
}

#[gpui::test]
fn copy_cut_and_paste_use_the_clipboard(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i);
    cx.simulate_input("abc def");
    keys(cx, &format!("{PRIMARY}-a {PRIMARY}-c"));
    assert_eq!(cx.read_from_clipboard().and_then(|c| c.text()).as_deref(), Some("abc def"));
    keys(cx, &format!("end {PRIMARY}-v {PRIMARY}-v"));
    assert_eq!(text(&input, cx), "abc defabc defabc def");
    // A single-line field pastes multi-line text as one line.
    cx.write_to_clipboard(ClipboardItem::new_string("x\ny".into()));
    keys(cx, &format!("{PRIMARY}-a {PRIMARY}-v"));
    assert_eq!(text(&input, cx), "x y");
}

#[gpui::test]
fn cut_removes_the_selection(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i);
    cx.simulate_input("keep drop");
    keys(cx, &format!("{WORD}-shift-left {PRIMARY}-x"));
    assert_eq!(text(&input, cx), "keep ");
    assert_eq!(cx.read_from_clipboard().and_then(|c| c.text()).as_deref(), Some("drop"));
}

#[gpui::test]
fn undo_and_redo_step_through_edits(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i);
    cx.simulate_input("one");
    cx.simulate_input(" two");
    keys(cx, &format!("{PRIMARY}-z"));
    assert_eq!(text(&input, cx), "one");
    keys(cx, &format!("{PRIMARY}-z"));
    assert_eq!(text(&input, cx), "");
    keys(cx, &format!("{PRIMARY}-shift-z"));
    assert_eq!(text(&input, cx), "one");
    if !cfg!(target_os = "macos") {
        keys(cx, "ctrl-y");
        assert_eq!(text(&input, cx), "one two");
    }
}

#[gpui::test]
fn word_motion_and_word_selection(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i);
    cx.simulate_input("fleetd pair --name mac");
    keys(cx, &format!("{WORD}-left"));
    assert_eq!(selection(&input, cx), 19..19);
    keys(cx, &format!("{WORD}-left"));
    assert_eq!(selection(&input, cx), 14..14);
    keys(cx, &format!("{WORD}-shift-left"));
    assert_eq!(selection(&input, cx), 7..14);
    keys(cx, &format!("{WORD}-right"));
    assert_eq!(selection(&input, cx), 18..18);
    keys(cx, &format!("{WORD}-shift-right"));
    assert_eq!(selection(&input, cx), 18..22);
}

#[gpui::test]
fn line_start_and_end_with_selection(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i);
    cx.simulate_input("http://127.0.0.1:4790");
    keys(cx, "home");
    assert_eq!(selection(&input, cx), 0..0);
    keys(cx, "shift-end");
    assert_eq!(selection(&input, cx), 0..21);
    if cfg!(target_os = "macos") {
        keys(cx, "cmd-left");
        assert_eq!(selection(&input, cx), 0..0);
        keys(cx, "cmd-shift-right");
        assert_eq!(selection(&input, cx), 0..21);
    }
}

#[gpui::test]
fn deleting_by_word_and_to_line_start(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i);
    cx.simulate_input("go with the rec");
    keys(cx, &format!("{WORD}-backspace"));
    assert_eq!(text(&input, cx), "go with the ");
    keys(cx, "home");
    keys(cx, &format!("{WORD}-delete"));
    assert_eq!(text(&input, cx), " with the ");
    keys(cx, "end");
    let to_start = if cfg!(target_os = "macos") { "cmd-backspace" } else { "ctrl-shift-backspace" };
    keys(cx, to_start);
    assert_eq!(text(&input, cx), "");
}

#[gpui::test]
fn backspace_removes_a_whole_emoji(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i);
    cx.simulate_input("ok 👍🏽");
    keys(cx, "backspace");
    assert_eq!(text(&input, cx), "ok ");
    cx.simulate_input("🇳🇱");
    keys(cx, "left");
    assert_eq!(selection(&input, cx), 3..3);
}

#[gpui::test]
fn ime_composition_marks_then_commits(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i);
    cx.simulate_input("a");
    cx.update(|window, cx| {
        input.update(cx, |i, cx| {
            i.replace_and_mark_text_in_range(None, "に", None, window, cx);
            assert_eq!(i.marked_text_range(window, cx), Some(1..2));
            i.replace_and_mark_text_in_range(None, "にほ", Some(2..2), window, cx);
            i.replace_text_in_range(None, "日本", window, cx);
        })
    });
    assert_eq!(text(&input, cx), "a日本");
    assert_eq!(input.read_with(cx, |i, _| i.marked.clone()), None);
}

#[gpui::test]
fn click_places_the_caret_and_shift_click_extends(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i);
    cx.simulate_input("abcdef");
    let at = point_at(&input, cx, 2);
    click(cx, at, 1, false);
    assert_eq!(selection(&input, cx), 2..2);
    let at = point_at(&input, cx, 5);
    click(cx, at, 1, true);
    assert_eq!(selection(&input, cx), 2..5);
}

#[gpui::test]
fn double_click_selects_a_word_and_triple_click_a_line(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i.multi_line(4));
    cx.simulate_input("first line");
    keys(cx, "shift-enter");
    cx.simulate_input("second");
    let at = point_at(&input, cx, 7);
    click(cx, at, 2, false);
    assert_eq!(selection(&input, cx), 6..10);
    click(cx, at, 3, false);
    assert_eq!(selection(&input, cx), 0..10);
}

#[gpui::test]
fn drag_selects(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i);
    cx.simulate_input("drag me please");
    let from = point_at(&input, cx, 5);
    let to = point_at(&input, cx, 13);
    cx.simulate_event(MouseDownEvent {
        button: MouseButton::Left,
        position: from,
        modifiers: Modifiers::default(),
        click_count: 1,
        first_mouse: false,
    });
    cx.simulate_event(MouseMoveEvent { position: to, pressed_button: Some(MouseButton::Left), modifiers: Modifiers::default() });
    cx.simulate_event(MouseUpEvent { button: MouseButton::Left, position: to, modifiers: Modifiers::default(), click_count: 1 });
    cx.run_until_parked();
    assert_eq!(selection(&input, cx), 5..13);
}

#[gpui::test]
fn enter_submits_and_shift_enter_adds_a_line(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i.multi_line(4));
    let seen = events(&input, cx);
    cx.simulate_input("1 go");
    keys(cx, "shift-enter");
    cx.simulate_input("2 nvm");
    assert_eq!(text(&input, cx), "1 go\n2 nvm");
    assert!(!seen.borrow().contains(&InputEvent::Submit));
    keys(cx, "enter");
    assert!(seen.borrow().contains(&InputEvent::Submit));
    keys(cx, "escape");
    assert!(seen.borrow().contains(&InputEvent::Cancel));
}

#[gpui::test]
fn single_line_field_ignores_shift_enter(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i);
    cx.simulate_input("a");
    keys(cx, "shift-enter");
    assert_eq!(text(&input, cx), "a");
}

#[gpui::test]
fn up_and_down_move_between_lines(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i.multi_line(4));
    cx.simulate_input("abcdef");
    keys(cx, "shift-enter");
    cx.simulate_input("xy");
    keys(cx, "up");
    // The goal column is past the end of the shorter line below, and kept on the way back.
    assert_eq!(selection(&input, cx), 2..2);
    keys(cx, "end up");
    assert_eq!(selection(&input, cx), 0..0);
    keys(cx, "end down");
    assert_eq!(selection(&input, cx), 9..9);
}

#[gpui::test]
fn up_on_an_empty_field_recalls_history(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i.multi_line(4));
    input.update(cx, |i, _| {
        i.remember("1 go");
        i.remember("2 b");
    });
    keys(cx, "up");
    assert_eq!(text(&input, cx), "2 b");
    keys(cx, "up");
    assert_eq!(text(&input, cx), "1 go");
    keys(cx, "down");
    assert_eq!(text(&input, cx), "2 b");
    keys(cx, "down");
    assert_eq!(text(&input, cx), "");
    // Not while there is text of your own.
    cx.simulate_input("draft");
    keys(cx, "up");
    assert_eq!(text(&input, cx), "draft");
}

#[gpui::test]
fn masked_field_shows_bullets_and_never_copies(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i.masked(8));
    let seen = events(&input, cx);
    cx.write_to_clipboard(ClipboardItem::new_string("sk-12345\n".into()));
    keys(cx, &format!("{PRIMARY}-v"));
    assert_eq!(text(&input, cx), "sk-12345");
    assert_eq!(input.read_with(cx, |i, _| i.display()), "••••••••");
    cx.write_to_clipboard(ClipboardItem::new_string("other".into()));
    keys(cx, &format!("{PRIMARY}-a {PRIMARY}-c {PRIMARY}-x"));
    assert_eq!(cx.read_from_clipboard().and_then(|c| c.text()).as_deref(), Some("other"));
    assert_eq!(text(&input, cx), "sk-12345");
    keys(cx, "end");
    cx.simulate_input("9");
    assert_eq!(text(&input, cx), "sk-12345");
    assert!(seen.borrow().contains(&InputEvent::TooLong));
    input.update(cx, |i, cx| i.clear(cx));
    assert_eq!(text(&input, cx), "");
}

#[gpui::test]
fn masked_buffer_never_reallocates(cx: &mut TestAppContext) {
    let (input, cx) = field(cx, |i| i.masked(64));
    let start = input.read_with(cx, |i, _| i.text.as_ptr());
    cx.simulate_input("pä");
    cx.write_to_clipboard(ClipboardItem::new_string("x".repeat(61)));
    keys(cx, &format!("{PRIMARY}-v backspace backspace"));
    assert_eq!(input.read_with(cx, |i, _| (i.text.as_ptr(), i.text.len())), (start, 62));
}

#[test]
fn word_boundaries() {
    let t = "fleetd://pair?hub=x";
    assert_eq!(word_left(t, t.len()), 18);
    assert_eq!(word_left(t, 18), 14);
    assert_eq!(word_left(t, 6), 0);
    assert_eq!(word_right(t, 0), 6);
    assert_eq!(word_right(t, 6), 13);
    assert_eq!(word_at(t, 10), 9..13);
    assert_eq!(word_at("a  b", 2), 1..3);
    assert_eq!(line_at("ab\ncd\nef", 4), 3..5);
}
