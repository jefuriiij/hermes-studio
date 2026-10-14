// Model-controlled text made safe to show. Pure.

/**
 * Control characters, zero-width characters and bidi overrides ("Trojan
 * Source") become visible escapes, so nothing can hide part of a command or a
 * diff line, or reorder it on screen.
 */
export function visibleChars(text: string): string {
  let out = "";
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const invisible =
      (c < 0x20 && ch !== "\n" && ch !== "\t") ||
      (c >= 0x7f && c <= 0x9f) ||
      (c >= 0x200b && c <= 0x200f) ||
      (c >= 0x202a && c <= 0x202e) ||
      (c >= 0x2066 && c <= 0x2069) ||
      c === 0xfeff;
    out += invisible ? `\\u{${c.toString(16).toUpperCase()}}` : ch;
  }
  return out;
}
