// The empty chat's "Hermes learned …" row (mock board 2), from the panels'
// snapshot of Hermes's files. Pure, and imported by relative path (not
// $shared) so the main test suite can load it.

import type { PanelsView } from "../../shared/panels";
import { daysBetween } from "../../shared/time";

export type LearnedRow =
  /** Something changed since you last looked at Learning: the newest one. */
  | { kind: "fresh"; title: string; skill: string; when: string; more: number }
  /** This week, quietly: counts, and when the curator last ran. */
  | { kind: "week"; text: string; curator?: string };

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** "just now", "12 min ago", "3 h ago", "yesterday", "4 days ago", "on Sep 3". */
export function agoPhrase(t: number, now: number, locale?: string): string {
  const ago = Math.max(0, now - t);
  if (ago < 60_000) return "just now";
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)} min ago`;
  if (ago < 86_400_000) return `${Math.floor(ago / 3_600_000)} h ago`;
  const days = daysBetween(t, now);
  if (days <= 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return `on ${new Date(t).toLocaleDateString(locale, { month: "short", day: "numeric" })}`;
}

export function learnedRow(
  view: PanelsView | null,
  now: number,
  locale?: string,
): LearnedRow | undefined {
  if (!view?.found) return undefined;
  const l = view.learning;
  const newest = l.items[0];
  if (l.unseen > 0 && newest) {
    return {
      kind: "fresh",
      title: newest.kind === "improved" ? "Skill improved" : "New skill learned",
      skill: newest.skill,
      when: agoPhrase(newest.lastChangeAt, now, locale),
      more: l.unseen - 1,
    };
  }
  let text: string | undefined;
  if (l.newThisWeek > 0) {
    text = `Hermes learned ${plural(l.newThisWeek, "skill")} this week`;
    if (l.improvedThisWeek > 0) text += ` and improved ${l.improvedThisWeek}`;
  } else if (l.improvedThisWeek > 0) {
    text = `Hermes improved ${plural(l.improvedThisWeek, "skill")} this week`;
  } else if (l.learnedTotal > 0) {
    text = `Hermes has learned ${plural(l.learnedTotal, "skill")} so far`;
  }
  if (!text) return undefined;
  const ran = view.curator.lastRunAt;
  return ran !== undefined
    ? { kind: "week", text, curator: `curator ran ${agoPhrase(ran, now, locale)}` }
    : { kind: "week", text };
}
