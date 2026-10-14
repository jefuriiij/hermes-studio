// Short human times, shared by the webview (Sessions) and the host (panels).
// Pure.

const DAY_MS = 86_400_000;

/** Epoch ms from Hermes's `updatedAt` (ISO 8601; epoch seconds/ms tolerated). */
export function parseTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const raw = value.trim();
  if (/^\d+(\.\d+)?$/.test(raw)) {
    const n = Number(raw);
    return n > 1e12 ? n : n * 1000;
  }
  const t = Date.parse(raw);
  return Number.isNaN(t) ? undefined : t;
}

function startOfDay(t: number): number {
  const d = new Date(t);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Whole calendar days between two instants, in local time (0 = same day). */
export function daysBetween(then: number, now: number): number {
  return Math.round((startOfDay(now) - startOfDay(then)) / DAY_MS);
}

/**
 * "Just now", "12 min ago", "09:14" (earlier today), "Yesterday", "Mon"
 * (this week), "Sep 3", "Sep 3, 2025". `locale` only matters for the clock
 * and month names; tests pin it.
 */
export function relativeTime(t: number | undefined, now: number, locale?: string): string {
  if (t === undefined) return "";
  const ago = now - t;
  if (ago < 60_000) return "Just now";
  if (ago < 3_600_000 && daysBetween(t, now) === 0) return `${Math.floor(ago / 60_000)} min ago`;
  const days = daysBetween(t, now);
  const d = new Date(t);
  if (days <= 0) return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (days === 1) return "Yesterday";
  if (days < 7) return d.toLocaleDateString(locale, { weekday: "short" });
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/**
 * The short form for a narrow list: "now", "12m", "3h", "4d", then "Sep 3"
 * ("Sep 3, 2025" in another year). Hours count only within the same day.
 */
export function shortAgo(t: number | undefined, now: number, locale?: string): string {
  if (t === undefined) return "";
  const ago = Math.max(0, now - t);
  if (ago < 60_000) return "now";
  const days = daysBetween(t, now);
  if (ago < 3_600_000) return `${Math.floor(ago / 60_000)}m`;
  if (days <= 0) return `${Math.floor(ago / 3_600_000)}h`;
  if (days < 7) return `${days}d`;
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** A future day, for "Next run from Sep 30". */
export function dayLabel(t: number, now: number, locale?: string): string {
  const days = daysBetween(now, t);
  if (days === 0) return "today";
  if (days === 1) return "tomorrow";
  const d = new Date(t);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** 45 → "45 s", 190 → "3 min", 7400 → "2 h 3 min". */
export function durationLabel(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** "took 42 s", "took 2 min 14 s", "took 1 h 5 min". */
export function tookText(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `took ${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `took ${m} min${s % 60 ? ` ${s % 60} s` : ""}`;
  const h = Math.floor(m / 60);
  return `took ${h} h${m % 60 ? ` ${m % 60} min` : ""}`;
}
