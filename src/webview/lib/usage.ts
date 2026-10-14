// How the model menu shows a provider's subscription limits. Pure, and
// imported by relative path (not $shared) so the main test suite can load it.

import type { ProviderUsage, UsageWindow } from "../../shared/protocol";
import { daysBetween, parseTime } from "../../shared/time";

export interface UsageView {
  /** The fullest window's share, rounded; absent when there are only texts. */
  percent?: number;
  /** 0–1, for the bar. */
  ratio: number;
  /** "24% used", or the provider's own text ("$3.20 left"). */
  text: string;
  tone: "muted" | "warning" | "error";
  /** The fullest window is used up: its models wait until `resets`. */
  full: boolean;
  /** When the fullest window resets: "14:10", "tomorrow 09:00", "Sun 11:00". */
  resets?: string;
  /** Every window, the plan and the details, one per line. */
  tooltip: string;
}

const clock = (d: Date, locale?: string) =>
  d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });

/** A reset time: the clock today, "tomorrow 09:00", a weekday within the
 *  week, a date after that. */
export function resetLabel(
  iso: string | undefined,
  now: number,
  locale?: string,
): string | undefined {
  const t = parseTime(iso);
  if (t === undefined) return undefined;
  const d = new Date(t);
  const days = daysBetween(now, t);
  if (days <= 0) return clock(d, locale);
  if (days === 1) return `tomorrow ${clock(d, locale)}`;
  if (days < 7) return `${d.toLocaleDateString(locale, { weekday: "short" })} ${clock(d, locale)}`;
  return d.toLocaleDateString(locale, { month: "short", day: "numeric" });
}

function windowLine(w: UsageWindow, now: number, locale?: string): string {
  const resets = resetLabel(w.resetsAt, now, locale);
  const what =
    w.usedPercent !== undefined ? `${Math.round(w.usedPercent)}% used` : (w.detail ?? "");
  return `${w.label}: ${what}${resets ? `, resets ${resets}` : ""}`;
}

export function usageView(
  u: ProviderUsage | null | undefined,
  now: number,
  locale?: string,
): UsageView | undefined {
  if (!u) return undefined;
  const measured = u.windows.filter((w) => w.usedPercent !== undefined);
  // The fullest window decides: a free session inside a used-up week is still stuck.
  const top = measured.reduce<UsageWindow | undefined>(
    (a, w) => (a && (a.usedPercent ?? 0) >= (w.usedPercent ?? 0) ? a : w),
    undefined,
  );
  const lines = [
    ...u.windows.map((w) => windowLine(w, now, locale)),
    ...(u.plan ? [`Plan: ${u.plan}`] : []),
    ...u.details,
  ];
  const fetched = parseTime(u.fetchedAt);
  if (fetched !== undefined) lines.push(`Checked at ${clock(new Date(fetched), locale)}`);
  const tooltip = lines.join("\n");

  if (!top || top.usedPercent === undefined) {
    const text = u.windows.find((w) => w.detail)?.detail ?? u.details[0];
    return text ? { ratio: 0, text, tone: "muted", full: false, tooltip } : undefined;
  }
  const percent = Math.round(top.usedPercent);
  const resets = resetLabel(top.resetsAt, now, locale);
  return {
    percent,
    ratio: top.usedPercent / 100,
    text: `${percent}% used`,
    tone: percent >= 90 ? "error" : percent >= 70 ? "warning" : "muted",
    full: percent >= 100,
    ...(resets ? { resets } : {}),
    tooltip,
  };
}

export interface LowUsage {
  /** "17% left", or "until 14:10" once the limit is hit. */
  text: string;
  /** For a narrow composer: "17%". */
  short: string;
  tone: "warning" | "error";
}

/** What the model chip adds when the current provider runs low: from 20%
 *  left (amber), 10% left (red), and at the limit until when it resets.
 *  `limitHit`: the chat's last reply was Hermes's usage-limit message (the
 *  banner is up), even if the last reading is older. Nothing while there is
 *  room, or without a percentage. */
export function lowUsage(v: UsageView | undefined, limitHit = false): LowUsage | undefined {
  if (limitHit || v?.full) {
    const text = v?.resets ? `until ${v.resets}` : "limit reached";
    return { text, short: text, tone: "error" };
  }
  if (v?.percent === undefined) return undefined;
  const left = 100 - v.percent;
  if (left > 20) return undefined;
  return { text: `${left}% left`, short: `${left}%`, tone: left <= 10 ? "error" : "warning" };
}

/** The provider slug of a model id, as the host keys the usage. */
export function slugOf(modelId: string | undefined): string {
  return (modelId ?? "").split(":")[0] ?? "";
}
