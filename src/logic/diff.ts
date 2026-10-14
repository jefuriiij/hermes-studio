// Unified line diffs for approval cards and tool steps. Pure.
//
// Hermes sends edits as ACP diff blocks {path, oldText?, newText}: a missing
// oldText is a new file, and a V4A multi-file patch arrives as newText only,
// already in patch form ("*** Begin Patch"). Model-controlled text is made
// visible (bidi overrides, zero-width and control characters as escapes) and
// capped per line, so a card can never hide or reorder part of a change.

import type { DiffLine, DiffView } from "../shared/chat";
import { visibleChars } from "./safeText";

/** Unchanged lines kept around each change. */
const CONTEXT = 3;
/** Lines in one card; the rest is behind "Open diff". */
const MAX_LINES = 300;
/** Characters per line (a minified file is one enormous line). */
const LINE_MAX = 400;
/** Characters kept either side of a change inside one long line. */
const FOCUS = 120;
/** Above this many lines in the changed middle, skip the exact diff (its cost
 *  grows with lines × changes) and show the middle as removed-then-added. */
const EXACT_LIMIT = 4000;

type Op = { op: "eq"; a: number; b: number } | { op: "del"; a: number } | { op: "add"; b: number };

/** A final newline ends the last line; it does not start an empty one. */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function buildDiff(path: string, oldText: string | undefined, newText: string): DiffView {
  if (oldText === undefined && /^\*\*\* Begin Patch/.test(newText)) return patchView(path, newText);
  const a = splitLines(oldText ?? "");
  const b = splitLines(newText);

  // Common head and tail cost nothing to find and shrink the real work.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) {
    tail++;
  }
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const ops: Op[] = [];
  for (let i = 0; i < head; i++) ops.push({ op: "eq", a: i, b: i });
  for (const o of midA.length + midB.length > EXACT_LIMIT
    ? blockOps(midA, midB)
    : myers(midA, midB)) {
    if (o.op === "eq") ops.push({ op: "eq", a: o.a + head, b: o.b + head });
    else if (o.op === "del") ops.push({ op: "del", a: o.a + head });
    else ops.push({ op: "add", b: o.b + head });
  }
  for (let i = tail; i > 0; i--) ops.push({ op: "eq", a: a.length - i, b: b.length - i });

  return render(path, a, b, ops);
}

/** Myers' O((N+M)·D) shortest edit script. */
function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  if (max === 0) return [];
  const off = max;
  const v = new Int32Array(2 * max + 2);
  const trace: Int32Array[] = [];
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x =
        k === -d || (k !== d && (v[off + k - 1] as number) < (v[off + k + 1] as number))
          ? (v[off + k + 1] as number)
          : (v[off + k - 1] as number) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
  }
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = found; d >= 0; d--) {
    const tv = trace[d] as Int32Array;
    const k = x - y;
    const prevK =
      k === -d || (k !== d && (tv[off + k - 1] as number) < (tv[off + k + 1] as number))
        ? k + 1
        : k - 1;
    const prevX = tv[off + prevK] as number;
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      x--;
      y--;
      ops.push({ op: "eq", a: x, b: y });
    }
    if (d > 0) {
      if (x === prevX) ops.push({ op: "add", b: y - 1 });
      else ops.push({ op: "del", a: x - 1 });
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

function blockOps(a: string[], b: string[]): Op[] {
  return [
    ...a.map((_, i): Op => ({ op: "del", a: i })),
    ...b.map((_, i): Op => ({ op: "add", b: i })),
  ];
}

function clip(text: string): string {
  const safe = visibleChars(text);
  return safe.length <= LINE_MAX
    ? safe
    : `${safe.slice(0, LINE_MAX)}… (+${safe.length - LINE_MAX} chars)`;
}

/** One changed long line: show the region around the change, not its start. */
function focusPair(x: string, y: string): [string, string] {
  let p = 0;
  while (p < x.length && p < y.length && x[p] === y[p]) p++;
  let s = 0;
  while (s < x.length - p && s < y.length - p && x[x.length - 1 - s] === y[y.length - 1 - s]) s++;
  const from = Math.max(0, p - FOCUS);
  const cut = (t: string): string => {
    const to = Math.min(t.length, t.length - s + FOCUS);
    return `${from > 0 ? "…" : ""}${t.slice(from, to)}${to < t.length ? "…" : ""}`;
  };
  return [cut(x), cut(y)];
}

function render(path: string, a: string[], b: string[], ops: Op[]): DiffView {
  const added = ops.filter((o) => o.op === "add").length;
  const removed = ops.filter((o) => o.op === "del").length;
  // Keep only changes and CONTEXT lines around them; fold the rest into gaps.
  const keep = new Array<boolean>(ops.length).fill(false);
  ops.forEach((o, i) => {
    if (o.op === "eq") return;
    for (let j = Math.max(0, i - CONTEXT); j <= Math.min(ops.length - 1, i + CONTEXT); j++)
      keep[j] = true;
  });

  const lines: DiffLine[] = [];
  let truncated = false;
  let skipped = 0;
  const flushGap = () => {
    if (skipped > 0)
      lines.push({ kind: "gap", text: `${skipped} unchanged line${skipped === 1 ? "" : "s"}` });
    skipped = 0;
  };
  for (let i = 0; i < ops.length; i++) {
    const o = ops[i] as Op;
    if (!keep[i]) {
      skipped++;
      continue;
    }
    flushGap();
    if (lines.length >= MAX_LINES) {
      truncated = true;
      break;
    }
    const next = ops[i + 1];
    if (
      o.op === "del" &&
      next?.op === "add" &&
      ops[i + 2]?.op !== "add" &&
      ops[i - 1]?.op !== "del"
    ) {
      // A single line replaced by a single line: if it is long, focus the change.
      const before = a[o.a] as string;
      const after = b[next.b] as string;
      if (before.length > LINE_MAX || after.length > LINE_MAX) {
        const [x, y] = focusPair(before, after);
        lines.push({ kind: "del", text: clip(x), oldNo: o.a + 1 });
        lines.push({ kind: "add", text: clip(y), newNo: next.b + 1 });
        i++;
        continue;
      }
    }
    if (o.op === "eq")
      lines.push({ kind: "ctx", text: clip(a[o.a] as string), oldNo: o.a + 1, newNo: o.b + 1 });
    else if (o.op === "del")
      lines.push({ kind: "del", text: clip(a[o.a] as string), oldNo: o.a + 1 });
    else lines.push({ kind: "add", text: clip(b[o.b] as string), newNo: o.b + 1 });
  }
  if (!truncated) flushGap();
  // A pure trailing gap says nothing useful.
  if (lines.at(-1)?.kind === "gap") lines.pop();
  return { path, added, removed, lines, truncated };
}

/** A V4A patch is already a diff: classify its lines as they are. */
function patchView(path: string, patch: string): DiffView {
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  let truncated = false;
  for (const raw of patch.split(/\r?\n/)) {
    if (raw.startsWith("+")) added++;
    else if (raw.startsWith("-")) removed++;
    if (lines.length >= MAX_LINES) {
      truncated = true;
      continue;
    }
    if (raw.startsWith("+")) lines.push({ kind: "add", text: clip(raw.slice(1)) });
    else if (raw.startsWith("-")) lines.push({ kind: "del", text: clip(raw.slice(1)) });
    else if (raw.startsWith("***") || raw.startsWith("@@"))
      lines.push({ kind: "gap", text: clip(raw) });
    else lines.push({ kind: "ctx", text: clip(raw.startsWith(" ") ? raw.slice(1) : raw) });
  }
  return { path, added, removed, lines, truncated };
}
