// File paths in Hermes's replies (mock board 23): inline code that looks like
// a path is offered to the host, and only a real file becomes a gold,
// clickable pill. Pure, and imported by relative path (not $shared) so the
// main test suite can load it.

/** `src/a.ts`, `pages/contact.html`, `README.md`, `src/a.ts:42` — the path and
 *  the line, or undefined for anything that is not path-shaped. A false
 *  positive is harmless: the host checks the file exists first. */
export function pathRef(text: string): { path: string; line?: number } | undefined {
  const t = text.trim();
  if (t.length < 2 || t.length > 300 || /\s/.test(t)) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t)) return undefined; // a URL
  const m = /^(.*?)(?::(\d{1,7})(?::\d{1,5})?)?$/.exec(t);
  const path = m?.[1] ?? t;
  const line = m?.[2] ? Number(m[2]) : undefined;
  const name = path.split(/[\\/]/).pop() ?? "";
  // A folder part, or a file name with a letter in its extension ("1.2.3" is
  // a version, not a file).
  const hasDir = /[\\/]/.test(path) && name.length > 0;
  const hasExt = /^[^.].*\.[A-Za-z0-9]*[A-Za-z][A-Za-z0-9]*$/.test(name);
  if (!hasDir && !hasExt) return undefined;
  return line && line > 0 ? { path, line } : { path };
}

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
  /** The newest step that changed it: "Open diff" shows that change. */
  toolId: string;
  edits: number;
}

/** The files a reply's steps changed, in the order first changed. */
export function changedFiles(
  tools: readonly { id: string; diff?: { path: string; added: number; removed: number } }[],
): ChangedFile[] {
  const byPath = new Map<string, ChangedFile>();
  for (const t of tools) {
    const d = t.diff;
    if (!d?.path) continue;
    const f = byPath.get(d.path);
    if (f) {
      f.added += d.added;
      f.removed += d.removed;
      f.toolId = t.id;
      f.edits++;
    } else {
      byPath.set(d.path, {
        path: d.path,
        added: d.added,
        removed: d.removed,
        toolId: t.id,
        edits: 1,
      });
    }
  }
  return [...byPath.values()];
}
