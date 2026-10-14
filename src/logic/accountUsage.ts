// Subscription limits from `hermes usage --provider <slug> --json`. Pure.
//
// Hermes 0.21.5 prints one AccountUsageSnapshot (agent/account_usage.py):
//   { provider, source, title, plan, fetched_at,
//     windows: [{ label, used_percent, resets_at, detail }],
//     details: [str], unavailable_reason }
// Anthropic OAuth gives "Current session" (5 h) and "Current week"; Codex
// "Session" and "Weekly", its plan and banked resets. A provider without
// usage exits 1 with a sentence on stderr and nothing on stdout.
//
// The command reads the same credential store as the running agent, under
// Hermes's cross-process auth lock, and spends no tokens.

import type { ProviderUsage, UsageWindow } from "../shared/protocol";

/** Hermes's provider slugs: "anthropic", "openai-codex", "custom". A slug is
 *  an argument to a command, so nothing that could read as a flag. */
const SLUG = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/** The provider slug of a model id ("anthropic:claude-opus-5-5" → "anthropic"). */
export function providerSlug(modelId: string): string | undefined {
  const slug = modelId.split(":")[0] ?? "";
  return SLUG.test(slug) ? slug : undefined;
}

/** Each provider of these models once, in order. */
export function providerSlugs(models: readonly { id: string }[]): string[] {
  const out = new Set<string>();
  for (const m of models) {
    const s = providerSlug(m.id);
    if (s) out.add(s);
  }
  return [...out];
}

/**
 * Hermes bug #58226 (open 2026-09): the Anthropic OAuth usage API reports
 * `utilization` in percent points, but Hermes treats a value ≤ 1 as a 0–1
 * fraction and multiplies it by 100 — so 1% used shows as 100%. True when
 * this Hermes source (agent/account_usage.py) still does that: its Anthropic
 * fetch has the older inline `* 100 if … <= 1`, or passes `fraction=True` to
 * a `_usage_windows` that still scales `used <= 1`. A fix in either place
 * turns the correction off. False for unknown code: correct nothing.
 */
export function hasAnthropicPercentBug(source: string): boolean {
  const anthropic = pythonFunction(source, "_fetch_anthropic_account_usage");
  if (!anthropic) return false;
  if (/\*\s*100\s+if\b[^\n]*<=\s*1\b/.test(anthropic)) return true;
  if (!/fraction\s*=\s*True/.test(anthropic)) return false;
  const helper = pythonFunction(source, "_usage_windows");
  return helper !== undefined && /if\s+fraction\s+and\s+used\s*<=\s*1\b/.test(helper);
}

/** A top-level `def name(` up to the next top-level `def`. */
function pythonFunction(source: string, name: string): string | undefined {
  const start = source.search(new RegExp(`^def ${name}\\(`, "m"));
  if (start < 0) return undefined;
  const next = source.indexOf("\ndef ", start + 1);
  return source.slice(start, next < 0 ? undefined : next);
}

export const ANTHROPIC_BUG_NOTE =
  "Hermes shows 1% as 100% (Hermes bug #58226), so its “100%” is shown as 1% here.";

/**
 * Undo that bug where it is certain enough. The API gives whole percent
 * points (1.0, 24.0, 55.0 seen), so under the bug only 1 turns into 100 — and
 * a real 100 also reads 100. `trustFull`: the chat just hit this provider's
 * usage limit, so a 100 is real. Otherwise a 100 is read as 1: if it was a
 * real 100, the next message meets the limit and the banner says so.
 */
export function correctAnthropicUsage(u: ProviderUsage, trustFull: boolean): ProviderUsage {
  if (trustFull || !u.windows.some((w) => w.usedPercent === 100)) return u;
  return {
    ...u,
    windows: u.windows.map((w) => (w.usedPercent === 100 ? { ...w, usedPercent: 1 } : w)),
    details: [...u.details, ANTHROPIC_BUG_NOTE],
  };
}

/** The chat's last turn hit this provider's usage limit (the banner is up). */
export function limitHitFor(
  slug: string,
  meta: {
    limit?: { kind: string; provider?: string };
    models?: readonly { id: string; provider?: string }[];
    modelId?: string;
  },
): boolean {
  const limit = meta.limit;
  if (!limit || limit.kind !== "limit") return false;
  if (limit.provider) {
    return (meta.models ?? []).some(
      (m) => providerSlug(m.id) === slug && m.provider === limit.provider,
    );
  }
  return providerSlug(meta.modelId ?? "") === slug;
}

/** The model chip warns before a limit, so the current provider's usage is
 *  read again when a reply ends or the model changes (the service still
 *  waits a minute between reads). The provider to read, or undefined. */
export function usageCheckFor(
  before: { busy: boolean; modelId?: string } | undefined,
  after: { busy: boolean; modelId?: string },
): string | undefined {
  if (after.busy || !after.modelId) return undefined;
  const ended = before?.busy === true;
  const switched = before?.modelId !== after.modelId;
  return ended || switched ? providerSlug(after.modelId) : undefined;
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : undefined;

/** The snapshot, or undefined when there is nothing to show. */
export function parseAccountUsage(stdout: string): ProviderUsage | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof doc !== "object" || doc === null) return undefined;
  const d = doc as Record<string, unknown>;
  if (d.unavailable_reason) return undefined;

  const windows: UsageWindow[] = [];
  for (const w of Array.isArray(d.windows) ? d.windows : []) {
    if (typeof w !== "object" || w === null) continue;
    const r = w as Record<string, unknown>;
    const label = str(r.label, 60);
    if (!label) continue;
    const used = r.used_percent;
    const window: UsageWindow = { label };
    if (typeof used === "number" && Number.isFinite(used)) {
      window.usedPercent = Math.min(100, Math.max(0, used));
    }
    const resets = str(r.resets_at, 64) ?? str(r.reset_at, 64);
    if (resets && !Number.isNaN(Date.parse(resets))) window.resetsAt = resets;
    const detail = str(r.detail, 200);
    if (detail) window.detail = detail;
    if (window.usedPercent !== undefined || window.detail) windows.push(window);
  }
  const details = (Array.isArray(d.details) ? d.details : [])
    .map((x) => str(x, 200))
    .filter((x): x is string => x !== undefined)
    .slice(0, 5);
  if (windows.length === 0 && details.length === 0) return undefined;

  const usage: ProviderUsage = { windows, details };
  const plan = str(d.plan, 40);
  if (plan) usage.plan = plan;
  const fetched = str(d.fetched_at, 64);
  if (fetched) usage.fetchedAt = fetched;
  return usage;
}
