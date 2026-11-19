// Motion out of reach under a modal: the app under Settings (inert, and blurred whole: sheet.module.css), or a row
// leaving (inert as it fades). A loop draws nothing there. Under the blur, any frame drawn redraws the whole window's
// blur: the beat's glyphs and the bots stepping under Settings dropped its frames at rest (8-21 frames over 25 ms in
// 10 s on a machine compositing in software, none with nothing moving under it).
export const covered = (el: Element | null | undefined): boolean => el?.closest("[inert]") != null;
