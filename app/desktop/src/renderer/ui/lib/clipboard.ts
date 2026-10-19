/**
 * Copies text through main (window.fleetd.copy): the page has no clipboard permission, because Electron grants
 * clipboard writes and reads together. Resolves false when main refuses (over 1 MB) or the bridge is missing.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    await window.fleetd.copy(text);
    return true;
  } catch {
    return false;
  }
}
