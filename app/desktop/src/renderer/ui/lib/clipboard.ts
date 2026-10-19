/**
 * Copies text. The async Clipboard API works in a focused Electron renderer; the execCommand path covers a
 * renderer that lost focus between the click and the write (it needs no permission).
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    // Deprecated but still the one copy path that needs no permission; the shell denies permission checks.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}
