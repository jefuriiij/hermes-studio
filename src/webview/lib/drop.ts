// Files dragged into the composer. Pure, and imported by relative path (not
// $shared) so the main test suite can load it.

/**
 * The URIs of a drop's `text/uri-list` (RFC 2483: one per line, "#" lines are
 * comments) or VS Code's `application/vnd.code.uri-list` (the same format).
 * Only file-like URIs; the host checks each one again.
 */
export function uriList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#") && /^[a-z][a-z0-9+.-]*:\/\//i.test(l));
}
