// The Hermes panels as tabs in the chat view (plan-panel-tabs.md). Pure: the
// snapshot of Hermes's files in, the webview's PanelsView out, plus the click
// targets behind its keys. The same data as the tree views (panelTrees.ts),
// shaped for cards instead of rows.

import type {
  AgentRun,
  CuratorCard,
  LearningRow,
  MemoryFile,
  PanelsView,
  PendingRow,
} from "../shared/panels";
import {
  type CuratorView,
  curatorSummaryShort,
  type Delegation,
  type LearnedSkill,
  type LedgerEvent,
  type McpServer,
  type MemoryEntry,
  type MemoryLimits,
  type PendingMemory,
  previewPending,
  type SkillInfo,
} from "./hermesData";
import type { PanelTarget } from "./panelTrees";

/** What the builder reads: HermesSnapshot (host/hermesHome.ts) fits it. */
export interface PanelsInput {
  home: string;
  found: boolean;
  learning: readonly LearnedSkill[];
  totalChanges: number;
  firstChangeAt?: number;
  curator: CuratorView;
  memory: {
    notes: readonly MemoryEntry[];
    profile: readonly MemoryEntry[];
    notesChars: number;
    profileChars: number;
    limits: MemoryLimits;
    pending: readonly PendingMemory[];
    notesPath: string;
    profilePath: string;
  };
  skills: readonly SkillInfo[];
  mcp: readonly McpServer[];
  plugins: { enabled: string[]; disabled: string[]; user: string[] };
  delegations: readonly Delegation[];
}

export interface PanelsContext {
  now: number;
  /** When the user last looked at Learning (the badge counts what came after). */
  seenAt: number;
  /** A session of THIS folder, by id (only those can be opened safely). */
  sessionTitle(id: string): string | undefined;
  /** A change's line counts, by ledger event id, once the host has them. */
  lineCounts?(eventId: string): { added: number; removed: number } | undefined;
}

const DAY = 86_400_000;
/** A skill Hermes created within this many days counts as "new". */
const NEW_DAYS = 7;
/** Rows in Recent changes (as the tree). */
const SHOWN = 15;

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

/** The key a click sends back: derived from what it opens, so a key from an
 *  older view can never open something else. */
export function panelKey(t: PanelTarget): string {
  switch (t.kind) {
    case "file":
      return `file:${t.line ?? 0}:${t.path}`;
    case "change":
      return `change:${t.eventId}`;
    case "allChanges":
      return "allChanges";
    case "history":
      return `history:${t.skill}`;
    case "session":
      return `session:${t.id}`;
    case "pending":
      return `pending:${t.id}`;
  }
}

/** The latest change of a skill that Hermes kept a copy of (for a diff). */
export function latestChange(l: LearnedSkill): LedgerEvent | undefined {
  return [...l.events].reverse().find((e) => e.beforeSha || e.afterSha);
}

function every(hours: number): string {
  if (hours === 168) return "weekly";
  if (hours === 24) return "daily";
  if (hours % 24 === 0) return `every ${hours / 24} days`;
  return `every ${hours} h`;
}

export function buildPanelsView(
  s: PanelsInput,
  c: PanelsContext,
): { view: PanelsView; targets: Map<string, PanelTarget> } {
  const targets = new Map<string, PanelTarget>();
  const key = (t: PanelTarget): string => {
    const k = panelKey(t);
    targets.set(k, t);
    return k;
  };
  const file = (path: string, line?: number) =>
    key({ kind: "file", path, ...(line ? { line } : {}) });

  // ─── Learning ─────────────────────────────────────────────────────────────
  const weekAgo = c.now - NEW_DAYS * DAY;
  const fresh = (l: LearnedSkill) => l.isNew && l.createdAt !== undefined && l.createdAt >= weekAgo;
  const descriptions = new Map(s.skills.map((x) => [x.name, x.description]));
  const items: LearningRow[] = s.learning.slice(0, SHOWN).map((l) => {
    const change = latestChange(l);
    const lines = change ? c.lineCounts?.(change.id) : undefined;
    const title = l.lastSessionId ? c.sessionTitle(l.lastSessionId) : undefined;
    const description = descriptions.get(l.skill);
    return {
      skill: l.skill,
      kind: fresh(l) ? "new" : l.isNew ? "learned" : "improved",
      ...(description ? { description: clip(description, 300) } : {}),
      lastChangeAt: l.lastChangeAt,
      changes: l.changes,
      ...(l.path ? { open: file(l.path) } : {}),
      ...(change
        ? {
            diff: {
              key: key({ kind: "change", skill: l.skill, eventId: change.id }),
              ...(lines ? { added: lines.added, removed: lines.removed } : {}),
            },
          }
        : {}),
      history: key({ kind: "history", skill: l.skill }),
      ...(title && l.lastSessionId
        ? { session: { key: key({ kind: "session", id: l.lastSessionId }), title } }
        : {}),
    };
  });

  // ─── Curator ──────────────────────────────────────────────────────────────
  const cur = s.curator;
  const summary = curatorSummaryShort(cur.summary);
  const curator: CuratorCard = {
    state: !cur.enabled ? "off" : cur.paused ? "paused" : "on",
    every: every(cur.intervalHours),
    ...(cur.lastRunAt !== undefined ? { lastRunAt: cur.lastRunAt } : {}),
    ...(summary ? { summary } : {}),
    ...(cur.enabled && !cur.paused && cur.nextRunAt !== undefined
      ? { nextRunAt: cur.nextRunAt }
      : {}),
    minIdleHours: cur.minIdleHours,
    // Forward slash works on Windows too.
    ...(cur.reportDir && cur.lastRunAt !== undefined
      ? { report: file(`${cur.reportDir.replace(/[\\/]+$/, "")}/REPORT.md`) }
      : {}),
    consolidate: cur.consolidate,
  };

  // ─── Memory ───────────────────────────────────────────────────────────────
  const m = s.memory;
  const memFile = (
    entries: readonly MemoryEntry[],
    chars: number,
    limit: number,
    path: string,
  ): MemoryFile => ({
    entries: entries.map((e) => ({ text: clip(e.text, 1200), key: file(path, e.line + 1) })),
    chars,
    limit,
    open: file(path),
  });
  // One-op rewrites/removals pinned to the same entry are versions of one
  // change: approving one leaves the others pointing at an entry that is gone.
  const pinOf = (p: PendingMemory) => {
    const op = p.ops.length === 1 ? p.ops[0] : undefined;
    return op && (op.action === "replace" || op.action === "remove") && op.matchedEntry
      ? `${p.target}\n${op.matchedEntry}`
      : undefined;
  };
  const byPin = new Map<string, string[]>();
  for (const p of m.pending) {
    const pin = pinOf(p);
    if (pin) byPin.set(pin, [...(byPin.get(pin) ?? []), p.id]);
  }
  const pending: PendingRow[] = m.pending.map((p) => {
    const first = p.ops[0];
    const action =
      first?.action === "add" || first?.action === "replace" || first?.action === "remove"
        ? first.action
        : "other";
    const text =
      (action === "remove" ? first?.oldText : first?.content) ?? first?.oldText ?? p.summary;
    const pin = pinOf(p);
    const group = pin ? byPin.get(pin) : undefined;
    // Hermes applies a pinned change only to the entry as it was reviewed: if
    // that entry changed since (Hermes rewrote it, or you edited the file),
    // it refuses ("Entry changed since it was staged"). Say so before a click.
    // Line endings evened out: Python reads the file with LF, as splitMemory does.
    const lf = (s: string) => s.replace(/\r\n/g, "\n").trim();
    const current = (p.target === "user" ? m.profile : m.notes).map((e) => lf(e.text));
    const ops = p.ops.map((op) =>
      op.matchedEntry ? { ...op, matchedEntry: lf(op.matchedEntry) } : op,
    );
    const changed = !p.stale && previewPending(current, ops).problems.length > 0;
    return {
      id: p.id,
      action,
      target: p.target,
      text: clip(text.trim(), 600),
      more: Math.max(0, p.ops.length - 1),
      ...(p.createdAt !== undefined ? { createdAt: p.createdAt } : {}),
      stale: p.stale || changed,
      ...(changed ? { changed: true } : {}),
      key: key({ kind: "pending", id: p.id }),
      ...(first?.matchedEntry && action !== "add"
        ? { replaces: clip(first.matchedEntry, 600) }
        : {}),
      ...(group && group.length > 1 ? { group: `pin:${[...group].sort()[0]}` } : {}),
    };
  });

  // ─── Agents ───────────────────────────────────────────────────────────────
  const run = (d: Delegation): AgentRun => ({
    id: d.id,
    goal: clip(d.tasks[0]?.goal || d.id, 200),
    ...(d.startedAt !== undefined ? { startedAt: d.startedAt } : {}),
    ...(d.completedAt !== undefined ? { completedAt: d.completedAt } : {}),
    failed: d.tasks.some((t) => t.status === "failed"),
    tasks: d.tasks.map((t, n) => ({
      goal: clip(t.goal || `Task ${n + 1}`, 300),
      ...(t.status ? { status: t.status } : {}),
      ...(t.log ? { key: file(t.log) } : {}),
    })),
  });

  const view: PanelsView = {
    found: s.found,
    home: s.home,
    learning: {
      newThisWeek: s.learning.filter(fresh).length,
      improvedThisWeek: s.learning.filter(
        (l) => !fresh(l) && l.events.some((e) => e.ts >= weekAgo && e.action !== "create"),
      ).length,
      learnedTotal: s.skills.filter((x) => x.source === "learned").length,
      skillsTotal: s.skills.length,
      unseen: s.learning.filter((l) => l.lastChangeAt > c.seenAt).length,
      items,
      totalChanges: s.totalChanges,
      ...(s.firstChangeAt !== undefined ? { firstChangeAt: s.firstChangeAt } : {}),
      ...(s.totalChanges > 0 ? { allChanges: key({ kind: "allChanges" }) } : {}),
    },
    curator,
    memory: {
      notes: memFile(m.notes, m.notesChars, m.limits.notes, m.notesPath),
      profile: memFile(m.profile, m.profileChars, m.limits.profile, m.profilePath),
      pending,
    },
    capabilities: {
      skills: s.skills.map((x) => ({
        name: x.name,
        ...(x.category ? { category: x.category } : {}),
        ...(x.description ? { description: clip(x.description, 300) } : {}),
        source: x.source,
        key: file(x.path),
      })),
      mcp: s.mcp.map((x) => ({ name: x.name, transport: x.transport, enabled: x.enabled })),
      plugins: [...new Set([...s.plugins.user, ...s.plugins.enabled])].map((name) => ({
        name,
        enabled: !s.plugins.disabled.includes(name),
      })),
    },
    agents: {
      running: s.delegations.filter((d) => d.completedAt === undefined).map(run),
      recent: s.delegations
        .filter((d) => d.completedAt !== undefined && c.now - (d.startedAt ?? 0) < 7 * DAY)
        .map(run),
    },
  };
  return { view, targets };
}
