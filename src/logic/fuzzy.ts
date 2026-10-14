// The composer's "@" list: workspace paths ranked for what was typed. Pure.

import type { PathHit } from "../shared/protocol";

export type { PathHit };

/**
 * Best first: the name starts with the query, then the name contains it, then
 * the path contains it, then the letters appear in order in the name. Ties go
 * to the shorter path (closer to the root), then alphabetical. Case-blind.
 * An empty query lists files by path, folders last.
 */
export function rankPaths(hits: readonly PathHit[], query: string, limit = 20): PathHit[] {
  const q = query.toLowerCase().replace(/\\/g, "/");
  const scored: { hit: PathHit; score: number }[] = [];
  for (const hit of hits) {
    const score = scorePath(hit, q);
    if (score > 0) scored.push({ hit, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.hit.path.length - b.hit.path.length ||
      a.hit.path.localeCompare(b.hit.path),
  );
  return scored.slice(0, limit).map((s) => s.hit);
}

function scorePath(hit: PathHit, q: string): number {
  const path = hit.path.toLowerCase();
  const name = baseName(path);
  if (!q) return hit.kind === "file" ? 2 : 1;
  // A query with a slash is about the path.
  if (q.includes("/")) return path.includes(q) ? 50 : 0;
  if (name.startsWith(q)) return 100;
  if (name.includes(q)) return 80;
  if (path.includes(q)) return 60;
  return inOrder(name, q) ? 40 : 0;
}

function inOrder(text: string, q: string): boolean {
  let i = 0;
  for (const ch of text) if (ch === q[i] && ++i === q.length) return true;
  return false;
}

export function baseName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}

export function dirName(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  const i = trimmed.lastIndexOf("/");
  return i < 0 ? "" : trimmed.slice(0, i);
}

/** Every folder that holds one of these files (the "@" list offers folders too). */
export function foldersOf(files: readonly string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    let d = dirName(f);
    while (d && !out.has(d)) {
      out.add(d);
      d = dirName(d);
    }
  }
  return [...out];
}
