// How the Sessions view shows Hermes's list: grouped by day, with short
// relative times, filtered by a search. Pure: no DOM, no Svelte, and imported
// by relative path (not $shared) so the main test suite can load it.

import type { BackgroundSession, SessionSummary } from "../../shared/protocol";
import { daysBetween, parseTime, relativeTime, shortAgo } from "../../shared/time";

export { parseTime, relativeTime, shortAgo };

export interface SessionGroup {
  label: "Today" | "Yesterday" | "This week" | "Older";
  items: SessionSummary[];
}

/** Hermes's order (newest first) is kept inside each group. */
export function groupSessions(items: readonly SessionSummary[], now: number): SessionGroup[] {
  const order: SessionGroup["label"][] = ["Today", "Yesterday", "This week", "Older"];
  const byLabel = new Map<SessionGroup["label"], SessionSummary[]>();
  for (const s of items) {
    const t = parseTime(s.updatedAt);
    const days = t === undefined ? Number.POSITIVE_INFINITY : daysBetween(t, now);
    const label = days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 7 ? "This week" : "Older";
    const list = byLabel.get(label) ?? [];
    list.push(s);
    byLabel.set(label, list);
  }
  return order.flatMap((label) => {
    const list = byLabel.get(label);
    return list ? [{ label, items: list }] : [];
  });
}

/** Case- and accent-insensitive match on the title; every word must appear. */
export function filterSessions<T extends SessionSummary>(items: readonly T[], query: string): T[] {
  const fold = (s: string) => s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const words = fold(query).split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...items];
  return items.filter((s) => {
    const title = fold(s.title ?? "");
    return words.every((w) => title.includes(w));
  });
}

export const UNTITLED = "Untitled session";

/** A row of the pop-up: a saved session, marked when it works in the background. */
export type SessionRow = SessionSummary & { state?: BackgroundSession["state"] };

/** Waiting for you first, then working, then what ended while you were away. */
const RANK: Record<BackgroundSession["state"], number> = {
  waiting: 0,
  working: 1,
  stopped: 2,
  done: 2,
};

/** Still running in Hermes (a name change or a delete waits for it). */
export const isRunning = (state: BackgroundSession["state"] | undefined): boolean =>
  state === "working" || state === "waiting";

/**
 * The chats working in the background go on top — those waiting for you
 * first — whether or not Hermes lists them yet (it lists a session only once
 * one of its turns has ended), then the ones that finished or stopped while
 * you were away. The rest keep Hermes's order.
 */
export function withBackground(
  items: readonly SessionSummary[],
  background: readonly BackgroundSession[],
): SessionRow[] {
  const listed = new Map(items.map((s) => [s.id, s]));
  const top = [...background]
    .sort((a, b) => RANK[a.state] - RANK[b.state])
    .map((b): SessionRow => {
      const s = listed.get(b.id);
      return { ...(s ?? { id: b.id }), title: s?.title ?? b.title, state: b.state };
    });
  const busy = new Set(background.map((b) => b.id));
  return [...top, ...items.filter((s) => !busy.has(s.id))];
}
