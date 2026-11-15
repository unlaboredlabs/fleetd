// Standard base64 with what every JavaScript runtime has (atob, btoa): main's sealing and the web app's share it, and a
// browser has no Buffer.

/** The bytes of standard base64, or null when it isn't. */
export const fromBase64 = (text: string): Uint8Array | null => {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  // In pieces: String.fromCharCode takes its bytes as arguments, and a call has only so many.
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};
