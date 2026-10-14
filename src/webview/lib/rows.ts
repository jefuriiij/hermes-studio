// How the transcript is laid out: the flat item list becomes rows. Pure: no
// DOM, no Svelte, and imported by relative path (not $shared) so the main test
// suite can load it.

import type { ChatItem, ToolStatus } from "../../shared/chat";

export type ToolEntry = Extract<ChatItem, { kind: "tool" }>;
type NonTool = Exclude<ChatItem, { kind: "tool" }>;

/**
 * `head`: the first Hermes row of its turn, which carries the "Hermes" label.
 * Consecutive tool calls in one turn share a single card, keyed by the first
 * call's id — that id never changes as more calls join, so the card keeps its
 * DOM (and its open/closed state) while the turn runs.
 */
export type Row =
  | { kind: "item"; key: string; item: NonTool; head: boolean }
  | { kind: "tools"; key: string; tools: ToolEntry[]; head: boolean }
  /** After the last row of a reply (mock board 23): its changed files and
   *  its footer. Only with `{ ends: true }`. */
  | { kind: "end"; key: string; turn: number };

/** Items Hermes produced itself; a host notice is not "Hermes speaking". */
function isAgent(item: ChatItem): boolean {
  return item.kind === "assistant" || item.kind === "thought" || item.kind === "tool";
}

export function buildRows(
  items: readonly ChatItem[],
  opts: { ends?: boolean; openTurn?: number } = {},
): Row[] {
  const rows = rowsOf(items);
  if (!opts.ends) return rows;
  // The last row of each turn Hermes answered in, except the turn still running.
  const lastOf = new Map<number, number>();
  rows.forEach((r, i) => {
    const turn =
      r.kind === "tools" ? r.tools[0]?.turn : r.kind === "item" ? r.item.turn : undefined;
    if (turn === undefined || turn === opts.openTurn) return;
    if (r.kind === "tools" || (r.kind === "item" && isAgent(r.item))) lastOf.set(turn, i);
    else if (lastOf.has(turn)) lastOf.set(turn, i); // a notice after the reply
  });
  const out: Row[] = [];
  const endAt = new Map([...lastOf].map(([turn, i]) => [i, turn]));
  rows.forEach((r, i) => {
    out.push(r);
    const turn = endAt.get(i);
    if (turn !== undefined) out.push({ kind: "end", key: `end:${turn}`, turn });
  });
  return out;
}

function rowsOf(items: readonly ChatItem[]): Row[] {
  const rows: Row[] = [];
  const headed = new Set<number>();
  let group: Extract<Row, { kind: "tools" }> | undefined;

  for (const item of items) {
    const head = isAgent(item) && !headed.has(item.turn);
    if (head) headed.add(item.turn);

    if (item.kind === "tool") {
      if (group && group.tools[0]?.turn === item.turn) {
        group.tools.push(item);
        continue;
      }
      group = { kind: "tools", key: item.id, tools: [item], head };
      rows.push(group);
      continue;
    }
    group = undefined;
    rows.push({ kind: "item", key: item.id, item, head });
  }
  return rows;
}

export interface ToolTitle {
  /** "Read", "Terminal", … — empty when the title has no `verb:` prefix. */
  label: string;
  /** The rest: a path, a command, a query. */
  detail: string;
}

/** Hermes titles tool calls `verb: detail` ("read: src/a.ts", "terminal: npm test"). */
export function parseToolTitle(title: string): ToolTitle {
  const m = /^([a-z][\w -]{0,23}):\s+(.+)$/is.exec(title.trim());
  if (!m) return { label: "", detail: title.trim() };
  const verb = (m[1] as string).trim();
  return { label: verb.charAt(0).toUpperCase() + verb.slice(1), detail: (m[2] as string).trim() };
}

const VERBS: Record<string, string> = {
  read: "Reading",
  edit: "Editing",
  delete: "Deleting",
  move: "Moving",
  search: "Searching",
  execute: "Running",
  think: "Thinking",
  fetch: "Fetching",
};

/** The live line under the transcript while a tool runs: "Running npm test". */
export function toolActivity(tool: ToolEntry): string {
  const { label, detail } = parseToolTitle(tool.title);
  const verb = (tool.toolKind && VERBS[tool.toolKind]) || label || "Running";
  return `${verb} ${detail}`;
}

export interface ToolCounts {
  running: number;
  completed: number;
  failed: number;
}

export function countTools(tools: readonly ToolEntry[]): ToolCounts {
  const counts: Record<ToolStatus, number> = { running: 0, completed: 0, failed: 0 };
  for (const t of tools) counts[t.status]++;
  return counts;
}

/** "3 done, 1 running" — zero counts are left out. */
export function describeCounts(c: ToolCounts): string {
  const parts: string[] = [];
  if (c.completed) parts.push(`${c.completed} done`);
  if (c.failed) parts.push(`${c.failed} failed`);
  if (c.running) parts.push(`${c.running} running`);
  return parts.join(", ");
}

/** What Hermes is doing right now, for the live line. `undefined` when idle. */
export function currentActivity(
  items: readonly ChatItem[],
  busy: boolean,
  turn: number,
): string | undefined {
  if (!busy) return undefined;
  // Hermes is blocked on the user: nothing else it "does" matters until then.
  if (waitingForApproval(items)) return "Waiting for your approval";
  // The newest item wins: text streaming after a call whose final status never
  // arrived is "Writing", not that stale call.
  const last = items.at(-1);
  if (last?.turn === turn) {
    if (last.kind === "tool" && last.status === "running") return toolActivity(last);
    if (last.kind === "thought") return "Thinking";
    if (last.kind === "assistant") return "Writing";
  }
  // Calls can overlap: the newest one finished, an earlier one still runs.
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i] as ChatItem;
    if (it.turn !== turn) break;
    if (it.kind === "tool" && it.status === "running") return toolActivity(it);
  }
  return "Working";
}

/** An approval card is waiting for the user. */
export function waitingForApproval(items: readonly ChatItem[]): boolean {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i] as ChatItem;
    if (it.kind === "permission" && it.state === "pending") return true;
  }
  return false;
}

/** 7 → "7s", 75 → "1m 15s". */
export function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
